/**
 * Sync Engine Module
 *
 * Core synchronization logic that orchestrates bi-directional sync
 * between local vault and S3 storage.
 */

import { App, TFile, Notice } from 'obsidian';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';
import { ChangeTracker } from './ChangeTracker';
import { hashContent } from '../crypto/Hasher';
import {
    S3SyncBackupSettings,
    SyncResult,
    SyncPlanItem,
    SyncAction,
} from '../types';

/**
 * File info combining local and remote state
 */
interface FileState {
    path: string;
    localExists: boolean;
    remoteExists: boolean;
    localHash?: string;
    /** Current S3 ETag (MD5-based) - used for change detection */
    remoteEtag?: string;
    localMtime?: number;
    remoteMtime?: number;
    journalLocalHash?: string;
    journalRemoteHash?: string;
    /** Stored ETag from last sync - compared with current ETag */
    journalRemoteEtag?: string;
    journalSyncedAt?: number;
    /** Device that last modified this file */
    journalLastModifiedBy?: string;
}

/**
 * Extended sync plan item with expected state for pre-flight validation
 */
interface ExtendedSyncPlanItem extends SyncPlanItem {
    /** Expected ETag for pre-flight validation on delete operations */
    expectedRemoteEtag?: string;
}

/**
 * SyncEngine class - Orchestrates sync operations
 */
export class SyncEngine {
    private app: App;
    private s3Provider: S3Provider;
    private journal: SyncJournal;
    private changeTracker: ChangeTracker;
    private settings: S3SyncBackupSettings;
    private isSyncing = false;
    private debugLogging = false;
    /** Unique device ID for tracking which device made changes */
    private deviceId: string;

    constructor(
        app: App,
        s3Provider: S3Provider,
        journal: SyncJournal,
        changeTracker: ChangeTracker,
        settings: S3SyncBackupSettings
    ) {
        this.app = app;
        this.s3Provider = s3Provider;
        this.journal = journal;
        this.changeTracker = changeTracker;
        this.settings = settings;
        this.debugLogging = settings.debugLogging;
        // Generate or retrieve a unique device ID
        this.deviceId = this.getOrCreateDeviceId();
    }

    /**
     * Get or create a unique device identifier
     * Uses Obsidian's vault-scoped localStorage API
     */
    private getOrCreateDeviceId(): string {
        const storageKey = 's3-sync-device-id';
        const storedValue = this.app.loadLocalStorage(storageKey) as string | null;
        let deviceId: string = storedValue ?? '';
        if (!deviceId) {
            // Generate a unique ID: timestamp + random string
            deviceId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
            this.app.saveLocalStorage(storageKey, deviceId);
        }
        return deviceId;
    }

    /**
     * Update settings
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;
        this.debugLogging = settings.debugLogging;
    }

    /**
     * Check if sync is currently in progress
     */
    isInProgress(): boolean {
        return this.isSyncing;
    }

    /**
     * Perform a full sync operation
     */
    async sync(): Promise<SyncResult> {
        if (this.isSyncing) {
            throw new Error('Sync already in progress');
        }

        const startedAt = Date.now();
        this.isSyncing = true;

        // Notify change tracker that sync is in progress
        // This prevents race conditions with vault events
        this.changeTracker.setSyncInProgress(true);

        const result: SyncResult = {
            success: false,
            startedAt,
            completedAt: 0,
            filesUploaded: 0,
            filesDownloaded: 0,
            filesDeleted: 0,
            conflicts: [],
            errors: [],
        };

        try {
            // Always log sync start (important for debugging)
            console.debug('[S3 Sync] Starting sync...');

            // 1. Build file state map
            const fileStates = await this.buildFileStateMap();
            console.debug(`[S3 Sync] Found ${fileStates.size} unique file paths`);

            // Log detailed state in debug mode
            if (this.debugLogging) {
                for (const [path, state] of fileStates) {
                    console.debug(`[S3 Sync] File state: ${path}`, {
                        localExists: state.localExists,
                        remoteExists: state.remoteExists,
                        journalLocalHash: state.journalLocalHash ? 'set' : 'undefined',
                        journalRemoteEtag: state.journalRemoteEtag ? 'set' : 'undefined',
                    });
                }
            }

            // 2. Generate sync plan
            const syncPlan = this.generateSyncPlan(fileStates);
            console.debug(`[S3 Sync] Sync plan: ${syncPlan.length} actions`);

            // Log sync plan details
            for (const item of syncPlan) {
                console.debug(`[S3 Sync] Planned: ${item.action} - ${item.path} (${item.reason})`);
            }

            // 3. Execute sync plan
            for (const item of syncPlan) {
                try {
                    // Mark the path as syncing to prevent ChangeTracker interference
                    this.changeTracker.markPathSyncing(item.path);

                    await this.executeAction(item);

                    switch (item.action) {
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
                        case 'conflict':
                            result.conflicts.push(item.path);
                            break;
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(`[S3 Sync] Error executing ${item.action} for ${item.path}:`, errorMessage);
                    result.errors.push({
                        path: item.path,
                        action: item.action,
                        message: errorMessage,
                        recoverable: true,
                    });
                }
            }

            // 4. Clear pending changes after successful sync
            this.changeTracker.clearPendingChanges();

            result.success = result.errors.length === 0;
            console.debug(`[S3 Sync] Sync completed: ${result.filesUploaded} uploaded, ${result.filesDownloaded} downloaded, ${result.filesDeleted} deleted, ${result.conflicts.length} conflicts, ${result.errors.length} errors`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error('[S3 Sync] Sync failed:', errorMessage);
            result.errors.push({
                path: '',
                action: 'skip',
                message: errorMessage,
                recoverable: false,
            });
        } finally {
            this.isSyncing = false;
            // Notify change tracker that sync is complete
            this.changeTracker.setSyncInProgress(false);
            result.completedAt = Date.now();
        }

        return result;
    }

    /**
     * Build a map of all files with their local and remote state
     */
    private async buildFileStateMap(): Promise<Map<string, FileState>> {
        const states = new Map<string, FileState>();

        // Get all local files
        const localFiles = this.app.vault.getFiles();
        for (const file of localFiles) {
            if (this.shouldExclude(file.path)) continue;

            const content = await this.app.vault.read(file);
            const hash = await hashContent(content);

            states.set(file.path, {
                path: file.path,
                localExists: true,
                remoteExists: false,
                localHash: hash,
                localMtime: file.stat.mtime,
            });
        }

        // Get all remote files
        const prefix = this.settings.syncPrefix;
        const remoteObjects = await this.s3Provider.listObjects(`${prefix}/`);

        for (const obj of remoteObjects) {
            // Skip internal files
            if (obj.key.includes('.obsidian-s3-sync/')) continue;

            // Extract relative path
            const relativePath = this.s3KeyToLocalPath(obj.key);
            if (!relativePath) continue;
            if (this.shouldExclude(relativePath)) continue;

            // Clean ETag (remove quotes)
            const etag = obj.etag?.replace(/"/g, '') || '';

            const existing = states.get(relativePath);
            if (existing) {
                existing.remoteExists = true;
                existing.remoteMtime = obj.lastModified.getTime();
                // Store ETag for change detection (not as hash)
                existing.remoteEtag = etag;
            } else {
                states.set(relativePath, {
                    path: relativePath,
                    localExists: false,
                    remoteExists: true,
                    remoteMtime: obj.lastModified.getTime(),
                    remoteEtag: etag,
                });
            }
        }

        // Merge journal state
        const journalEntries = await this.journal.getAllEntries();
        for (const entry of journalEntries) {
            const existing = states.get(entry.path);
            if (existing) {
                existing.journalLocalHash = entry.localHash;
                existing.journalRemoteHash = entry.remoteHash;
                existing.journalRemoteEtag = entry.remoteEtag;
                existing.journalSyncedAt = entry.syncedAt;
                existing.journalLastModifiedBy = entry.lastModifiedBy;
            } else {
                // File in journal but not local or remote - was deleted
                states.set(entry.path, {
                    path: entry.path,
                    localExists: false,
                    remoteExists: false,
                    journalLocalHash: entry.localHash,
                    journalRemoteHash: entry.remoteHash,
                    journalRemoteEtag: entry.remoteEtag,
                    journalSyncedAt: entry.syncedAt,
                    journalLastModifiedBy: entry.lastModifiedBy,
                });
            }
        }

        return states;
    }

    /**
     * Generate sync plan based on file states
     *
     * Includes expected state for pre-flight validation on destructive operations.
     */
    private generateSyncPlan(states: Map<string, FileState>): ExtendedSyncPlanItem[] {
        const plan: ExtendedSyncPlanItem[] = [];

        for (const [path, state] of states) {
            const action = this.determineAction(state);
            if (action !== 'skip') {
                const item: ExtendedSyncPlanItem = {
                    path,
                    action,
                    reason: this.getActionReason(state, action),
                    localHash: state.localHash,
                    remoteHash: state.remoteEtag, // Use ETag as identifier
                };

                // For delete operations, store expected state for pre-flight validation
                if (action === 'delete-remote') {
                    // When deleting remotely, we expect the file to still match what we knew
                    item.expectedRemoteEtag = state.journalRemoteEtag;
                }

                plan.push(item);
            }
        }

        return plan;
    }

    /**
     * Determine what action to take for a file
     *
     * Uses SHA-256 hash for local change detection and S3 ETag for remote change detection.
     * This avoids the hash algorithm mismatch problem (SHA-256 vs MD5 ETag).
     *
     * IMPORTANT: The deletion logic is designed to be SAFE for multi-device scenarios:
     * - We only delete locally if the remote was DEFINITELY deleted (file gone, was synced before)
     * - We only delete remotely if the local was DEFINITELY deleted (file gone, was synced before)
     *   AND the remote hasn't changed since we last saw it (ETag matches)
     */
    private determineAction(state: FileState): SyncAction {
        const {
            localExists,
            remoteExists,
            localHash,
            remoteEtag,
            journalLocalHash,
            journalRemoteHash,
            journalRemoteEtag,
        } = state;

        // Both exist
        if (localExists && remoteExists) {
            // Check if local changed since last sync (compare SHA-256 hashes)
            const localChanged = journalLocalHash !== undefined && localHash !== journalLocalHash;

            // Check if remote changed since last sync
            // Use ETag comparison if available (preferred, as ETags are consistent)
            // Fall back to checking if we have any journal entry at all
            let remoteChanged = false;
            if (journalRemoteEtag !== undefined && remoteEtag !== undefined) {
                // Compare ETags - this is reliable
                remoteChanged = remoteEtag !== journalRemoteEtag;
            } else if (journalRemoteHash !== undefined) {
                // No stored ETag (legacy entry) - we need to assume remote might have changed
                // if local also changed, treat as conflict; otherwise download to be safe
                // This only happens for entries created before ETag tracking was added
                remoteChanged = localChanged; // Conservative: assume changed if local changed
            }
            // If no journal entry at all, handled below as first sync

            if (localChanged && remoteChanged) {
                return 'conflict'; // Both changed
            } else if (localChanged) {
                return 'upload'; // Only local changed
            } else if (remoteChanged) {
                return 'download'; // Only remote changed
            } else if (journalLocalHash === undefined) {
                // First sync for this file - compare timestamps
                if ((state.localMtime || 0) > (state.remoteMtime || 0)) {
                    return 'upload';
                } else {
                    return 'download';
                }
            }
            return 'skip';
        }

        // Only exists locally (remote is missing)
        if (localExists && !remoteExists) {
            // Check if we have a journal entry (file was previously synced)
            const wasPreviouslySynced = journalRemoteHash !== undefined || journalRemoteEtag !== undefined;

            if (wasPreviouslySynced) {
                // File was synced before, now missing remotely.
                // This could mean:
                // 1. Another device deleted it (we should delete locally)
                // 2. S3 had an issue (we should re-upload)
                // 3. User deleted via S3 console (we should delete locally)
                //
                // SAFETY CHECK: If the local file has been modified since last sync,
                // treat it as a new file (upload) to avoid data loss.
                const localModifiedSinceSync = localHash !== journalLocalHash;

                if (localModifiedSinceSync) {
                    // Local file was modified - treat as new upload to avoid losing changes
                    this.log(`File ${state.path}: local modified, remote missing - uploading to preserve changes`);
                    return 'upload';
                }

                // Local unchanged - safe to delete as remote deletion
                return 'delete-local';
            } else {
                // New local file = upload
                return 'upload';
            }
        }

        // Only exists remotely (local is missing)
        if (!localExists && remoteExists) {
            // Check if we have a journal entry (file was previously synced)
            const wasPreviouslySynced = journalLocalHash !== undefined;

            if (wasPreviouslySynced) {
                // File was synced before, now missing locally.
                // This could mean:
                // 1. This device deleted it (we should delete remotely)
                // 2. User deleted via file manager (we should delete remotely)
                //
                // SAFETY CHECK: Only delete remotely if the remote file hasn't changed
                // since we last synced. If it changed, another device modified it and
                // we should download instead.
                const remoteUnchanged = journalRemoteEtag !== undefined && remoteEtag === journalRemoteEtag;
                const remoteChanged = journalRemoteEtag !== undefined && remoteEtag !== journalRemoteEtag;

                if (remoteChanged) {
                    // Remote was modified by another device - download instead of delete
                    this.log(`File ${state.path}: local missing, remote changed - downloading modified version`);
                    return 'download';
                }

                if (remoteUnchanged) {
                    // Remote unchanged since last sync - safe to delete
                    return 'delete-remote';
                }

                // No ETag info (legacy entry) - be conservative, download to avoid data loss
                this.log(`File ${state.path}: local missing, no ETag info - downloading to be safe`);
                return 'download';
            } else {
                // New remote file = download
                return 'download';
            }
        }

        // Neither exists (was in journal) - cleanup journal entry
        return 'skip';
    }

    /**
     * Get human-readable reason for action
     */
    private getActionReason(state: FileState, action: SyncAction): string {
        switch (action) {
            case 'upload':
                return state.journalLocalHash ? 'Local file modified' : 'New local file';
            case 'download':
                // Check if we had any prior sync (either ETag or hash)
                return (state.journalRemoteEtag || state.journalRemoteHash)
                    ? 'Remote file modified'
                    : 'New remote file';
            case 'delete-local':
                return 'Deleted remotely';
            case 'delete-remote':
                return 'Deleted locally';
            case 'conflict':
                return 'Modified on both local and remote';
            case 'skip':
                return 'No changes';
        }
    }

    /**
     * Execute a single sync action
     *
     * For delete operations, performs pre-flight validation to ensure the file
     * hasn't changed since we decided to delete it.
     */
    private async executeAction(item: ExtendedSyncPlanItem): Promise<void> {
        this.log(`Executing ${item.action} for ${item.path}: ${item.reason}`);

        switch (item.action) {
            case 'upload':
                await this.uploadFile(item.path);
                break;
            case 'download':
                // Pass the ETag (stored in remoteHash) for journal tracking
                await this.downloadFile(item.path, item.remoteHash);
                break;
            case 'delete-local':
                await this.deleteLocalFile(item.path);
                break;
            case 'delete-remote':
                // Pre-flight validation: ensure remote hasn't changed since we decided to delete
                await this.deleteRemoteFile(item.path, item.expectedRemoteEtag);
                break;
            case 'conflict':
                await this.handleConflict(item.path, item.remoteHash);
                break;
        }
    }

    /**
     * Upload a file to S3
     *
     * Tracks this device as the modifier of the file.
     */
    private async uploadFile(path: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            throw new Error(`File not found: ${path}`);
        }

        const content = await this.app.vault.read(file);
        const hash = await hashContent(content);
        const key = this.localPathToS3Key(path);

        // TODO: Encrypt content if encryption enabled

        // Upload and get the ETag
        const etag = await this.s3Provider.uploadFile(key, content);

        // Update journal with hash, ETag, and device ID
        await this.journal.markSynced(path, hash, hash, file.stat.mtime, Date.now(), etag, this.deviceId);
    }

    /**
     * Download a file from S3
     *
     * If remoteEtag is not provided, fetches it from S3 metadata to ensure
     * we always track the remote state properly.
     *
     * @param path - Local file path
     * @param remoteEtag - S3 ETag for tracking remote state (optional, will be fetched if not provided)
     */
    private async downloadFile(path: string, remoteEtag?: string): Promise<void> {
        const key = this.localPathToS3Key(path);

        // If ETag not provided, fetch it to ensure proper tracking
        let etag = remoteEtag;
        if (!etag) {
            const metadata = await this.s3Provider.getFileMetadata(key);
            etag = metadata?.etag;
            this.log(`Fetched ETag for ${path}: ${etag}`);
        }

        // Download content
        const content = await this.s3Provider.downloadFileAsText(key);

        // TODO: Decrypt content if encryption enabled

        // Check if file exists locally
        const existingFile = this.app.vault.getAbstractFileByPath(path);

        if (existingFile instanceof TFile) {
            // Modify existing file
            await this.app.vault.modify(existingFile, content);
        } else {
            // Create new file (ensuring parent folders exist)
            await this.ensureParentFolders(path);
            await this.app.vault.create(path, content);
        }

        // Update journal with hash and ETag
        const hash = await hashContent(content);
        const downloadedFile = this.app.vault.getAbstractFileByPath(path);
        if (!(downloadedFile instanceof TFile)) {
            throw new Error(`Downloaded file not found: ${path}`);
        }
        await this.journal.markSynced(path, hash, hash, downloadedFile.stat.mtime, Date.now(), etag, this.deviceId);
    }

    /**
     * Delete a local file
     */
    private async deleteLocalFile(path: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.app.fileManager.trashFile(file);
        }
        await this.journal.deleteEntry(path);
    }

    /**
     * Delete a remote file with pre-flight validation
     *
     * Before deleting, verifies the remote file hasn't been modified since we
     * decided to delete it. This prevents accidental deletion of files that
     * another device has modified.
     *
     * @param path - Local file path
     * @param expectedEtag - Expected ETag from when we decided to delete (for validation)
     */
    private async deleteRemoteFile(path: string, expectedEtag?: string): Promise<void> {
        const key = this.localPathToS3Key(path);

        // Pre-flight validation: check if remote file still exists and matches expected state
        if (expectedEtag) {
            const currentEtag = await this.s3Provider.getFileEtag(key);

            if (currentEtag === null) {
                // File already deleted - just clean up journal
                this.log(`File ${path} already deleted from remote, cleaning up journal`);
                await this.journal.deleteEntry(path);
                return;
            }

            if (currentEtag !== expectedEtag) {
                // File was modified by another device - DON'T delete, download instead
                this.log(`ABORT DELETE: File ${path} was modified remotely (expected ETag: ${expectedEtag}, actual: ${currentEtag})`);
                throw new Error(`Remote file ${path} was modified by another device. Sync again to download the new version.`);
            }
        } else {
            // No expected ETag - check if file still exists
            const exists = await this.s3Provider.fileExists(key);
            if (!exists) {
                // File already deleted - just clean up journal
                this.log(`File ${path} already deleted from remote, cleaning up journal`);
                await this.journal.deleteEntry(path);
                return;
            }
            // Without expected ETag, we proceed with delete but log a warning
            this.log(`WARNING: Deleting ${path} without ETag validation - potential race condition`);
        }

        // Safe to delete
        await this.s3Provider.deleteFile(key);
        await this.journal.deleteEntry(path);
        this.log(`Deleted remote file: ${path}`);
    }

    /**
     * Handle a conflict by creating LOCAL_ and REMOTE_ versions
     *
     * @param path - File path with conflict
     * @param remoteEtag - Current remote ETag for tracking
     */
    private async handleConflict(path: string, remoteEtag?: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;

        // Get file directory and name
        const dir = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        const localPath = dir ? `${dir}/LOCAL_${fileName}` : `LOCAL_${fileName}`;
        const remotePath = dir ? `${dir}/REMOTE_${fileName}` : `REMOTE_${fileName}`;

        // Read local content
        const localContent = await this.app.vault.read(file);

        // Rename local file to LOCAL_
        await this.app.vault.rename(file, localPath);

        // Download remote as REMOTE_
        const key = this.localPathToS3Key(path);

        // Get current ETag if not provided
        let etag = remoteEtag;
        if (!etag) {
            const metadata = await this.s3Provider.getFileMetadata(key);
            etag = metadata?.etag;
        }

        const remoteContent = await this.s3Provider.downloadFileAsText(key);
        await this.app.vault.create(remotePath, remoteContent);

        // Update journal to mark as conflict with ETag
        const localHash = await hashContent(localContent);
        const remoteHash = await hashContent(remoteContent);
        await this.journal.markConflict(path, localHash, remoteHash, etag);

        // Notify user
        new Notice(`Conflict detected: ${fileName}\nBoth LOCAL_ and REMOTE_ versions saved.`);
    }

    /**
     * Ensure parent folders exist for a path
     */
    private async ensureParentFolders(path: string): Promise<void> {
        const parts = path.split('/');
        parts.pop(); // Remove filename

        if (parts.length === 0) return;

        let currentPath = '';
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!folder) {
                await this.app.vault.createFolder(currentPath);
            }
        }
    }

    /**
     * Convert local path to S3 key
     */
    private localPathToS3Key(path: string): string {
        return `${this.settings.syncPrefix}/${path}`;
    }

    /**
     * Convert S3 key to local path
     */
    private s3KeyToLocalPath(key: string): string | null {
        const prefix = `${this.settings.syncPrefix}/`;
        if (key.startsWith(prefix)) {
            return key.substring(prefix.length);
        }
        return null;
    }

    /**
     * Check if a path should be excluded
     *
     * Supports glob patterns:
     * - `*` matches any characters except /
     * - `**` matches any characters including /
     * - Patterns are matched against the FULL path
     * - Use `**\/` prefix for recursive matching (e.g., `**\/*.tmp` matches any .tmp file)
     */
    private shouldExclude(path: string): boolean {
        return this.settings.excludePatterns.some((pattern) => {
            // Convert glob pattern to regex
            const regexPattern = pattern
                .replace(/\./g, '\\.')  // Escape dots
                .replace(/\*\*/g, '<<DOUBLESTAR>>')  // Temp placeholder for **
                .replace(/\*/g, '[^/]*')  // * matches non-separator chars
                .replace(/<<DOUBLESTAR>>/g, '.*');  // ** matches anything

            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(path);
        });
    }

    /**
     * Log debug message
     */
    private log(message: string): void {
        if (this.debugLogging) {
            console.debug(`[S3 Sync] ${message}`);
        }
    }
}
