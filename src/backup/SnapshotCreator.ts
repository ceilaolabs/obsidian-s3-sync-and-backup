/**
 * Snapshot Creator Module
 *
 * Creates full vault backup snapshots with timestamp-based folders.
 * Generates backup manifest with file checksums.
 */

import { App, TFile } from 'obsidian';
import { S3Provider } from '../storage/S3Provider';
import { hashContent } from '../crypto/Hasher';
import { encrypt } from '../crypto/FileEncryptor';
import { BackupManifest, BackupResult, S3SyncBackupSettings } from '../types';

/**
 * SnapshotCreator class - Creates backup snapshots
 */
export class SnapshotCreator {
    private app: App;
    private s3Provider: S3Provider;
    private settings: S3SyncBackupSettings;
    private encryptionKey: Uint8Array | null = null;

    constructor(app: App, s3Provider: S3Provider, settings: S3SyncBackupSettings) {
        this.app = app;
        this.s3Provider = s3Provider;
        this.settings = settings;
    }

    /**
     * Set encryption key for encrypted backups
     */
    setEncryptionKey(key: Uint8Array | null): void {
        this.encryptionKey = key;
    }

    /**
     * Update settings
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;
    }

    /**
     * Create a backup snapshot
     */
    async createSnapshot(deviceId: string, deviceName: string): Promise<BackupResult> {
        const startedAt = Date.now();
        const backupName = this.generateBackupName();

        const result: BackupResult = {
            success: false,
            backupName,
            startedAt,
            completedAt: 0,
            filesBackedUp: 0,
            totalSize: 0,
            errors: [],
        };

        try {
            // Get all vault files
            const files = this.app.vault.getFiles();
            const checksums: Record<string, string> = {};

            // Upload each file
            for (const file of files) {
                // Check exclude patterns
                if (this.shouldExclude(file.path)) continue;

                try {
                    await this.backupFile(file, backupName, checksums);
                    result.filesBackedUp++;
                    result.totalSize += file.stat.size;
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    result.errors.push(`${file.path}: ${errorMessage}`);
                }
            }

            // Create and upload manifest
            const manifest: BackupManifest = {
                version: 1,
                timestamp: new Date().toISOString(),
                deviceId,
                deviceName,
                fileCount: result.filesBackedUp,
                totalSize: result.totalSize,
                encrypted: this.settings.encryptionEnabled && this.encryptionKey !== null,
                checksums,
            };

            await this.uploadManifest(backupName, manifest);

            result.success = result.errors.length === 0;

            if (this.settings.debugLogging) {
                console.log(`[S3 Backup] Snapshot created: ${backupName}, ${result.filesBackedUp} files`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            result.errors.push(`Backup failed: ${errorMessage}`);
        }

        result.completedAt = Date.now();
        return result;
    }

    /**
     * Generate backup folder name with timestamp
     */
    private generateBackupName(): string {
        const now = new Date();
        const isoString = now.toISOString()
            .replace(/:/g, '-')
            .replace(/\.\d{3}Z$/, '');
        return `backup-${isoString}`;
    }

    /**
     * Backup a single file
     */
    private async backupFile(
        file: TFile,
        backupName: string,
        checksums: Record<string, string>
    ): Promise<void> {
        // Read file content
        const content = await this.app.vault.read(file);
        const contentBytes = new TextEncoder().encode(content);

        // Calculate checksum
        const checksum = await hashContent(contentBytes);
        checksums[file.path] = `sha256:${checksum}`;

        // Prepare upload content
        let uploadContent: Uint8Array | string = content;

        // Encrypt if enabled
        if (this.settings.encryptionEnabled && this.encryptionKey) {
            uploadContent = encrypt(contentBytes, this.encryptionKey);
        }

        // Build S3 key
        const key = `${this.settings.backupPrefix}/${backupName}/${file.path}`;

        // Upload to S3
        await this.s3Provider.uploadFile(key, uploadContent);
    }

    /**
     * Upload backup manifest
     */
    private async uploadManifest(backupName: string, manifest: BackupManifest): Promise<void> {
        const key = `${this.settings.backupPrefix}/${backupName}/.backup-manifest.json`;
        const content = JSON.stringify(manifest, null, 2);
        await this.s3Provider.uploadFile(key, content, 'application/json');
    }

    /**
     * Check if path should be excluded from backup
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
}
