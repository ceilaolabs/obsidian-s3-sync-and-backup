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
    SyncError,
    S3ObjectInfo,
} from '../types';

/**
 * File info combining local and remote state
 */
interface FileState {
    path: string;
    localExists: boolean;
    remoteExists: boolean;
    localHash?: string;
    remoteHash?: string;
    localMtime?: number;
    remoteMtime?: number;
    journalLocalHash?: string;
    journalRemoteHash?: string;
    journalSyncedAt?: number;
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
            this.log('Starting sync...');

            // 1. Build file state map
            const fileStates = await this.buildFileStateMap();
            this.log(`Found ${fileStates.size} unique file paths`);

            // 2. Generate sync plan
            const syncPlan = this.generateSyncPlan(fileStates);
            this.log(`Sync plan: ${syncPlan.length} actions`);

            // 3. Execute sync plan
            for (const item of syncPlan) {
                try {
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
            this.log(`Sync completed: ${result.filesUploaded} uploaded, ${result.filesDownloaded} downloaded, ${result.filesDeleted} deleted, ${result.conflicts.length} conflicts`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            result.errors.push({
                path: '',
                action: 'skip',
                message: errorMessage,
                recoverable: false,
            });
        } finally {
            this.isSyncing = false;
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

            const existing = states.get(relativePath);
            if (existing) {
                existing.remoteExists = true;
                existing.remoteMtime = obj.lastModified.getTime();
                // ETag can serve as hash (with some caveats for multipart uploads)
                existing.remoteHash = obj.etag?.replace(/"/g, '') || '';
            } else {
                states.set(relativePath, {
                    path: relativePath,
                    localExists: false,
                    remoteExists: true,
                    remoteMtime: obj.lastModified.getTime(),
                    remoteHash: obj.etag?.replace(/"/g, '') || '',
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
                existing.journalSyncedAt = entry.syncedAt;
            } else {
                // File in journal but not local or remote - was deleted
                states.set(entry.path, {
                    path: entry.path,
                    localExists: false,
                    remoteExists: false,
                    journalLocalHash: entry.localHash,
                    journalRemoteHash: entry.remoteHash,
                    journalSyncedAt: entry.syncedAt,
                });
            }
        }

        return states;
    }

    /**
     * Generate sync plan based on file states
     */
    private generateSyncPlan(states: Map<string, FileState>): SyncPlanItem[] {
        const plan: SyncPlanItem[] = [];

        for (const [path, state] of states) {
            const action = this.determineAction(state);
            if (action !== 'skip') {
                plan.push({
                    path,
                    action,
                    reason: this.getActionReason(state, action),
                    localHash: state.localHash,
                    remoteHash: state.remoteHash,
                });
            }
        }

        return plan;
    }

    /**
     * Determine what action to take for a file
     */
    private determineAction(state: FileState): SyncAction {
        const { localExists, remoteExists, localHash, remoteHash, journalLocalHash, journalRemoteHash } = state;

        // Both exist
        if (localExists && remoteExists) {
            // Check if content is the same (using hashes)
            if (localHash && remoteHash && localHash === remoteHash) {
                return 'skip'; // Already in sync
            }

            // Check if local changed since last sync
            const localChanged = journalLocalHash && localHash !== journalLocalHash;
            // Check if remote changed since last sync
            const remoteChanged = journalRemoteHash && remoteHash !== journalRemoteHash;

            if (localChanged && remoteChanged) {
                return 'conflict'; // Both changed
            } else if (localChanged) {
                return 'upload'; // Only local changed
            } else if (remoteChanged) {
                return 'download'; // Only remote changed
            } else if (!journalLocalHash) {
                // First sync - compare timestamps
                if ((state.localMtime || 0) > (state.remoteMtime || 0)) {
                    return 'upload';
                } else {
                    return 'download';
                }
            }
            return 'skip';
        }

        // Only exists locally
        if (localExists && !remoteExists) {
            if (journalRemoteHash) {
                // Was synced before, now missing remotely = delete locally
                return 'delete-local';
            } else {
                // New local file = upload
                return 'upload';
            }
        }

        // Only exists remotely
        if (!localExists && remoteExists) {
            if (journalLocalHash) {
                // Was synced before, now missing locally = delete remotely
                return 'delete-remote';
            } else {
                // New remote file = download
                return 'download';
            }
        }

        // Neither exists (was in journal) - cleanup
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
                return state.journalRemoteHash ? 'Remote file modified' : 'New remote file';
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
     */
    private async executeAction(item: SyncPlanItem): Promise<void> {
        this.log(`Executing ${item.action} for ${item.path}: ${item.reason}`);

        switch (item.action) {
            case 'upload':
                await this.uploadFile(item.path);
                break;
            case 'download':
                await this.downloadFile(item.path);
                break;
            case 'delete-local':
                await this.deleteLocalFile(item.path);
                break;
            case 'delete-remote':
                await this.deleteRemoteFile(item.path);
                break;
            case 'conflict':
                await this.handleConflict(item.path);
                break;
        }
    }

    /**
     * Upload a file to S3
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

        await this.s3Provider.uploadFile(key, content);

        // Update journal
        await this.journal.markSynced(path, hash, hash, file.stat.mtime, Date.now());
    }

    /**
     * Download a file from S3
     */
    private async downloadFile(path: string): Promise<void> {
        const key = this.localPathToS3Key(path);

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

        // Update journal
        const hash = await hashContent(content);
        const file = this.app.vault.getAbstractFileByPath(path) as TFile;
        await this.journal.markSynced(path, hash, hash, file.stat.mtime, Date.now());
    }

    /**
     * Delete a local file
     */
    private async deleteLocalFile(path: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.app.vault.trash(file, true);
        }
        await this.journal.deleteEntry(path);
    }

    /**
     * Delete a remote file
     */
    private async deleteRemoteFile(path: string): Promise<void> {
        const key = this.localPathToS3Key(path);
        await this.s3Provider.deleteFile(key);
        await this.journal.deleteEntry(path);
    }

    /**
     * Handle a conflict by creating LOCAL_ and REMOTE_ versions
     */
    private async handleConflict(path: string): Promise<void> {
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
        const remoteContent = await this.s3Provider.downloadFileAsText(key);
        await this.app.vault.create(remotePath, remoteContent);

        // Update journal to mark as conflict
        const localHash = await hashContent(localContent);
        const remoteHash = await hashContent(remoteContent);
        await this.journal.markConflict(path, localHash, remoteHash);

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
     */
    private shouldExclude(path: string): boolean {
        return this.settings.excludePatterns.some((pattern) => {
            const regexPattern = pattern
                .replace(/\./g, '\\.')
                .replace(/\*\*/g, '.*')
                .replace(/\*/g, '[^/]*');
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(path);
        });
    }

    /**
     * Log debug message
     */
    private log(message: string): void {
        if (this.debugLogging) {
            console.log(`[S3 Sync] ${message}`);
        }
    }
}
