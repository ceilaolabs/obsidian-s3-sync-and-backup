/**
 * Retention Manager Module
 *
 * Manages backup retention policy by deleting old backups
 * based on age (days) or count (copies).
 */

import { S3Provider } from '../storage/S3Provider';
import { S3SyncBackupSettings, BackupInfo, BackupManifest } from '../types';

/**
 * RetentionManager class - Manages backup retention
 */
export class RetentionManager {
    private s3Provider: S3Provider;
    private settings: S3SyncBackupSettings;

    constructor(s3Provider: S3Provider, settings: S3SyncBackupSettings) {
        this.s3Provider = s3Provider;
        this.settings = settings;
    }

    /**
     * Update settings
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;
    }

    /**
     * Apply retention policy - delete old backups
     *
     * @returns Number of backups deleted
     */
    async applyRetentionPolicy(): Promise<number> {
        if (!this.settings.retentionEnabled) {
            return 0;
        }

        const backups = await this.listBackups();

        if (backups.length === 0) {
            return 0;
        }

        // Sort by timestamp, newest first
        backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        let toDelete: BackupInfo[] = [];

        if (this.settings.retentionMode === 'days') {
            // Delete backups older than retentionDays
            const cutoffMs = Date.now() - (this.settings.retentionDays * 24 * 60 * 60 * 1000);

            toDelete = backups.filter((backup) => {
                const backupTime = new Date(backup.timestamp).getTime();
                return backupTime < cutoffMs;
            });
        } else if (this.settings.retentionMode === 'copies') {
            // Keep only retentionCopies, delete the rest
            if (backups.length > this.settings.retentionCopies) {
                toDelete = backups.slice(this.settings.retentionCopies);
            }
        }

        // Delete excess backups
        for (const backup of toDelete) {
            await this.deleteBackup(backup.name);
        }

        if (this.settings.debugLogging && toDelete.length > 0) {
            console.log(`[S3 Backup] Retention: deleted ${toDelete.length} old backups`);
        }

        return toDelete.length;
    }

    /**
     * List all backups
     */
    async listBackups(): Promise<BackupInfo[]> {
        const prefix = `${this.settings.backupPrefix}/`;
        const objects = await this.s3Provider.listObjects(prefix, true);

        // Find unique backup folders
        const backupFolders = new Set<string>();
        const manifestKeys: string[] = [];

        for (const obj of objects) {
            // Extract backup folder name from key
            const relativePath = obj.key.substring(prefix.length);
            const folderEnd = relativePath.indexOf('/');

            if (folderEnd > 0) {
                const folderName = relativePath.substring(0, folderEnd);
                if (folderName.startsWith('backup-')) {
                    backupFolders.add(folderName);

                    if (relativePath.endsWith('.backup-manifest.json')) {
                        manifestKeys.push(obj.key);
                    }
                }
            }
        }

        // Load manifests to get backup info
        const backups: BackupInfo[] = [];

        for (const folder of backupFolders) {
            const manifestKey = `${prefix}${folder}/.backup-manifest.json`;

            try {
                const manifestJson = await this.s3Provider.downloadFileAsText(manifestKey);
                const manifest: BackupManifest = JSON.parse(manifestJson);

                backups.push({
                    name: folder,
                    timestamp: manifest.timestamp,
                    fileCount: manifest.fileCount,
                    totalSize: manifest.totalSize,
                    encrypted: manifest.encrypted,
                });
            } catch {
                // If manifest can't be read, create basic info from folder name
                const timestamp = this.parseTimestampFromFolderName(folder);
                backups.push({
                    name: folder,
                    timestamp,
                    fileCount: 0,
                    totalSize: 0,
                    encrypted: false,
                });
            }
        }

        return backups;
    }

    /**
     * Delete a backup folder
     */
    async deleteBackup(backupName: string): Promise<void> {
        const prefix = `${this.settings.backupPrefix}/${backupName}/`;
        await this.s3Provider.deletePrefix(prefix);
    }

    /**
     * Parse timestamp from backup folder name
     */
    private parseTimestampFromFolderName(folderName: string): string {
        // Format: backup-2024-12-25T14-30-00
        const match = folderName.match(/^backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/);
        if (match && match[1]) {
            // Convert back to ISO format
            return match[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2') + '.000Z';
        }
        return new Date().toISOString();
    }

    /**
     * Get backup info by name
     */
    async getBackupInfo(backupName: string): Promise<BackupInfo | null> {
        const backups = await this.listBackups();
        return backups.find((b) => b.name === backupName) || null;
    }

    /**
     * Get total size of all backups
     */
    async getTotalBackupSize(): Promise<number> {
        const backups = await this.listBackups();
        return backups.reduce((total, backup) => total + backup.totalSize, 0);
    }
}
