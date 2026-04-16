/**
 * Backup Downloader Module
 *
 * Downloads backup snapshots from S3 and packages them as ZIP files for browser-side
 * download. Handles transparent decryption when the backup was created with
 * end-to-end encryption enabled.
 *
 * ## Download flow
 * ```
 * triggerDownload(backupName)
 *   → createDownloadBlob(backupName)
 *       → downloadBackup(backupName)     (fetch all files from S3, decrypt if needed)
 *       → JSZip.generateAsync()          (pack into a single ZIP blob)
 *   → triggerDownload()                  (standard browser anchor-click technique)
 * ```
 *
 * ## Encryption
 * The manifest is always downloaded first to check its `encrypted` flag. If `true`
 * and an encryption key has been provided via `setEncryptionKey()`, each file is
 * decrypted with XSalsa20-Poly1305 after download. The manifest itself is never
 * encrypted, so it can be read regardless of whether the key is available.
 *
 * ## ZIP structure
 * The generated ZIP mirrors the original vault layout:
 * ```
 * backup-2024-12-25T14-30-00.zip
 *   Notes/my-note.md
 *   Attachments/image.png
 *   .backup-manifest.json
 * ```
 */

import { S3Provider } from '../storage/S3Provider';
import { decrypt } from '../crypto/FileEncryptor';
import { S3SyncBackupSettings, BackupManifest } from '../types';
import { addPrefix, normalizePrefix, removePrefix } from '../utils/paths';
import JSZip from 'jszip';

/**
 * Downloads backup snapshots from S3, decrypts them if necessary, and packages
 * them as browser-downloadable ZIP files.
 *
 * Callers must provide an encryption key via `setEncryptionKey()` before downloading
 * encrypted backups. If the key is absent and the backup is encrypted, file content
 * will be raw ciphertext inside the ZIP.
 *
 * @example
 * ```typescript
 * const downloader = new BackupDownloader(s3Provider, settings);
 * downloader.setEncryptionKey(derivedKey);
 * await downloader.triggerDownload('backup-2024-12-25T14-30-00');
 * // → browser file-save dialog opens with the ZIP
 * ```
 */
export class BackupDownloader {
    private s3Provider: S3Provider;
    private settings: S3SyncBackupSettings;
    private encryptionKey: Uint8Array | null = null;
    private normalizedBackupPrefix: string;

    /**
     * Creates a new BackupDownloader instance.
     *
     * @param s3Provider - Configured S3 provider used for all download and list operations.
     * @param settings - Current plugin settings. `backupPrefix` and `debugLogging` are consumed.
     */
    constructor(s3Provider: S3Provider, settings: S3SyncBackupSettings) {
        this.s3Provider = s3Provider;
        this.settings = settings;
        this.normalizedBackupPrefix = normalizePrefix(settings.backupPrefix);
    }

    /**
     * Set or clear the encryption key used to decrypt backup files on download.
     *
     * Must be called before downloading encrypted backups. Pass `null` to clear the
     * key (e.g., when the user removes their passphrase), in which case encrypted
     * file content will be downloaded as raw ciphertext.
     *
     * @param key - A 32-byte XSalsa20-Poly1305 decryption key derived from the user's
     *   passphrase via Argon2id, or `null` to disable decryption.
     */
    setEncryptionKey(key: Uint8Array | null): void {
        this.encryptionKey = key;
    }

    /**
     * Apply updated plugin settings.
     *
     * Re-normalizes the backup prefix so subsequent operations use the correct S3 key
     * prefix. Should be called whenever the user changes settings.
     *
     * @param settings - The new plugin settings. Replaces the current settings in full.
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;
        this.normalizedBackupPrefix = normalizePrefix(settings.backupPrefix);
    }

    /**
     * Fetch and parse the `.backup-manifest.json` for a given backup.
     *
     * The manifest is always stored as plain JSON (never encrypted) so it is readable
     * without the encryption key. It contains metadata about the backup including
     * whether encryption was used, file count, total size, and per-file SHA-256 checksums.
     *
     * @param backupName - The backup folder name (e.g., `backup-2024-12-25T14-30-00`).
     * @returns The parsed `BackupManifest` object.
     * @throws If the manifest object does not exist in S3 or cannot be parsed as JSON.
     */
    async getManifest(backupName: string): Promise<BackupManifest> {
        const key = addPrefix(`${backupName}/.backup-manifest.json`, this.normalizedBackupPrefix);
        const manifestJson = await this.s3Provider.downloadFileAsText(key);
        return JSON.parse(manifestJson) as BackupManifest;
    }

    /**
     * Download and optionally decrypt a single file from a backup snapshot.
     *
     * Fetches the manifest first to determine whether the backup was encrypted, then
     * downloads the requested file and decrypts it if needed. For bulk downloads,
     * prefer `downloadBackup()` which amortizes the manifest fetch across all files.
     *
     * @param backupName - The backup folder name containing the file.
     * @param filePath - The vault-relative path of the file (e.g., `Notes/my-note.md`).
     * @returns The decrypted (or raw, if unencrypted) file content as a `Uint8Array`.
     * @throws If the file or manifest cannot be downloaded from S3, or if decryption fails.
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
     * Download all files in a backup snapshot and return them as a path-to-content map.
     *
     * The manifest is fetched once upfront to determine the encryption flag, then all
     * S3 objects in the backup folder are listed and downloaded in sequence. The manifest
     * file itself is excluded from the returned map — it is handled separately in
     * `createDownloadBlob()` and added to the ZIP without modification, since it is
     * always stored as plain (unencrypted) JSON.
     *
     * @param backupName - The backup folder name (e.g., `backup-2024-12-25T14-30-00`).
     * @returns A `Map<string, Uint8Array>` from vault-relative file path to decrypted
     *   (or raw) file content. Files that fail to download are silently skipped and
     *   logged to the console.
     * @throws If the manifest fetch or the initial `listObjects` call fails.
     */
    async downloadBackup(backupName: string): Promise<Map<string, Uint8Array>> {
        const files = new Map<string, Uint8Array>();

        // Fetch the manifest once so we know the encryption flag for all files.
        // The manifest itself is skipped during file iteration and re-added separately
        // in createDownloadBlob() to ensure it is always included unencrypted in the ZIP.
        const manifest = await this.getManifest(backupName);

        // List all files in backup
        const prefix = addPrefix(`${backupName}`, this.normalizedBackupPrefix);
        const prefixWithSlash = `${prefix}/`;
        const objects = await this.s3Provider.listObjects(prefix, true);

        for (const obj of objects) {
            // Skip manifest — it is added separately by createDownloadBlob()
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
     * Download an entire backup snapshot and package it as a ZIP `Blob`.
     *
     * Downloads all vault files via `downloadBackup()` (with decryption if needed),
     * then adds each file to a JSZip archive. The `.backup-manifest.json` is fetched
     * separately and added as plain JSON so the ZIP always contains an unencrypted
     * manifest for inspection.
     *
     * @param backupName - The backup folder name to package (e.g., `backup-2024-12-25T14-30-00`).
     * @returns A `Blob` of type `application/zip` containing all backup files plus the manifest.
     * @throws If any S3 download fails or ZIP generation fails.
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
     * Trigger a browser file-save dialog to download the specified backup as a ZIP.
     *
     * Uses the standard browser download technique:
     * 1. Create an object URL from the ZIP blob via `URL.createObjectURL`.
     * 2. Programmatically create an `<a>` element with `download` attribute set.
     * 3. Append it to `document.body`, click it, then immediately remove it.
     * 4. Revoke the object URL to free memory.
     *
     * This is necessary because there is no native browser API to trigger a file save
     * dialog directly — the anchor-click pattern is the standard cross-browser approach.
     *
     * @param backupName - The backup folder name to download (e.g., `backup-2024-12-25T14-30-00`).
     *   The downloaded file will be named `{backupName}.zip`.
     * @throws If `createDownloadBlob()` fails (e.g., S3 errors, decryption errors).
     */
    async triggerDownload(backupName: string): Promise<void> {
        const blob = await this.createDownloadBlob(backupName);

        // Standard browser download technique: create a temporary object URL, attach it
        // to a hidden <a> element, programmatically click it, then immediately clean up.
        // This is the only cross-browser way to trigger a file-save dialog from JS.
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
