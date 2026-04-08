/**
 * Change Tracker Module
 *
 * Monitors vault file events (create, modify, delete, rename) and
 * tracks pending changes for synchronization.
 */

import { App, TFile, TAbstractFile } from 'obsidian';
import { hashContent } from '../crypto/Hasher';
import { isConflictFile, matchesAnyGlob } from '../utils/paths';
import { readVaultFile } from '../utils/vaultFiles';
import { SyncJournal } from './SyncJournal';

/**
 * Pending change entry
 */
export interface PendingChange {
    path: string;
    type: 'create' | 'modify' | 'delete' | 'rename';
    timestamp: number;
    oldPath?: string; // For renames
}

/**
 * ChangeTracker class - Monitors vault changes
 *
 * Listens to vault events and maintains a list of pending changes
 * that need to be synchronized.
 */
export class ChangeTracker {
    private app: App;
    private journal: SyncJournal;
    private pendingChanges: Map<string, PendingChange> = new Map();
    private excludePatterns: string[] = [];
    /**
     * Per-file debounce timers.
     * Each file gets its own timer so rapid edits to different files
     * do not cancel each other's journal updates.
     */
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private debounceMs = 300;
    private isTracking = false;

    /**
     * Flag to pause journal updates during sync operations.
     * When true, file events are still tracked but journal is not updated.
     * This prevents race conditions between sync and change tracking.
     */
    private isSyncInProgress = false;

    /**
     * Paths that are currently being synced (downloaded/uploaded).
     * Changes to these paths are ignored to prevent race conditions.
     */
    private syncingPaths: Set<string> = new Set();

    /**
     * Paths changed while sync was actively touching them.
     */
    private dirtyWhileSyncing: Set<string> = new Set();

    // Event handlers bound to this
    private onCreateHandler: (file: TAbstractFile) => void;
    private onModifyHandler: (file: TAbstractFile) => void;
    private onDeleteHandler: (file: TAbstractFile) => void;
    private onRenameHandler: (file: TAbstractFile, oldPath: string) => void;

    constructor(app: App, journal: SyncJournal) {
        this.app = app;
        this.journal = journal;

        // Bind event handlers (wrap async in void to satisfy type checker)
        this.onCreateHandler = (file) => { void this.onFileCreate(file); };
        this.onModifyHandler = (file) => { void this.onFileModify(file); };
        this.onDeleteHandler = (file) => { void this.onFileDelete(file); };
        this.onRenameHandler = (file, oldPath) => { void this.onFileRename(file, oldPath); };
    }

    /**
     * Mark that a sync operation is in progress.
     * During sync, journal updates are paused to prevent race conditions.
     */
    setSyncInProgress(inProgress: boolean): void {
        this.isSyncInProgress = inProgress;
        if (!inProgress) {
            // Clear syncing paths when sync completes
            this.syncingPaths.clear();
            void this.flushDirtyPaths();
        }
    }

    /**
     * Mark a path as currently being synced.
     * Events for this path will be ignored until sync completes.
     */
    markPathSyncing(path: string): void {
        this.syncingPaths.add(path);
    }

    /**
     * Check if a path is currently being synced
     */
    private isPathSyncing(path: string): boolean {
        return this.syncingPaths.has(path);
    }

    /**
     * Start tracking vault changes
     *
     * @param excludePatterns - Glob patterns for files to exclude
     */
    startTracking(excludePatterns: string[] = []): void {
        if (this.isTracking) return;

        this.excludePatterns = excludePatterns;
        this.isTracking = true;

        // Register vault event handlers
        this.app.vault.on('create', this.onCreateHandler);
        this.app.vault.on('modify', this.onModifyHandler);
        this.app.vault.on('delete', this.onDeleteHandler);
        this.app.vault.on('rename', this.onRenameHandler);
    }

    /**
     * Stop tracking vault changes
     */
    stopTracking(): void {
        if (!this.isTracking) return;

        this.isTracking = false;

        // Unregister vault event handlers
        this.app.vault.off('create', this.onCreateHandler);
        this.app.vault.off('modify', this.onModifyHandler);
        this.app.vault.off('delete', this.onDeleteHandler);
        this.app.vault.off('rename', this.onRenameHandler);

        // Clear all pending debounce timers
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }

    /**
     * Check if a file should be excluded from tracking
     *
     * Supports glob patterns:
     * - `*` matches any characters except /
     * - `**` matches any characters including /
     * - Patterns are matched against the FULL path
     */
    private shouldExclude(path: string): boolean {
        return isConflictFile(path) || matchesAnyGlob(path, this.excludePatterns);
    }

    /**
     * Handle file creation event
     */
    private async onFileCreate(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (this.shouldExclude(file.path)) return;

        // Skip journal update if this path is being synced
        // This prevents race conditions during download operations
        if (this.isPathSyncing(file.path)) {
            this.dirtyWhileSyncing.add(file.path);
            return;
        }

        this.addPendingChange({
            path: file.path,
            type: 'create',
            timestamp: Date.now(),
        });

        // Update journal
        await this.updateJournalForFile(file);
    }

    /**
     * Handle file modification event
     */
    private async onFileModify(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (this.shouldExclude(file.path)) return;

        // Skip journal update if this path is being synced
        // This prevents race conditions during upload/download operations
        if (this.isPathSyncing(file.path)) {
            this.dirtyWhileSyncing.add(file.path);
            return;
        }

        this.addPendingChange({
            path: file.path,
            type: 'modify',
            timestamp: Date.now(),
        });

        // Debounce journal update
        this.debounceJournalUpdate(file);
    }

    /**
     * Handle file deletion event
     */
    private async onFileDelete(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (this.shouldExclude(file.path)) return;

        // Skip journal update if this path is being synced
        // This prevents race conditions during delete operations
        if (this.isPathSyncing(file.path)) {
            this.dirtyWhileSyncing.add(file.path);
            return;
        }

        this.addPendingChange({
            path: file.path,
            type: 'delete',
            timestamp: Date.now(),
        });

        // Mark as deleted in journal
        await this.journal.markDeleted(file.path);
    }

    /**
     * Handle file rename event
     */
    private async onFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
        if (!(file instanceof TFile)) return;

        const excludeOld = this.shouldExclude(oldPath);
        const excludeNew = this.shouldExclude(file.path);
        const timestamp = Date.now();

        // Handle various rename scenarios
        if (!excludeOld && !excludeNew) {
            // Normal rename - queue a remote delete for the old path and an
            // upload for the new path.
            this.addPendingChange({
                path: oldPath,
                type: 'delete',
                timestamp,
            });

            this.addPendingChange({
                path: file.path,
                type: 'rename',
                timestamp,
                oldPath,
            });

            // Keep the old entry as a pending deletion so the remote path is removed.
            await this.journal.markDeleted(oldPath);

            // Record the new path as a pending upload/new file.
            await this.updateJournalForFile(file);
        } else if (!excludeOld && excludeNew) {
            // Moved to excluded location - treat as delete
            this.addPendingChange({
                path: oldPath,
                type: 'delete',
                timestamp,
            });
            await this.journal.markDeleted(oldPath);
        } else if (excludeOld && !excludeNew) {
            // Moved from excluded location - treat as create
            this.addPendingChange({
                path: file.path,
                type: 'create',
                timestamp,
            });
            await this.updateJournalForFile(file);
        }
        // If both excluded, ignore
    }

    /**
     * Add a pending change, debouncing rapid changes to same file.
     * Delete and rename events always overwrite prior create/modify entries
     * because the file no longer exists at the original path.
     */
    private addPendingChange(change: PendingChange): void {
        const existing = this.pendingChanges.get(change.path);

        if (change.type === 'delete' || change.type === 'rename') {
            this.pendingChanges.set(change.path, change);
            return;
        }

        if (existing && (existing.type === 'create' || existing.type === 'modify')) {
            existing.timestamp = change.timestamp;
            if (change.type === 'modify') {
                existing.type = 'modify';
            }
        } else {
            this.pendingChanges.set(change.path, change);
        }
    }

    /**
     * Debounce journal updates for modified files.
     * Uses per-file timers so concurrent edits to different files
     * each get their journal updated independently.
     */
    private debounceJournalUpdate(file: TFile): void {
        const existing = this.debounceTimers.get(file.path);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(file.path);
            void this.updateJournalForFile(file);
        }, this.debounceMs);

        this.debounceTimers.set(file.path, timer);
    }

    /**
     * Update journal entry for a file
     */
    private async updateJournalForFile(file: TFile): Promise<void> {
        try {
            const content = await readVaultFile(this.app.vault, file);
            const hash = await hashContent(content);
            const mtime = file.stat.mtime;

            await this.journal.markPending(file.path, hash, mtime);
        } catch (error) {
            console.error(`Failed to update journal for ${file.path}:`, error);
        }
    }

    /**
     * Re-scan paths that changed while sync was actively mutating them.
     * Skips journal update when the file hash matches the synced baseline,
     * which avoids overwriting a freshly synced entry back to 'pending'.
     */
    private async flushDirtyPaths(): Promise<void> {
        const dirtyPaths = Array.from(this.dirtyWhileSyncing.values());
        this.dirtyWhileSyncing.clear();

        for (const path of dirtyPaths) {
            if (this.shouldExclude(path)) {
                continue;
            }

            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                try {
                    const content = await readVaultFile(this.app.vault, file);
                    const hash = await hashContent(content);

                    const journalEntry = await this.journal.getEntry(path);
                    if (journalEntry?.status === 'synced' && journalEntry.localHash === hash) {
                        continue;
                    }

                    this.addPendingChange({
                        path,
                        type: 'modify',
                        timestamp: Date.now(),
                    });
                    await this.journal.markPending(path, hash, file.stat.mtime);
                } catch (error) {
                    console.error(`Failed to flush dirty path ${path}:`, error);
                }
                continue;
            }

            if (await this.journal.hasEntry(path)) {
                this.addPendingChange({
                    path,
                    type: 'delete',
                    timestamp: Date.now(),
                });
                await this.journal.markDeleted(path);
            }
        }
    }

    /**
     * Get all pending changes
     */
    getPendingChanges(): PendingChange[] {
        return Array.from(this.pendingChanges.values());
    }

    /**
     * Get pending changes count
     */
    getPendingCount(): number {
        return this.pendingChanges.size;
    }

    /**
     * Clear all pending changes
     * Called after a successful sync
     */
    clearPendingChanges(): void {
        this.pendingChanges.clear();
    }

    /**
     * Clear pending change for a specific path
     */
    clearPendingChange(path: string): void {
        this.pendingChanges.delete(path);
    }

    /**
     * Update exclude patterns
     */
    updateExcludePatterns(patterns: string[]): void {
        this.excludePatterns = patterns;
    }
}
