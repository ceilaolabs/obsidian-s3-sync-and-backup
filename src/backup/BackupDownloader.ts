/**
 * Backup Downloader Module
 *
 * Downloads backup snapshots and packages them as ZIP files.
 */

import { S3Provider } from '../storage/S3Provider';
import { decrypt } from '../crypto/FileEncryptor';
import { S3SyncBackupSettings, BackupManifest } from '../types';
import { addPrefix, normalizePrefix, removePrefix } from '../utils/paths';
import JSZip from 'jszip';

/**
 * BackupDownloader class - Downloads and packages backups
 */
export class BackupDownloader {
    private s3Provider: S3Provider;
    private settings: S3SyncBackupSettings;
    private encryptionKey: Uint8Array | null = null;
    private normalizedBackupPrefix: string;

    constructor(s3Provider: S3Provider, settings: S3SyncBackupSettings) {
        this.s3Provider = s3Provider;
        this.settings = settings;
        this.normalizedBackupPrefix = normalizePrefix(settings.backupPrefix);
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
        this.normalizedBackupPrefix = normalizePrefix(settings.backupPrefix);
    }

    /**
     * Download backup manifest
     */
    async getManifest(backupName: string): Promise<BackupManifest> {
        const key = addPrefix(`${backupName}/.backup-manifest.json`, this.normalizedBackupPrefix);
        const manifestJson = await this.s3Provider.downloadFileAsText(key);
        return JSON.parse(manifestJson) as BackupManifest;
    }

    /**
     * Download a single file from backup
     */
    async downloadFile(backupName: string, filePath: string): Promise<Uint8Array> {
        const key = addPrefix(`${backupName}/${filePath}`, this.normalizedBackupPrefix);
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
        const prefix = addPrefix(`${backupName}`, this.normalizedBackupPrefix);
        const prefixWithSlash = `${prefix}/`;
        const objects = await this.s3Provider.listObjects(prefix, true);

        for (const obj of objects) {
            // Skip manifest
            if (obj.key.endsWith('.backup-manifest.json')) continue;

            // Extract relative path
            const relativePath = removePrefix(obj.key, prefix) ?? removePrefix(obj.key, prefixWithSlash) ?? '';
            if (!relativePath) continue;

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
     */
    async createDownloadBlob(backupName: string): Promise<Blob> {
        const files = await this.downloadBackup(backupName);
        const zip = new JSZip();

        for (const [path, content] of files) {
            zip.file(path, content);
        }

        const manifest = await this.getManifest(backupName);
        zip.file('.backup-manifest.json', JSON.stringify(manifest, null, 2));

        return await zip.generateAsync({ type: 'blob' });
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
        link.download = `${backupName}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
}
