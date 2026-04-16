/**
 * Retention Manager Module
 *
 * Enforces backup retention policies by discovering existing backups in S3 and
 * deleting those that exceed the configured limit. Two retention modes are supported:
 *
 * - **`days`** — Delete any backup whose timestamp is older than `retentionDays` days.
 * - **`copies`** — Keep only the `retentionCopies` most-recent backups; delete the rest.
 *
 * ## Discovery strategy
 * Rather than maintaining a side-car index, the manager lists all S3 objects under the
 * backup prefix, extracts unique `backup-*` folder names from the key paths, and then
 * loads each folder's `.backup-manifest.json` to obtain accurate metadata (file count,
 * total size, timestamp). If a manifest cannot be read (e.g., partial upload), the
 * manager falls back to parsing the timestamp from the folder name itself so the backup
 * can still participate in retention decisions.
 *
 * ## Deletion
 * Backup folders are deleted by calling `S3Provider.deletePrefix()`, which removes all
 * objects sharing the folder prefix in a single batched operation.
 */

import { S3Provider } from '../storage/S3Provider';
import { S3SyncBackupSettings, BackupInfo, BackupManifest } from '../types';
import { addPrefix, normalizePrefix } from '../utils/paths';

/**
 * Enforces backup retention policies against an S3-backed backup store.
 *
 * After each successful snapshot (`SnapshotCreator.createSnapshot()`), the backup
 * workflow calls `applyRetentionPolicy()` to prune excess or stale backups according
 * to the user's configured mode (`days` or `copies`).
 *
 * Settings are applied at construction time and can be refreshed via `updateSettings()`.
 *
 * @example
 * ```typescript
 * const retention = new RetentionManager(s3Provider, settings);
 * const deleted = await retention.applyRetentionPolicy();
 * console.log(`Pruned ${deleted} old backups`);
 * ```
 */
export class RetentionManager {
    private s3Provider: S3Provider;
    private settings: S3SyncBackupSettings;
    private normalizedBackupPrefix: string;

    /**
     * Creates a new RetentionManager instance.
     *
     * @param s3Provider - Configured S3 provider used for listing and deleting backups.
     * @param settings - Current plugin settings. `retentionEnabled`, `retentionMode`,
     *   `retentionDays`, `retentionCopies`, `backupPrefix`, and `debugLogging` are consumed.
     */
    constructor(s3Provider: S3Provider, settings: S3SyncBackupSettings) {
        this.s3Provider = s3Provider;
        this.settings = settings;
        this.normalizedBackupPrefix = normalizePrefix(settings.backupPrefix);
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
     * Apply the configured retention policy and delete excess backups.
     *
     * Returns early with `0` if retention is disabled (`settings.retentionEnabled` is
     * `false`). Otherwise lists all backups, sorts them newest-first, determines which
     * ones to delete based on the active mode, and deletes them.
     *
     * - **`days` mode**: deletes backups whose timestamp is earlier than
     *   `now - (retentionDays × 24h)`.
     * - **`copies` mode**: keeps the `retentionCopies` most-recent backups and deletes
     *   any beyond that count.
     *
     * @returns The number of backup folders deleted. Returns `0` if retention is
     *   disabled or no backups qualify for deletion.
     * @throws Any S3 error from `listBackups()` or `deleteBackup()`.
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
            console.debug(`[S3 Backup] Retention: deleted ${toDelete.length} old backups`);
        }

        return toDelete.length;
    }

    /**
     * List all backup snapshots found in S3 under the configured backup prefix.
     *
     * ## Discovery logic
     * 1. Lists all S3 objects under `{backupPrefix}/` (recursive).
     * 2. Strips the prefix from each key, extracts the first path component, and
     *    collects unique folder names that start with `backup-`.
     * 3. For each unique folder, attempts to download and parse its
     *    `.backup-manifest.json` to populate accurate `fileCount`, `totalSize`,
     *    `timestamp`, and `encrypted` values.
     * 4. If the manifest cannot be read (e.g., partial or corrupt backup), falls back
     *    to `parseTimestampFromFolderName()` and returns a stub `BackupInfo` with
     *    zero file count/size so the backup can still be considered for deletion.
     *
     * @returns Array of `BackupInfo` objects, one per discovered backup folder.
     *   Order is not guaranteed — callers should sort as needed.
     * @throws Any S3 error from the initial `listObjects` call.
     */
    async listBackups(): Promise<BackupInfo[]> {
        const prefix = this.normalizedBackupPrefix;
        const prefixWithSlash = prefix ? `${prefix}/` : '';
        const objects = await this.s3Provider.listObjects(prefixWithSlash, true);

        // Scan all S3 objects to extract unique "backup-*" folder names. Each object
        // key is relative to the backup prefix; the first path segment is the folder.
        const backupFolders = new Set<string>();
        const manifestKeys: string[] = [];

        for (const obj of objects) {
            // Extract backup folder name from key
            const relativePath = obj.key.substring(prefixWithSlash.length);
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
            const manifestKey = addPrefix(`${folder}/.backup-manifest.json`, this.normalizedBackupPrefix);

            try {
                const manifestJson = await this.s3Provider.downloadFileAsText(manifestKey);
                const manifest = JSON.parse(manifestJson) as BackupManifest;

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
     * Delete all S3 objects belonging to the specified backup folder.
     *
     * Delegates to `S3Provider.deletePrefix()` which performs a batched delete of
     * every object whose key starts with `{backupPrefix}/{backupName}/`.
     *
     * @param backupName - The backup folder name to delete (e.g., `backup-2024-12-25T14-30-00`).
     * @throws Any S3 error from the delete operation.
     */
    async deleteBackup(backupName: string): Promise<void> {
        const prefix = addPrefix(`${backupName}/`, this.normalizedBackupPrefix);
        await this.s3Provider.deletePrefix(prefix);
    }

    /**
     * Derive an ISO 8601 timestamp string from a backup folder name.
     *
     * Backup folder names are produced by `SnapshotCreator.generateBackupName()` which
     * replaces colons with hyphens for S3 key compatibility. This method reverses that
     * transformation to recover a valid ISO 8601 timestamp.
     *
     * The regex `/^backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/` matches the
     * expected `backup-YYYY-MM-DDTHH-mm-ss` format and captures the timestamp portion.
     * The trailing `-HH-mm` is then converted back to `:HH:mm` by replacing the last
     * two hyphen-separated groups, and `.000Z` is appended for a complete ISO string.
     *
     * Falls back to `new Date().toISOString()` if the folder name doesn't match the
     * expected pattern (e.g., manually created folders), so retention decisions can
     * still proceed without crashing.
     *
     * @param folderName - The raw backup folder name (e.g., `backup-2024-12-25T14-30-00`).
     * @returns An ISO 8601 timestamp string (e.g., `2024-12-25T14:30:00.000Z`), or the
     *   current time as a fallback if parsing fails.
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
     * Retrieve the `BackupInfo` for a single backup by name.
     *
     * Convenience wrapper around `listBackups()` — performs a full S3 list and manifest
     * load, then returns only the entry matching `backupName`. For repeated lookups,
     * consider calling `listBackups()` once and searching the result yourself.
     *
     * @param backupName - The backup folder name to look up (e.g., `backup-2024-12-25T14-30-00`).
     * @returns The matching `BackupInfo`, or `null` if no backup with that name exists.
     * @throws Any S3 error from the underlying `listBackups()` call.
     */
    async getBackupInfo(backupName: string): Promise<BackupInfo | null> {
        const backups = await this.listBackups();
        return backups.find((b) => b.name === backupName) || null;
    }

    /**
     * Calculate the combined size of all backup snapshots in S3.
     *
     * Sums the `totalSize` field from each backup's manifest. Backups whose manifests
     * could not be read (fallback stubs) contribute `0` to the total.
     *
     * @returns Total size in bytes across all discovered backups.
     * @throws Any S3 error from the underlying `listBackups()` call.
     */
    async getTotalBackupSize(): Promise<number> {
        const backups = await this.listBackups();
        return backups.reduce((total, backup) => total + backup.totalSize, 0);
    }
}
