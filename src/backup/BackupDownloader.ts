/**
 * Backup Downloader Module
 *
 * Downloads backup snapshots and packages them as ZIP files.
 */

import { S3Provider } from '../storage/S3Provider';
import { decrypt } from '../crypto/FileEncryptor';
import { S3SyncBackupSettings, BackupManifest } from '../types';

/**
 * BackupDownloader class - Downloads and packages backups
 */
export class BackupDownloader {
    private s3Provider: S3Provider;
    private settings: S3SyncBackupSettings;
    private encryptionKey: Uint8Array | null = null;

    constructor(s3Provider: S3Provider, settings: S3SyncBackupSettings) {
        this.s3Provider = s3Provider;
        this.settings = settings;
    }

    /**
     * Set encryption key for decrypting backups
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
     * Download backup manifest
     */
    async getManifest(backupName: string): Promise<BackupManifest> {
        const key = `${this.settings.backupPrefix}/${backupName}/.backup-manifest.json`;
        const manifestJson = await this.s3Provider.downloadFileAsText(key);
        return JSON.parse(manifestJson);
    }

    /**
     * Download a single file from backup
     */
    async downloadFile(backupName: string, filePath: string): Promise<Uint8Array> {
        const key = `${this.settings.backupPrefix}/${backupName}/${filePath}`;
        let content = await this.s3Provider.downloadFile(key);

        // Check if backup was encrypted
        const manifest = await this.getManifest(backupName);
        if (manifest.encrypted && this.encryptionKey) {
            content = decrypt(content, this.encryptionKey);
        }

        return content;
    }

    /**
     * Download entire backup as a map of path -> content
     */
    async downloadBackup(backupName: string): Promise<Map<string, Uint8Array>> {
        const files = new Map<string, Uint8Array>();

        // Get manifest
        const manifest = await this.getManifest(backupName);

        // List all files in backup
        const prefix = `${this.settings.backupPrefix}/${backupName}/`;
        const objects = await this.s3Provider.listObjects(prefix, true);

        for (const obj of objects) {
            // Skip manifest
            if (obj.key.endsWith('.backup-manifest.json')) continue;

            // Extract relative path
            const relativePath = obj.key.substring(prefix.length);

            try {
                let content = await this.s3Provider.downloadFile(obj.key);

                // Decrypt if needed
                if (manifest.encrypted && this.encryptionKey) {
                    content = decrypt(content, this.encryptionKey);
                }

                files.set(relativePath, content);
            } catch (error) {
                console.error(`Failed to download ${relativePath}:`, error);
            }
        }

        return files;
    }

    /**
     * Create a downloadable blob from backup files
     * Note: This creates a simple concatenated format, not a real ZIP
     * For real ZIP support, would need to add a ZIP library
     */
    async createDownloadBlob(backupName: string): Promise<Blob> {
        const files = await this.downloadBackup(backupName);

        // For now, create a simple text representation
        // In production, you'd use a ZIP library like JSZip
        const textContent: string[] = [];

        textContent.push(`Backup: ${backupName}`);
        textContent.push(`Files: ${files.size}`);
        textContent.push('---');

        for (const [path, content] of files) {
            textContent.push(`\n=== ${path} ===\n`);
            try {
                textContent.push(new TextDecoder().decode(content));
            } catch {
                textContent.push(`[Binary file: ${content.length} bytes]`);
            }
        }

        return new Blob([textContent.join('\n')], { type: 'text/plain' });
    }

    /**
     * Trigger browser download of backup
     */
    async triggerDownload(backupName: string): Promise<void> {
        const blob = await this.createDownloadBlob(backupName);

        // Create download link
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${backupName}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
}
