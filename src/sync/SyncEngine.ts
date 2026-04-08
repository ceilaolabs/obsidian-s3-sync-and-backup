/**
 * Sync Engine Module
 *
 * Orchestrates bi-directional vault synchronization using a shared remote
 * manifest and a per-device local journal.
 */

import { App, TFile } from 'obsidian';
import { hashContent } from '../crypto/Hasher';
import { S3Provider } from '../storage/S3Provider';
import {
    addPrefix,
    getOriginalFromConflict,
    isConflictFile,
    matchesAnyGlob,
    normalizePrefix,
    removePrefix,
} from '../utils/paths';
import {
    getVaultFileKind,
    readVaultFile,
    toArrayBuffer,
} from '../utils/vaultFiles';
import {
    RemoteSyncDeviceInfo,
    RemoteSyncFileEntry,
    RemoteSyncManifest,
    RemoteSyncTombstone,
    S3ObjectInfo,
    S3SyncBackupSettings,
    SyncAction,
    SyncError,
    SyncJournalEntry,
    SyncPlanItem,
    SyncResult,
    VaultFileKind,
} from '../types';
import { ChangeTracker } from './ChangeTracker';
import {
    LoadedRemoteSyncManifest,
    RemoteSyncManifestChangedError,
    RemoteSyncStore,
} from './RemoteSyncStore';
import { SyncJournal } from './SyncJournal';
import { sleep } from '../utils/retry';

/**
 * Combined local/remote/journal state for a single vault path.
 */
interface FileState {
    path: string;
    kind: VaultFileKind;
    localFile?: TFile;
    localExists: boolean;
    localHash?: string;
    localMtime?: number;
    localSize?: number;
    remoteObject?: S3ObjectInfo;
    remoteExists: boolean;
    manifestEntry?: RemoteSyncFileEntry;
    tombstone?: RemoteSyncTombstone;
    journalEntry?: SyncJournalEntry;
    hasConflictArtifacts: boolean;
}

/**
 * Sync plan item extended with planner state.
 */
interface ExtendedSyncPlanItem extends SyncPlanItem {
    state: FileState;
    expectedRemoteEtag?: string;
    expectRemoteAbsent?: boolean;
}

/**
 * Successful action outcome queued until manifest commit and journal updates.
 *
 * Outcomes carry the intended manifest mutations (manifestEntry / tombstone)
 * and enough context to perform content-hash-based rebase when a concurrent
 * manifest write is detected (412/409).  The old `verifyRemoteState` callback
 * was ETag-based and produced false conflicts when two devices uploaded
 * identical content.
 */
interface SyncExecutionOutcome {
    path: string;
    action: SyncAction;
    clearPendingPaths: string[];
    requiresManifestCommit: boolean;
    manifestEntry?: RemoteSyncFileEntry | null;
    tombstone?: RemoteSyncTombstone | null;
    applyJournal: () => Promise<void>;
    /** Best-effort cleanup to run after manifest commit succeeds (e.g. physical S3 object deletion). */
    postCommitCleanup?: () => Promise<void>;
}

/**
 * Result of rebasing pending outcomes against a fresh manifest.
 * Separates outcomes that still need committing from those that
 * converged with another device's writes and only need journal updates.
 */
interface RebaseResult {
    pending: SyncExecutionOutcome[];
    converged: SyncExecutionOutcome[];
}

/**
 * SyncEngine class - orchestrates sync operations.
 */
export class SyncEngine {
    private isSyncing = false;
    private debugLogging = false;
    private deviceId: string;
    private deviceCreatedAt: number;
    private normalizedSyncPrefix: string;
    private remoteStore: RemoteSyncStore;
    private remoteContentCache = new Map<string, string | Uint8Array>();
    private remoteHashCache = new Map<string, string>();

    constructor(
        private app: App,
        private s3Provider: S3Provider,
        private journal: SyncJournal,
        private changeTracker: ChangeTracker,
        private settings: S3SyncBackupSettings
    ) {
        this.debugLogging = settings.debugLogging;
        this.deviceId = this.getOrCreateStoredString('s3-sync-device-id', () => (
            `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
        ));
        this.deviceCreatedAt = Number(this.getOrCreateStoredString('s3-sync-device-created-at', () => String(Date.now())));
        this.normalizedSyncPrefix = normalizePrefix(settings.syncPrefix);
        this.remoteStore = new RemoteSyncStore(this.s3Provider, this.normalizedSyncPrefix);
    }

    /**
     * Update runtime settings.
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;
        this.debugLogging = settings.debugLogging;
        this.normalizedSyncPrefix = normalizePrefix(settings.syncPrefix);
        this.remoteStore.updateSyncPrefix(this.normalizedSyncPrefix);
    }

    /**
     * Check whether sync is currently running.
     */
    isInProgress(): boolean {
        return this.isSyncing;
    }

    /**
     * Run a full sync operation.
     */
    async sync(): Promise<SyncResult> {
        if (this.isSyncing) {
            throw new Error('Sync already in progress');
        }

        const result: SyncResult = {
            success: false,
            startedAt: Date.now(),
            completedAt: 0,
            filesUploaded: 0,
            filesDownloaded: 0,
            filesDeleted: 0,
            conflicts: [],
            errors: [],
        };

        this.isSyncing = true;
        this.changeTracker.setSyncInProgress(true);
        this.remoteContentCache.clear();
        this.remoteHashCache.clear();

        try {
            this.log('Starting sync');

            const loadedManifest = await this.remoteStore.loadManifest();
            const states = await this.buildFileStateMap(loadedManifest.manifest);
            const syncPlan = await this.generateSyncPlan(states);
            const outcomes: SyncExecutionOutcome[] = [];

            for (const item of syncPlan) {
                try {
                    this.changeTracker.markPathSyncing(item.path);
                    const outcome = await this.executeAction(item);
                    outcomes.push(outcome);

                    switch (outcome.action) {
                        case 'upload':
                            result.filesUploaded++;
                            break;
                        case 'download':
                            result.filesDownloaded++;
                            break;
                        case 'delete-local':
                        case 'delete-remote':
                            result.filesDeleted++;
                            break;
                        case 'adopt':
                        case 'conflict':
                        case 'skip':
                            break;
                    }
                } catch (error) {
                    result.errors.push(this.createSyncError(item.path, item.action, error, true));
                }
            }

            const { committedPaths, convergedOutcomes } = await this.commitManifestChanges(loadedManifest, outcomes, result.errors);

            for (const outcome of outcomes) {
                const canApply = !outcome.requiresManifestCommit || committedPaths.has(outcome.path);
                if (!canApply) {
                    continue;
                }

                await outcome.applyJournal();
                for (const path of outcome.clearPendingPaths) {
                    this.changeTracker.clearPendingChange(path);
                }

                if (outcome.postCommitCleanup) {
                    await outcome.postCommitCleanup();
                }
            }

            for (const converged of convergedOutcomes) {
                await converged.applyJournal();
                for (const path of converged.clearPendingPaths) {
                    this.changeTracker.clearPendingChange(path);
                }
            }

            result.conflicts = (await this.journal.getConflictedEntries()).map((entry) => entry.path);
            result.success = result.errors.length === 0;
            this.log(`Sync completed with ${result.errors.length} error(s)`);
        } catch (error) {
            result.errors.push(this.createSyncError('', 'skip', error, false));
        } finally {
            this.isSyncing = false;
            this.changeTracker.setSyncInProgress(false);
            this.remoteContentCache.clear();
            this.remoteHashCache.clear();
            result.completedAt = Date.now();
        }

        return result;
    }

    /**
     * Build the planner state map from local files, remote files, manifest, and journal.
     * Pre-locks all local file paths via markPathSyncing so vault events during
     * the async iteration are deferred rather than racing with the state build.
     */
    private async buildFileStateMap(manifest: RemoteSyncManifest): Promise<Map<string, FileState>> {
        const states = new Map<string, FileState>();
        const conflictOriginalPaths = new Set<string>();

        const localFiles = this.app.vault.getFiles().filter(
            (file) => !isConflictFile(file.path) && !this.shouldExclude(file.path)
        );

        for (const file of localFiles) {
            this.changeTracker.markPathSyncing(file.path);
        }

        for (const file of this.app.vault.getFiles()) {
            if (isConflictFile(file.path)) {
                const originalPath = getOriginalFromConflict(file.path);
                if (originalPath) {
                    conflictOriginalPaths.add(originalPath);
                }
                continue;
            }

            if (this.shouldExclude(file.path)) {
                continue;
            }

            const content = await this.readLocalFileContent(file);
            states.set(file.path, {
                path: file.path,
                kind: getVaultFileKind(file.path),
                localFile: file,
                localExists: true,
                localHash: await hashContent(content),
                localMtime: file.stat.mtime,
                localSize: file.stat.size,
                remoteExists: false,
                hasConflictArtifacts: false,
            });
        }

        for (const objectInfo of await this.s3Provider.listObjects(this.getRemoteListPrefix())) {
            if (this.remoteStore.isMetadataKey(objectInfo.key)) {
                continue;
            }

            const relativePath = this.s3KeyToLocalPath(objectInfo.key);
            if (!relativePath || this.shouldExclude(relativePath)) {
                continue;
            }

            const state = this.getOrCreateState(states, relativePath);
            state.remoteExists = true;
            state.remoteObject = {
                ...objectInfo,
                etag: objectInfo.etag?.replace(/"/g, ''),
            };
        }

        for (const [path, entry] of Object.entries(manifest.files)) {
            if (!this.shouldExclude(path)) {
                this.getOrCreateState(states, path).manifestEntry = entry;
            }
        }

        for (const [path, tombstone] of Object.entries(manifest.tombstones)) {
            if (!this.shouldExclude(path)) {
                this.getOrCreateState(states, path).tombstone = tombstone;
            }
        }

        for (const entry of await this.journal.getAllEntries()) {
            if (!this.shouldExclude(entry.path)) {
                this.getOrCreateState(states, entry.path).journalEntry = entry;
            }
        }

        for (const path of conflictOriginalPaths) {
            this.getOrCreateState(states, path).hasConflictArtifacts = true;
        }

        return states;
    }

    /**
     * Generate a sync plan from the planner state map.
     */
    private async generateSyncPlan(states: Map<string, FileState>): Promise<ExtendedSyncPlanItem[]> {
        const plan: ExtendedSyncPlanItem[] = [];

        for (const state of states.values()) {
            const action = await this.determineAction(state);
            if (action === 'skip') {
                continue;
            }

            plan.push({
                path: state.path,
                action,
                reason: this.getActionReason(state, action),
                localHash: state.localHash,
                remoteHash: state.manifestEntry?.contentHash,
                remoteEtag: state.remoteObject?.etag ?? state.manifestEntry?.etag,
                expectedRemoteEtag: state.remoteObject?.etag,
                expectRemoteAbsent: !state.remoteExists,
                state,
            });
        }

        plan.sort((left, right) => left.path.localeCompare(right.path));
        return plan;
    }

    /**
     * Determine the correct sync action for a path.
     */
    private async determineAction(state: FileState): Promise<SyncAction> {
        const journal = state.journalEntry;
        const hasBaseline = journal !== undefined && journal.syncedAt > 0;
        const localChanged = this.hasLocalChanges(state);
        const localDeleted = !state.localExists && journal !== undefined && (journal.status === 'deleted' || hasBaseline);

        if (journal?.status === 'conflict') {
            if (state.hasConflictArtifacts || !state.localExists) {
                return 'skip';
            }

            return 'upload';
        }

        if (state.tombstone) {
            if (state.localExists) {
                const localUpdatedAfterDelete = (state.localMtime ?? 0) > state.tombstone.deletedAt;
                return localUpdatedAfterDelete || localChanged ? 'upload' : 'delete-local';
            }

            return state.remoteExists ? 'delete-remote' : 'skip';
        }

        if (state.manifestEntry) {
            if (!state.remoteExists) {
                return state.localExists ? 'upload' : 'delete-remote';
            }

            const sameAsManifest = state.localExists && state.localHash === state.manifestEntry.contentHash;
            const remoteChanged = !hasBaseline || journal?.remoteHash !== state.manifestEntry.contentHash;

            if (state.localExists) {
                if (!hasBaseline) {
                    return sameAsManifest ? 'adopt' : 'conflict';
                }

                if (!localChanged && !remoteChanged) {
                    return journal?.status === 'synced' ? 'skip' : 'adopt';
                }

                if (localChanged && remoteChanged) {
                    return sameAsManifest ? 'adopt' : 'conflict';
                }

                if (localChanged) {
                    return 'upload';
                }

                return sameAsManifest ? 'adopt' : 'download';
            }

            if (!hasBaseline) {
                return 'download';
            }

            return localDeleted && !remoteChanged ? 'delete-remote' : 'download';
        }

        if (state.remoteExists) {
            const remoteHash = await this.getRemoteHash(state.path);

            if (!state.localExists) {
                if (journal?.status === 'deleted' && journal.remoteHash === remoteHash) {
                    return 'delete-remote';
                }

                return 'download';
            }

            return state.localHash === remoteHash ? 'adopt' : 'conflict';
        }

        if (state.localExists) {
            return 'upload';
        }

        return 'skip';
    }

    /**
     * Get a user-facing action reason.
     */
    private getActionReason(state: FileState, action: SyncAction): string {
        switch (action) {
            case 'adopt':
                return state.manifestEntry ? 'Adopt existing shared state' : 'Create shared metadata baseline';
            case 'upload':
                return state.tombstone ? 'Local file recreated after remote delete' : state.manifestEntry ? 'Local file modified' : 'New local file';
            case 'download':
                return state.manifestEntry ? 'Remote file modified' : 'New remote file';
            case 'delete-local':
                return 'Deleted remotely';
            case 'delete-remote':
                return 'Deleted locally';
            case 'conflict':
                return 'Local and remote contents diverged without a safe baseline';
            case 'skip':
                return 'No changes';
        }
    }

    /**
     * Execute a planned action.
     */
    private async executeAction(item: ExtendedSyncPlanItem): Promise<SyncExecutionOutcome> {
        this.log(`Executing ${item.action} for ${item.path}: ${item.reason}`);

        switch (item.action) {
            case 'adopt':
                return await this.adoptPath(item);
            case 'upload':
                return await this.uploadPath(item);
            case 'download':
                return await this.downloadPath(item);
            case 'delete-local':
                return await this.deleteLocalPath(item);
            case 'delete-remote':
                return await this.deleteRemotePath(item);
            case 'conflict':
                return await this.handleConflict(item);
            case 'skip':
                return {
                    path: item.path,
                    action: 'skip',
                    clearPendingPaths: [],
                    requiresManifestCommit: false,
                    applyJournal: async () => undefined,
                };
        }
    }

    /**
     * Adopt matching local/remote content without transferring bytes.
     */
    private async adoptPath(item: ExtendedSyncPlanItem): Promise<SyncExecutionOutcome> {
        const state = item.state;
        const remoteHash = state.manifestEntry?.contentHash ?? await this.getRemoteHash(item.path);
        const remoteEtag = state.remoteObject?.etag ?? state.manifestEntry?.etag;
        const remoteUpdatedAt = state.manifestEntry?.updatedAt ?? state.remoteObject?.lastModified.getTime() ?? Date.now();
        const remoteSize = state.manifestEntry?.size ?? state.remoteObject?.size ?? state.localSize ?? 0;
        const remoteLastModifiedBy = state.manifestEntry?.lastModifiedBy ?? 'unknown';
        const localMtime = state.localFile?.stat.mtime ?? state.localMtime ?? Date.now();
        const requiresManifestCommit = state.manifestEntry === undefined || state.tombstone !== undefined;
        const manifestEntry: RemoteSyncFileEntry | undefined = requiresManifestCommit
            ? {
                path: item.path,
                contentHash: remoteHash,
                size: remoteSize,
                kind: state.kind,
                updatedAt: remoteUpdatedAt,
                lastModifiedBy: remoteLastModifiedBy,
                etag: remoteEtag,
            }
            : undefined;

        return {
            path: item.path,
            action: 'adopt',
            clearPendingPaths: [item.path],
            requiresManifestCommit,
            manifestEntry,
            tombstone: requiresManifestCommit ? null : undefined,
            applyJournal: async () => {
                await this.journal.markSynced(
                    item.path,
                    state.localHash ?? remoteHash,
                    remoteHash,
                    localMtime,
                    remoteUpdatedAt,
                    remoteEtag,
                    remoteLastModifiedBy === 'unknown' ? undefined : remoteLastModifiedBy
                );
            },
        };
    }

    /**
     * Upload a local file.
     * Always hashes freshly-read content to avoid stale hash from planning phase.
     */
    private async uploadPath(item: ExtendedSyncPlanItem): Promise<SyncExecutionOutcome> {
        const file = item.state.localFile;
        if (!(file instanceof TFile)) {
            throw new Error(`File not found: ${item.path}`);
        }

        const content = await this.readLocalFileContent(file);
        const contentHash = await hashContent(content);
        const uploadedAt = Date.now();

        let etag: string;
        try {
            etag = await this.s3Provider.uploadFile(this.localPathToS3Key(item.path), content, {
                ifMatch: item.expectRemoteAbsent ? undefined : item.expectedRemoteEtag,
                ifNoneMatch: item.expectRemoteAbsent ? '*' : undefined,
            });
        } catch (error) {
            throw this.maybeConvertConditionalWriteError(item.path, error);
        }

        return {
            path: item.path,
            action: 'upload',
            clearPendingPaths: [item.path],
            requiresManifestCommit: true,
            manifestEntry: {
                path: item.path,
                contentHash,
                size: file.stat.size,
                kind: item.state.kind,
                updatedAt: uploadedAt,
                lastModifiedBy: this.deviceId,
                etag,
            },
            tombstone: null,
            applyJournal: async () => {
                await this.journal.markSynced(
                    item.path,
                    contentHash,
                    contentHash,
                    file.stat.mtime,
                    uploadedAt,
                    etag,
                    this.deviceId
                );
            },
        };
    }

    /**
     * Download a remote file.
     * Yields to the event loop after writing so Obsidian can flush stat metadata.
     */
    private async downloadPath(item: ExtendedSyncPlanItem): Promise<SyncExecutionOutcome> {
        const state = item.state;
        const content = await this.downloadRemoteFileContent(item.path);
        await this.writeLocalFile(item.path, content);

        // Yield to let Obsidian flush mtime after the write
        await sleep(0);

        const remoteHash = state.manifestEntry?.contentHash ?? await this.getRemoteHash(item.path);
        const remoteEtag = state.remoteObject?.etag ?? state.manifestEntry?.etag;
        const remoteUpdatedAt = state.manifestEntry?.updatedAt ?? state.remoteObject?.lastModified.getTime() ?? Date.now();
        const remoteLastModifiedBy = state.manifestEntry?.lastModifiedBy ?? 'unknown';
        const downloadedFile = this.app.vault.getAbstractFileByPath(item.path);
        if (!(downloadedFile instanceof TFile)) {
            throw new Error(`Downloaded file not found: ${item.path}`);
        }

        const requiresManifestCommit = state.manifestEntry === undefined || state.tombstone !== undefined;
        const manifestEntry: RemoteSyncFileEntry | undefined = requiresManifestCommit
            ? {
                path: item.path,
                contentHash: remoteHash,
                size: state.remoteObject?.size ?? downloadedFile.stat.size,
                kind: state.kind,
                updatedAt: remoteUpdatedAt,
                lastModifiedBy: remoteLastModifiedBy,
                etag: remoteEtag,
            }
            : undefined;

        return {
            path: item.path,
            action: 'download',
            clearPendingPaths: [item.path],
            requiresManifestCommit,
            manifestEntry,
            tombstone: requiresManifestCommit ? null : undefined,
            applyJournal: async () => {
                await this.journal.markSynced(
                    item.path,
                    remoteHash,
                    remoteHash,
                    downloadedFile.stat.mtime,
                    remoteUpdatedAt,
                    remoteEtag,
                    remoteLastModifiedBy === 'unknown' ? undefined : remoteLastModifiedBy
                );
            },
        };
    }

    /**
     * Delete a local file.
     */
    private async deleteLocalPath(item: ExtendedSyncPlanItem): Promise<SyncExecutionOutcome> {
        const localFile = item.state.localFile ?? this.app.vault.getAbstractFileByPath(item.path);
        if (localFile instanceof TFile) {
            await this.app.fileManager.trashFile(localFile);
        }

        return {
            path: item.path,
            action: 'delete-local',
            clearPendingPaths: [item.path],
            requiresManifestCommit: false,
            applyJournal: async () => {
                await this.journal.deleteEntry(item.path);
            },
        };
    }

    /**
     * Delete a remote file by tombstoning it in the manifest.
     *
     * Physical S3 object deletion is deferred to postCommitCleanup so the
     * tombstone is committed first, preventing delete/write races where
     * another device could re-upload before the manifest records the delete.
     */
    private async deleteRemotePath(item: ExtendedSyncPlanItem): Promise<SyncExecutionOutcome> {
        const key = this.localPathToS3Key(item.path);

        return {
            path: item.path,
            action: 'delete-remote',
            clearPendingPaths: [item.path],
            requiresManifestCommit: true,
            manifestEntry: null,
            tombstone: {
                path: item.path,
                deletedAt: Date.now(),
                deletedBy: this.deviceId,
                previousHash: item.state.manifestEntry?.contentHash || item.state.journalEntry?.remoteHash || undefined,
            },
            applyJournal: async () => {
                await this.journal.deleteEntry(item.path);
            },
            postCommitCleanup: async () => {
                try {
                    if (item.state.remoteExists) {
                        await this.s3Provider.deleteFile(key);
                    }
                } catch (error) {
                    this.log(`Best-effort S3 object deletion failed for ${item.path}: ${String(error)}`);
                }
            },
        };
    }

    /**
     * Create LOCAL_ and REMOTE_ files for a conflict.
     */
    private async handleConflict(item: ExtendedSyncPlanItem): Promise<SyncExecutionOutcome> {
        const file = item.state.localFile;
        if (!(file instanceof TFile)) {
            throw new Error(`Local file missing for conflict: ${item.path}`);
        }

        const localContent = await this.readLocalFileContent(file);
        const remoteContent = await this.downloadRemoteFileContent(item.path);
        const fileName = item.path.substring(item.path.lastIndexOf('/') + 1);
        const dir = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';
        const localPath = dir ? `${dir}/LOCAL_${fileName}` : `LOCAL_${fileName}`;
        const remotePath = dir ? `${dir}/REMOTE_${fileName}` : `REMOTE_${fileName}`;

        await this.app.vault.rename(file, localPath);
        await this.writeLocalFile(remotePath, remoteContent);

        return {
            path: item.path,
            action: 'conflict',
            clearPendingPaths: [item.path],
            requiresManifestCommit: false,
            applyJournal: async () => {
                await this.journal.markConflict(
                    item.path,
                    item.state.localHash ?? await hashContent(localContent),
                    item.state.manifestEntry?.contentHash ?? await this.getRemoteHash(item.path),
                    item.state.remoteObject?.etag ?? item.state.manifestEntry?.etag
                );
            },
        };
    }

    /**
     * Commit manifest changes after all successful actions complete.
     * Returns both the set of committed paths AND any outcomes that
     * converged with another device during rebase (these need journal
     * updates even though they weren't re-committed).
     */
    private async commitManifestChanges(
        loadedManifest: LoadedRemoteSyncManifest,
        outcomes: SyncExecutionOutcome[],
        errors: SyncError[]
    ): Promise<{ committedPaths: Set<string>; convergedOutcomes: SyncExecutionOutcome[] }> {
        const committedPaths = new Set<string>();
        const allConverged: SyncExecutionOutcome[] = [];
        let currentManifest = loadedManifest;
        let applicableOutcomes = outcomes.filter((outcome) => outcome.requiresManifestCommit);
        const maxCommitAttempts = 10;
        const syncStartTime = Date.now();
        const maxSyncAgeMs = 30_000;

        if (applicableOutcomes.length === 0 && loadedManifest.existed) {
            await this.touchRemoteDevice(loadedManifest.manifest.generation);
            return { committedPaths, convergedOutcomes: allConverged };
        }

        for (let attempt = 0; attempt < maxCommitAttempts; attempt++) {
            try {
                if (attempt > 0) {
                    const rebaseResult = this.rebasePendingOutcomes(
                        applicableOutcomes, currentManifest.manifest
                    );
                    applicableOutcomes = rebaseResult.pending;
                    allConverged.push(...rebaseResult.converged);

                    if (applicableOutcomes.length === 0 && currentManifest.existed) {
                        await this.touchRemoteDevice(currentManifest.manifest.generation);
                        return { committedPaths, convergedOutcomes: allConverged };
                    }
                }

                const nextManifest = this.buildNextManifest(currentManifest.manifest, applicableOutcomes);
                const savedEtag = await this.remoteStore.saveManifest(nextManifest, currentManifest.etag);
                for (const outcome of applicableOutcomes) {
                    committedPaths.add(outcome.path);
                }
                await this.touchRemoteDevice(nextManifest.generation);

                currentManifest = {
                    manifest: nextManifest,
                    etag: savedEtag,
                    existed: true,
                };
                return { committedPaths, convergedOutcomes: allConverged };
            } catch (error) {
                if (error instanceof RemoteSyncManifestChangedError && attempt < maxCommitAttempts - 1) {
                    currentManifest = await this.remoteStore.loadManifest();

                    if (Date.now() - syncStartTime > maxSyncAgeMs) {
                        this.log('Manifest commit exceeded 30s; aborting redrive — next sync will re-plan');
                        errors.push(this.createSyncError('', 'skip', error, true));
                        return { committedPaths, convergedOutcomes: allConverged };
                    }

                    const baseDelayMs = Math.min(100 * Math.pow(2, attempt), 2000);
                    const jitteredDelayMs = Math.round(baseDelayMs * Math.random());
                    this.log(`Manifest changed during commit (attempt ${attempt + 1}/${maxCommitAttempts}); retrying in ${jitteredDelayMs}ms`);
                    await sleep(jitteredDelayMs);
                    continue;
                }

                errors.push(this.createSyncError('', 'skip', error, false));
                return { committedPaths, convergedOutcomes: allConverged };
            }
        }

        return { committedPaths, convergedOutcomes: allConverged };
    }

    /**
     * Rebase pending outcomes against a freshly-loaded manifest after a 412/409.
     *
     * Uses content-hash semantics instead of ETag matching:
     * - Same contentHash in fresh manifest → converged (journal still needs update)
     * - Different contentHash in fresh manifest → stale, silently skip (next sync reconciles)
     * - File not in fresh manifest and we're adding → still pending
     * - Tombstone already in fresh manifest → converged
     * - File re-added by another device where we wanted to delete → stale, silently skip
     */
    private rebasePendingOutcomes(
        outcomes: SyncExecutionOutcome[],
        freshManifest: RemoteSyncManifest
    ): RebaseResult {
        const pending: SyncExecutionOutcome[] = [];
        const converged: SyncExecutionOutcome[] = [];

        for (const outcome of outcomes) {
            const freshEntry = freshManifest.files[outcome.path];
            const freshTombstone = freshManifest.tombstones[outcome.path];

            if (outcome.manifestEntry === null) {
                if (!freshEntry && freshTombstone) {
                    this.log(`Rebase: ${outcome.path} already tombstoned by another device, skipping`);
                    converged.push(outcome);
                    continue;
                }
                if (freshEntry) {
                    this.log(`Rebase: ${outcome.path} was modified by another device during sync; skipping delete — next sync will reconcile`);
                    continue;
                }
                pending.push(outcome);
                continue;
            }

            if (outcome.manifestEntry) {
                if (freshEntry && freshEntry.contentHash === outcome.manifestEntry.contentHash) {
                    this.log(`Rebase: ${outcome.path} already committed with same content hash, skipping`);
                    converged.push(outcome);
                    continue;
                }
                if (freshEntry && freshEntry.contentHash !== outcome.manifestEntry.contentHash) {
                    this.log(`Rebase: ${outcome.path} was modified with different content by another device; skipping — next sync will reconcile`);
                    continue;
                }
                pending.push(outcome);
                continue;
            }

            if (outcome.tombstone === null && freshTombstone) {
                pending.push(outcome);
            } else if (outcome.tombstone) {
                if (freshTombstone) {
                    this.log(`Rebase: ${outcome.path} tombstone already present, skipping`);
                    converged.push(outcome);
                    continue;
                }
                pending.push(outcome);
            } else {
                pending.push(outcome);
            }
        }

        return { pending, converged };
    }

    /**
     * Build the next manifest snapshot from successful outcomes.
     */
    private buildNextManifest(baseManifest: RemoteSyncManifest, outcomes: SyncExecutionOutcome[]): RemoteSyncManifest {
        const nextManifest = structuredClone(baseManifest);
        nextManifest.generation += 1;
        nextManifest.updatedAt = Date.now();
        nextManifest.updatedBy = this.deviceId;

        for (const outcome of outcomes) {
            if (outcome.manifestEntry !== undefined) {
                if (outcome.manifestEntry === null) {
                    delete nextManifest.files[outcome.path];
                } else {
                    nextManifest.files[outcome.path] = outcome.manifestEntry;
                }
            }

            if (outcome.tombstone !== undefined) {
                if (outcome.tombstone === null) {
                    delete nextManifest.tombstones[outcome.path];
                } else {
                    nextManifest.tombstones[outcome.path] = outcome.tombstone;
                }
            }
        }

        return nextManifest;
    }

    /**
     * Update this device's remote registry entry.
     */
    private async touchRemoteDevice(manifestGeneration: number): Promise<void> {
        const navigatorAgent = globalThis.navigator?.userAgent || 'Unknown platform';
        const deviceInfo: RemoteSyncDeviceInfo = {
            deviceId: this.deviceId,
            deviceName: navigatorAgent.split(' ')[0] || 'Obsidian',
            platform: navigatorAgent,
            lastSeenAt: Date.now(),
            createdAt: this.deviceCreatedAt,
            manifestGeneration,
        };

        try {
            await this.remoteStore.touchDevice(deviceInfo);
        } catch (error) {
            this.log(`Failed to update remote device registry: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Determine whether local content has changed from the journal baseline.
     */
    private hasLocalChanges(state: FileState): boolean {
        if (!state.localExists) {
            return false;
        }

        const journal = state.journalEntry;
        if (!journal || journal.status === 'new') {
            return true;
        }

        return state.localHash !== journal.localHash;
    }

    /**
     * Read local file content using the correct Obsidian API.
     */
    private async readLocalFileContent(file: TFile): Promise<string | Uint8Array> {
        return await readVaultFile(this.app.vault, file);
    }

    /**
     * Download remote file content with caching.
     */
    private async downloadRemoteFileContent(path: string): Promise<string | Uint8Array> {
        const cached = this.remoteContentCache.get(path);
        if (cached) {
            return cached;
        }

        const key = this.localPathToS3Key(path);
        const content = getVaultFileKind(path) === 'text'
            ? await this.s3Provider.downloadFileAsText(key)
            : await this.s3Provider.downloadFile(key);

        this.remoteContentCache.set(path, content);
        return content;
    }

    /**
     * Hash remote file content with caching.
     */
    private async getRemoteHash(path: string): Promise<string> {
        const cached = this.remoteHashCache.get(path);
        if (cached) {
            return cached;
        }

        const hash = await hashContent(await this.downloadRemoteFileContent(path));
        this.remoteHashCache.set(path, hash);
        return hash;
    }

    /**
     * Write a file into the local vault.
     */
    private async writeLocalFile(path: string, content: string | Uint8Array): Promise<void> {
        const existingFile = this.app.vault.getAbstractFileByPath(path);
        if (existingFile instanceof TFile) {
            if (typeof content === 'string') {
                await this.app.vault.modify(existingFile, content);
            } else {
                await this.app.vault.modifyBinary(existingFile, toArrayBuffer(content));
            }
            return;
        }

        await this.ensureParentFolders(path);
        if (typeof content === 'string') {
            await this.app.vault.create(path, content);
        } else {
            await this.app.vault.createBinary(path, toArrayBuffer(content));
        }
    }

    /**
     * Ensure parent folders exist for a path.
     */
    private async ensureParentFolders(path: string): Promise<void> {
        const parts = path.split('/');
        parts.pop();
        if (parts.length === 0) {
            return;
        }

        let currentPath = '';
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(currentPath)) {
                await this.app.vault.createFolder(currentPath);
            }
        }
    }

    /**
     * Compute the remote list prefix.
     */
    private getRemoteListPrefix(): string {
        return this.normalizedSyncPrefix ? `${this.normalizedSyncPrefix}/` : '';
    }

    /**
     * Convert a local vault path to an S3 object key.
     */
    private localPathToS3Key(path: string): string {
        return addPrefix(path, this.normalizedSyncPrefix);
    }

    /**
     * Convert a remote object key back to a local path.
     */
    private s3KeyToLocalPath(key: string): string | null {
        return removePrefix(key, this.normalizedSyncPrefix);
    }

    /**
     * Check whether a path should be excluded from sync.
     */
    private shouldExclude(path: string): boolean {
        return isConflictFile(path) || matchesAnyGlob(path, this.settings.excludePatterns);
    }

    /**
     * Get or create a file state entry.
     */
    private getOrCreateState(states: Map<string, FileState>, path: string): FileState {
        const existing = states.get(path);
        if (existing) {
            return existing;
        }

        const created: FileState = {
            path,
            kind: getVaultFileKind(path),
            localExists: false,
            remoteExists: false,
            hasConflictArtifacts: false,
        };
        states.set(path, created);
        return created;
    }

    /**
     * Convert any thrown value into a sync error.
     */
    private createSyncError(path: string, action: SyncAction, error: unknown, recoverable: boolean): SyncError {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[S3 Sync] ${action} failed for ${path || '<sync>'}: ${message}`);
        return {
            path,
            action,
            message,
            recoverable,
        };
    }

    /**
     * Wrap conditional write errors in a clearer sync-specific message.
     */
    private maybeConvertConditionalWriteError(path: string, error: unknown): Error {
        const err = error as Error & { $metadata?: { httpStatusCode?: number }; name?: string };
        if (
            err.$metadata?.httpStatusCode === 409 ||
            err.$metadata?.httpStatusCode === 412 ||
            err.name === 'ConditionalRequestConflict' ||
            err.name === 'PreconditionFailed'
        ) {
            return new Error(`Remote file ${path} changed while syncing. Another vault or device may be syncing at the same time. Please sync again.`);
        }

        return err instanceof Error ? err : new Error('Unknown error');
    }

    /**
     * Get or create a string stored in vault-scoped local storage.
     */
    private getOrCreateStoredString(key: string, createValue: () => string): string {
        const existing = this.app.loadLocalStorage(key) as string | null;
        if (existing) {
            return existing;
        }

        const created = createValue();
        this.app.saveLocalStorage(key, created);
        return created;
    }

    /**
     * Emit a debug log when debug logging is enabled.
     */
    private log(message: string): void {
        if (this.debugLogging) {
            console.debug(`[S3 Sync] ${message}`);
        }
    }
}
