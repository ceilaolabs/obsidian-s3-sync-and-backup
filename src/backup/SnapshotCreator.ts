/**
 * Snapshot Creator Module
 *
 * Creates a complete, point-in-time copy of the entire Obsidian vault in S3. Each
 * backup is stored in a timestamped folder under the configured backup prefix:
 *
 * ```
 * {backupPrefix}/
 *   backup-2024-12-25T14-30-00/
 *     Notes/my-note.md
 *     Attachments/image.png
 *     .backup-manifest.json    ← checksums + metadata for integrity verification
 * ```
 *
 * ## Encryption
 * When `settings.encryptionEnabled` is `true` and an encryption key has been provided
 * via `setEncryptionKey()`, every file is encrypted with XSalsa20-Poly1305 before
 * upload. The manifest's `encrypted` flag reflects this so `BackupDownloader` knows
 * to decrypt on restore.
 *
 * ## Manifest
 * After all files are uploaded, a `.backup-manifest.json` is written containing
 * SHA-256 checksums for every file, enabling post-restore integrity verification.
 * The manifest is always stored in plain JSON (never encrypted) so it can be read
 * without the encryption key to inspect the backup's metadata.
 *
 * ## Exclude patterns
 * Files matching any glob in `settings.excludePatterns` are skipped. Errors uploading
 * individual files are collected in `BackupResult.errors` rather than aborting the
 * entire snapshot — the backup is marked `success: false` only if any file errored.
 */

import { App, TFile } from 'obsidian';
import { S3Provider } from '../storage/S3Provider';
import { hashContent } from '../crypto/Hasher';
import { encrypt } from '../crypto/FileEncryptor';
import { BackupManifest, BackupResult, S3SyncBackupSettings } from '../types';
import { addPrefix, matchesAnyGlob, normalizePrefix } from '../utils/paths';
import { readVaultFile } from '../utils/vaultFiles';

/**
 * Creates full vault backup snapshots in S3.
 *
 * Each call to `createSnapshot()` produces a self-contained backup folder in S3
 * containing every non-excluded vault file plus a `.backup-manifest.json` with
 * SHA-256 checksums. The folder name encodes the creation timestamp so backups are
 * naturally sortable and human-readable in the S3 console.
 *
 * Consumers of this class are responsible for:
 * - Providing the encryption key before calling `createSnapshot()` if encryption is enabled.
 * - Calling `updateSettings()` whenever plugin settings change.
 *
 * @example
 * ```typescript
 * const creator = new SnapshotCreator(app, s3Provider, settings);
 * creator.setEncryptionKey(derivedKey);
 * const result = await creator.createSnapshot(deviceId, deviceName);
 * if (!result.success) console.error(result.errors);
 * ```
 */
export class SnapshotCreator {
    private app: App;
    private s3Provider: S3Provider;
    private settings: S3SyncBackupSettings;
    private encryptionKey: Uint8Array | null = null;
    private normalizedBackupPrefix: string;

    /**
     * Creates a new SnapshotCreator instance.
     *
     * @param app - The Obsidian App instance. Used to enumerate vault files via
     *   `app.vault.getFiles()` and read their contents.
     * @param s3Provider - Configured S3 provider used for all upload operations.
     * @param settings - Current plugin settings. `backupPrefix`, `encryptionEnabled`,
     *   `excludePatterns`, and `debugLogging` are all consumed here.
     */
    constructor(app: App, s3Provider: S3Provider, settings: S3SyncBackupSettings) {
        this.app = app;
        this.s3Provider = s3Provider;
        this.settings = settings;
        this.normalizedBackupPrefix = normalizePrefix(settings.backupPrefix);
    }

    /**
     * Set or clear the encryption key used to encrypt backup files.
     *
     * Must be called before `createSnapshot()` if `settings.encryptionEnabled` is
     * `true`. Pass `null` to disable encryption (e.g., when the user removes their
     * passphrase).
     *
     * @param key - A 32-byte XSalsa20-Poly1305 encryption key derived from the user's
     *   passphrase via Argon2id, or `null` to disable encryption.
     */
    setEncryptionKey(key: Uint8Array | null): void {
        this.encryptionKey = key;
    }

    /**
     * Apply updated plugin settings.
     *
     * Re-normalizes the backup prefix so subsequent snapshots use the correct S3 key
     * prefix. Should be called whenever the user changes settings.
     *
     * @param settings - The new plugin settings. Replaces the current settings in full.
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;
        this.normalizedBackupPrefix = normalizePrefix(settings.backupPrefix);
    }

    /**
     * Create a full vault snapshot and upload it to S3.
     *
     * Iterates over every file in the vault, skips files matching `excludePatterns`,
     * uploads each file (optionally encrypted), computes a SHA-256 checksum per file,
     * and finally uploads a `.backup-manifest.json` containing all checksums and
     * metadata.
     *
     * Individual file upload failures are captured in `result.errors` rather than
     * aborting the snapshot. The returned `BackupResult.success` is `true` only when
     * no file errors occurred.
     *
     * @param deviceId - Stable unique identifier for the device creating the backup.
     *   Stored in the manifest to trace which device produced the backup.
     * @param deviceName - Human-readable device name for display in the manifest.
     * @returns A `BackupResult` describing the outcome: backup name, file count,
     *   total size, any per-file errors, and start/end timestamps.
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
                console.debug(`[S3 Backup] Snapshot created: ${backupName}, ${result.filesBackedUp} files`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            result.errors.push(`Backup failed: ${errorMessage}`);
        }

        result.completedAt = Date.now();
        return result;
    }

    /**
     * Generate a unique, sortable backup folder name based on the current timestamp.
     *
     * The ISO 8601 timestamp is used as the basis, but colons (`:`) are replaced with
     * hyphens (`-`) because colons are not valid in S3 object key path components on
     * some S3-compatible providers and cause issues in URLs. Milliseconds and the `Z`
     * suffix are also stripped for brevity.
     *
     * Example output: `backup-2024-12-25T14-30-00`
     *
     * @returns A string of the form `backup-{YYYY-MM-DDTHH-mm-ss}`.
     */
    private generateBackupName(): string {
        const now = new Date();
        // Replace colons with hyphens for S3 key compatibility — colons are not valid
        // in path segments on some S3-compatible providers and break URL parsing.
        const isoString = now.toISOString()
            .replace(/:/g, '-')
            .replace(/\.\d{3}Z$/, '');
        return `backup-${isoString}`;
    }

    /**
     * Read, optionally encrypt, compute the checksum for, and upload a single vault file.
     *
     * The SHA-256 checksum is always computed from the **plaintext** bytes so it can be
     * used for integrity verification after decryption on restore. The checksum is stored
     * in the `checksums` map under the file's vault-relative path with a `sha256:` prefix.
     *
     * @param file - The vault file to back up.
     * @param backupName - The backup folder name (e.g., `backup-2024-12-25T14-30-00`).
     *   Used to construct the S3 key: `{backupPrefix}/{backupName}/{file.path}`.
     * @param checksums - Mutable map accumulating `filePath → "sha256:{hex}"` entries.
     *   Updated in place so the caller can build the manifest after all files are done.
     * @throws Any S3 upload error or vault read error — caller should catch and record
     *   in `BackupResult.errors`.
     */
    private async backupFile(
        file: TFile,
        backupName: string,
        checksums: Record<string, string>
    ): Promise<void> {
        const content = await readVaultFile(this.app.vault, file);
        const contentBytes = typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content;

        // Calculate checksum
        const checksum = await hashContent(contentBytes);
        checksums[file.path] = `sha256:${checksum}`;

        // Prepare upload content
        let uploadContent: Uint8Array | string = typeof content === 'string' ? content : contentBytes;

        // Encrypt if enabled
        if (this.settings.encryptionEnabled && this.encryptionKey) {
            uploadContent = encrypt(contentBytes, this.encryptionKey);
        }

        // Build S3 key
        const key = addPrefix(`${backupName}/${file.path}`, this.normalizedBackupPrefix);

        // Upload to S3
        await this.s3Provider.uploadFile(key, uploadContent);
    }

    /**
     * Serialize and upload the backup manifest to S3.
     *
     * The manifest is stored at `{backupPrefix}/{backupName}/.backup-manifest.json` as
     * pretty-printed JSON with `Content-Type: application/json`. It is **never encrypted**
     * regardless of `encryptionEnabled`, so backup metadata (file count, timestamps, etc.)
     * can always be read without the passphrase — e.g., by `RetentionManager` when
     * deciding which backups to delete.
     *
     * ## Manifest structure (`BackupManifest`)
     * ```json
     * {
     *   "version": 1,
     *   "timestamp": "2024-12-25T14:30:00.000Z",
     *   "deviceId": "abc-123",
     *   "deviceName": "My MacBook",
     *   "fileCount": 342,
     *   "totalSize": 15728640,
     *   "encrypted": true,
     *   "checksums": {
     *     "Notes/my-note.md": "sha256:deadbeef...",
     *     ...
     *   }
     * }
     * ```
     *
     * @param backupName - The backup folder name (e.g., `backup-2024-12-25T14-30-00`).
     * @param manifest - The fully populated `BackupManifest` object to serialize.
     * @throws Any S3 upload error.
     */
    private async uploadManifest(backupName: string, manifest: BackupManifest): Promise<void> {
        const key = addPrefix(`${backupName}/.backup-manifest.json`, this.normalizedBackupPrefix);
        const content = JSON.stringify(manifest, null, 2);
        await this.s3Provider.uploadFile(key, content, { contentType: 'application/json' });
    }

    /**
     * Determine whether a vault file path should be excluded from the snapshot.
     *
     * Delegates to `matchesAnyGlob` with the configured `excludePatterns`. If any
     * pattern matches, the file is silently skipped.
     *
     * @param path - The vault-relative file path to test (e.g., `Notes/my-note.md`).
     * @returns `true` if the path matches at least one exclude pattern, `false` otherwise.
     */
    private shouldExclude(path: string): boolean {
        return matchesAnyGlob(path, this.settings.excludePatterns);
    }
}
