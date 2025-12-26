/**
 * Change Tracker Module
 *
 * Monitors vault file events (create, modify, delete, rename) and
 * tracks pending changes for synchronization.
 */

import { App, TFile, TAbstractFile, Vault } from 'obsidian';
import { hashContent } from '../crypto/Hasher';
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
    private debounceTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private debounceMs = 300;
    private isTracking = false;

    // Event handlers bound to this
    private onCreateHandler: (file: TAbstractFile) => void;
    private onModifyHandler: (file: TAbstractFile) => void;
    private onDeleteHandler: (file: TAbstractFile) => void;
    private onRenameHandler: (file: TAbstractFile, oldPath: string) => void;

    constructor(app: App, journal: SyncJournal) {
        this.app = app;
        this.journal = journal;

        // Bind event handlers
        this.onCreateHandler = this.onFileCreate.bind(this);
        this.onModifyHandler = this.onFileModify.bind(this);
        this.onDeleteHandler = this.onFileDelete.bind(this);
        this.onRenameHandler = this.onFileRename.bind(this);
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

        // Clear pending timeout
        if (this.debounceTimeoutId) {
            clearTimeout(this.debounceTimeoutId);
            this.debounceTimeoutId = null;
        }
    }

    /**
     * Check if a file should be excluded from tracking
     */
    private shouldExclude(path: string): boolean {
        return this.excludePatterns.some((pattern) => {
            // Simple glob matching - supports * and **
            const regexPattern = pattern
                .replace(/\./g, '\\.')
                .replace(/\*\*/g, '.*')
                .replace(/\*/g, '[^/]*');
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(path);
        });
    }

    /**
     * Handle file creation event
     */
    private async onFileCreate(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (this.shouldExclude(file.path)) return;

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

        // Handle various rename scenarios
        if (!excludeOld && !excludeNew) {
            // Normal rename - track both old (delete) and new (create)
            this.addPendingChange({
                path: file.path,
                type: 'rename',
                timestamp: Date.now(),
                oldPath,
            });

            // Delete old entry from journal
            await this.journal.deleteEntry(oldPath);

            // Add new entry
            await this.updateJournalForFile(file);
        } else if (!excludeOld && excludeNew) {
            // Moved to excluded location - treat as delete
            this.addPendingChange({
                path: oldPath,
                type: 'delete',
                timestamp: Date.now(),
            });
            await this.journal.markDeleted(oldPath);
        } else if (excludeOld && !excludeNew) {
            // Moved from excluded location - treat as create
            this.addPendingChange({
                path: file.path,
                type: 'create',
                timestamp: Date.now(),
            });
            await this.updateJournalForFile(file);
        }
        // If both excluded, ignore
    }

    /**
     * Add a pending change, debouncing rapid changes to same file
     */
    private addPendingChange(change: PendingChange): void {
        // For deletes and renames, always record
        // For create/modify, update existing pending change
        const existing = this.pendingChanges.get(change.path);

        if (existing && (existing.type === 'create' || existing.type === 'modify')) {
            // Update timestamp, keep type as modify
            existing.timestamp = change.timestamp;
            if (change.type === 'modify') {
                existing.type = 'modify';
            }
        } else {
            this.pendingChanges.set(change.path, change);
        }
    }

    /**
     * Debounce journal updates for modified files
     */
    private debounceJournalUpdate(file: TFile): void {
        if (this.debounceTimeoutId) {
            clearTimeout(this.debounceTimeoutId);
        }

        this.debounceTimeoutId = setTimeout(async () => {
            await this.updateJournalForFile(file);
            this.debounceTimeoutId = null;
        }, this.debounceMs);
    }

    /**
     * Update journal entry for a file
     */
    private async updateJournalForFile(file: TFile): Promise<void> {
        try {
            const content = await this.app.vault.read(file);
            const hash = await hashContent(content);
            const mtime = file.stat.mtime;

            await this.journal.markPending(file.path, hash, mtime);
        } catch (error) {
            console.error(`Failed to update journal for ${file.path}:`, error);
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
