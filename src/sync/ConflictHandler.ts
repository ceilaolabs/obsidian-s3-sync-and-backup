/**
 * Conflict Handler Module
 *
 * Handles sync conflicts by creating LOCAL_ and REMOTE_ versions of files.
 * Provides conflict notification and resolution tracking.
 */

import { App, Modal, TFile, Notice } from 'obsidian';
import { SyncJournal } from './SyncJournal';

/**
 * Conflict info for tracking and display
 */
export interface ConflictInfo {
    path: string;
    localPath: string;
    remotePath: string;
    detectedAt: number;
    resolved: boolean;
}

/**
 * ConflictHandler class - Manages file conflicts
 */
export class ConflictHandler {
    private app: App;
    private journal: SyncJournal;
    private activeConflicts: Map<string, ConflictInfo> = new Map();

    constructor(app: App, journal: SyncJournal) {
        this.app = app;
        this.journal = journal;
    }

    /**
     * Handle a conflict by creating LOCAL_ and REMOTE_ versions
     *
     * @param path - Original file path
     * @param localContent - Content of local version
     * @param remoteContent - Content of remote version
     * @returns ConflictInfo with created file paths
     */
    async handleConflict(
        path: string,
        localContent: string,
        remoteContent: string
    ): Promise<ConflictInfo> {
        // Generate conflict file names
        const { localPath, remotePath } = this.generateConflictPaths(path);

        // Get the original file
        const originalFile = this.app.vault.getAbstractFileByPath(path);

        if (originalFile instanceof TFile) {
            // Rename original to LOCAL_
            await this.app.vault.rename(originalFile, localPath);
        } else {
            // Create LOCAL_ file with content
            await this.ensureParentFolders(localPath);
            await this.app.vault.create(localPath, localContent);
        }

        // Create REMOTE_ file
        await this.ensureParentFolders(remotePath);
        await this.app.vault.create(remotePath, remoteContent);

        // Create conflict info
        const conflictInfo: ConflictInfo = {
            path,
            localPath,
            remotePath,
            detectedAt: Date.now(),
            resolved: false,
        };

        // Track conflict
        this.activeConflicts.set(path, conflictInfo);

        // Update journal
        await this.journal.markConflict(path, '', '');

        return conflictInfo;
    }

    /**
     * Generate LOCAL_ and REMOTE_ file paths
     */
    private generateConflictPaths(path: string): { localPath: string; remotePath: string } {
        const lastSlash = path.lastIndexOf('/');
        const dir = lastSlash >= 0 ? path.substring(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

        const localName = `LOCAL_${fileName}`;
        const remoteName = `REMOTE_${fileName}`;

        return {
            localPath: dir ? `${dir}/${localName}` : localName,
            remotePath: dir ? `${dir}/${remoteName}` : remoteName,
        };
    }

    /**
     * Ensure parent folders exist
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
     * Show notification modal for a conflict
     */
    showConflictNotification(conflictInfo: ConflictInfo): void {
        new ConflictModal(this.app, conflictInfo).open();
    }

    /**
     * Get all active conflicts
     */
    getActiveConflicts(): ConflictInfo[] {
        return Array.from(this.activeConflicts.values()).filter((c) => !c.resolved);
    }

    /**
     * Get active conflict count
     */
    getConflictCount(): number {
        return this.getActiveConflicts().length;
    }

    /**
     * Mark a conflict as resolved
     */
    async markResolved(path: string): Promise<void> {
        const conflict = this.activeConflicts.get(path);
        if (conflict) {
            conflict.resolved = true;
            this.activeConflicts.delete(path);
        }

        // Remove from journal
        await this.journal.deleteEntry(path);
    }

    /**
     * Check if a path is a conflict file (LOCAL_ or REMOTE_)
     */
    isConflictFile(path: string): boolean {
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        return fileName.startsWith('LOCAL_') || fileName.startsWith('REMOTE_');
    }

    /**
     * Get original path from conflict file path
     */
    getOriginalPath(conflictPath: string): string | null {
        const lastSlash = conflictPath.lastIndexOf('/');
        const dir = lastSlash >= 0 ? conflictPath.substring(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? conflictPath.substring(lastSlash + 1) : conflictPath;

        let originalName: string;
        if (fileName.startsWith('LOCAL_')) {
            originalName = fileName.substring(6);
        } else if (fileName.startsWith('REMOTE_')) {
            originalName = fileName.substring(7);
        } else {
            return null;
        }

        return dir ? `${dir}/${originalName}` : originalName;
    }

    /**
     * Load conflicts from journal on startup
     */
    async loadConflictsFromJournal(): Promise<void> {
        const entries = await this.journal.getConflictedEntries();
        for (const entry of entries) {
            const { localPath, remotePath } = this.generateConflictPaths(entry.path);
            this.activeConflicts.set(entry.path, {
                path: entry.path,
                localPath,
                remotePath,
                detectedAt: entry.syncedAt,
                resolved: false,
            });
        }
    }
}

/**
 * Conflict notification modal
 */
class ConflictModal extends Modal {
    private conflictInfo: ConflictInfo;

    constructor(app: App, conflictInfo: ConflictInfo) {
        super(app);
        this.conflictInfo = conflictInfo;
    }

    onOpen(): void {
        const { contentEl } = this;

        // Title
        contentEl.createEl('h2', { text: '⚠️ Sync Conflict Detected' });

        // Description
        const fileName = this.conflictInfo.path.substring(
            this.conflictInfo.path.lastIndexOf('/') + 1
        );
        contentEl.createEl('p', {
            text: `The file "${fileName}" was edited on multiple devices while offline.`,
        });

        // Files created
        contentEl.createEl('p', { text: 'Both versions have been saved:' });

        const list = contentEl.createEl('ul');
        list.createEl('li', {
            text: `📄 ${this.conflictInfo.localPath.substring(this.conflictInfo.localPath.lastIndexOf('/') + 1)} (this device's version)`,
        });
        list.createEl('li', {
            text: `📄 ${this.conflictInfo.remotePath.substring(this.conflictInfo.remotePath.lastIndexOf('/') + 1)} (other device's version)`,
        });

        // Instructions
        contentEl.createEl('p', {
            text: 'Please compare both files, merge your changes into a new file with the original name, then delete the LOCAL_ and REMOTE_ versions.',
            cls: 's3-sync-conflict-instructions',
        });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 's3-sync-conflict-buttons' });

        const dismissButton = buttonContainer.createEl('button', { text: 'Dismiss' });
        dismissButton.addEventListener('click', () => {
            this.close();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}
