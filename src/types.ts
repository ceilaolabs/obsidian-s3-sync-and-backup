/**
 * Obsidian S3 Sync & Backup - Type Definitions
 *
 * This file contains all TypeScript interfaces and types used throughout the plugin.
 * Organized by domain: Settings, Sync, Backup, Crypto, and Storage.
 */

// =============================================================================
// S3 Provider Types
// =============================================================================

/**
 * Supported S3-compatible storage providers
 */
export type S3ProviderType = 'aws' | 'minio' | 'r2' | 'custom';

/**
 * Provider display names for UI
 */
export const S3_PROVIDER_NAMES: Record<S3ProviderType, string> = {
	aws: 'AWS S3',
	minio: 'MinIO',
	r2: 'Cloudflare R2',
	custom: 'Custom S3-compatible',
};

// =============================================================================
// Settings Types
// =============================================================================

/**
 * Sync interval options in minutes
 */
export type SyncIntervalMinutes = 1 | 2 | 5 | 10 | 15 | 30;

/**
 * Backup interval options
 */
export type BackupInterval = '1hour' | '6hours' | '12hours' | '1day' | '3days' | '1week';

/**
 * Backup interval in milliseconds mapping
 */
export const BACKUP_INTERVAL_MS: Record<BackupInterval, number> = {
	'1hour': 60 * 60 * 1000,
	'6hours': 6 * 60 * 60 * 1000,
	'12hours': 12 * 60 * 60 * 1000,
	'1day': 24 * 60 * 60 * 1000,
	'3days': 3 * 24 * 60 * 60 * 1000,
	'1week': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Backup interval display names for UI
 */
export const BACKUP_INTERVAL_NAMES: Record<BackupInterval, string> = {
	'1hour': 'Every hour',
	'6hours': 'Every 6 hours',
	'12hours': 'Every 12 hours',
	'1day': 'Daily (24h)',
	'3days': 'Every 3 days',
	'1week': 'Weekly',
};

/**
 * Retention policy mode
 */
export type RetentionMode = 'days' | 'copies';

/**
 * Complete plugin settings interface
 * Note: Passphrase is NEVER stored - only derived key kept in memory during session
 */
export interface S3SyncBackupSettings {
	// Connection
	provider: S3ProviderType;
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;

	// Encryption
	encryptionEnabled: boolean;
	// Note: passphrase never stored, only derived key in memory

	// Sync
	syncEnabled: boolean;
	syncPrefix: string;
	autoSyncEnabled: boolean;
	syncIntervalMinutes: SyncIntervalMinutes;
	syncOnStartup: boolean;

	// Backup
	backupEnabled: boolean;
	backupPrefix: string;
	backupInterval: BackupInterval;
	retentionEnabled: boolean;
	retentionMode: RetentionMode;
	retentionDays: number;
	retentionCopies: number;

	// Advanced
	excludePatterns: string[];
	debugLogging: boolean;
}

/**
 * Default settings values
 */
export const DEFAULT_SETTINGS: S3SyncBackupSettings = {
	provider: 'aws',
	endpoint: '',
	region: 'us-east-1',
	bucket: '',
	accessKeyId: '',
	secretAccessKey: '',
	forcePathStyle: false,

	encryptionEnabled: false,

	syncEnabled: true,
	syncPrefix: 'vault',
	autoSyncEnabled: true,
	syncIntervalMinutes: 5,
	syncOnStartup: true,

	backupEnabled: true,
	backupPrefix: 'backups',
	backupInterval: '1day',
	retentionEnabled: false,
	retentionMode: 'copies',
	retentionDays: 30,
	retentionCopies: 30,

	excludePatterns: ['**/workspace*', '.trash/**'],
	debugLogging: false,
};

// =============================================================================
// Sync Types (v2 — three-way reconciliation, no remote manifest)
// =============================================================================

/**
 * File kind used when reading/writing vault content.
 */
export type VaultFileKind = 'text' | 'binary';

/**
 * Action to take for a file during sync.
 *
 * - `skip`          — no changes detected, nothing to do
 * - `adopt`         — local and remote match, record baseline only
 * - `upload`        — push local content to S3
 * - `download`      — pull remote content to vault
 * - `delete-local`  — remote deleted, remove local file
 * - `delete-remote` — local deleted, remove S3 object
 * - `conflict`      — diverged edits, create LOCAL_/REMOTE_ artifacts
 * - `forget`        — both sides absent, clean up stale baseline
 */
export type SyncAction =
	| 'skip'
	| 'adopt'
	| 'upload'
	| 'download'
	| 'delete-local'
	| 'delete-remote'
	| 'conflict'
	| 'forget';

/**
 * Conflict resolution mode.
 *
 * - `both`         — both local and remote changed with different content
 * - `local-only`   — local changed but remote was deleted
 * - `remote-only`  — remote changed but local was deleted
 */
export type ConflictMode = 'both' | 'local-only' | 'remote-only';

/**
 * Per-file sync baseline stored in IndexedDB after a successful sync.
 *
 * This is the "last known synced state" used for three-way comparison.
 * Content identity uses SHA-256 fingerprints of plaintext (or HMAC-SHA-256
 * when encryption is enabled).
 */
export interface SyncStateRecord {
	/** File path relative to vault root (primary key) */
	path: string;
	/** Corresponding S3 object key */
	remoteKey: string;
	/** Content identity: `sha256:<hex>` or `hmac-sha256:<hex>` */
	contentFingerprint: string;
	/** Local file modification time at last sync (epoch ms) */
	localMtime: number;
	/** Local file size at last sync (bytes) */
	localSize: number;
	/** Client-reported mtime stored in S3 metadata (epoch ms), null if unknown */
	remoteClientMtime: number | null;
	/** Size of the remote S3 object (bytes) */
	remoteObjectSize: number;
	/** S3 ETag at last sync — used as revision token only, never as content identity */
	remoteEtag?: string;
	/** S3 LastModified header at last sync (epoch ms), null if unknown */
	remoteLastModified: number | null;
	/** Device ID that last wrote this file to S3 */
	lastWriterDeviceId?: string;
	/** Timestamp when this baseline was recorded (epoch ms) */
	lastSyncedAt: number;
}

/**
 * Unresolved conflict tracked in IndexedDB.
 *
 * Created when the decision table produces a `conflict` action.
 * Removed when the user resolves the conflict (deletes artifacts and
 * restores the original file).
 */
export interface ConflictRecord {
	/** Original file path (primary key) */
	path: string;
	/** Conflict type */
	mode: ConflictMode;
	/** Path to LOCAL_ artifact (if created) */
	localArtifactPath?: string;
	/** Path to REMOTE_ artifact (if created) */
	remoteArtifactPath?: string;
	/** Content fingerprint of the baseline when conflict was detected */
	baselineFingerprint?: string;
	/** Timestamp when conflict was detected (epoch ms) */
	detectedAt: number;
}

/**
 * Planned sync action for a single file.
 *
 * Generated by SyncPlanner, consumed by SyncExecutor.
 */
export interface SyncPlanItem {
	/** File path relative to vault root */
	path: string;
	/** Action to execute */
	action: SyncAction;
	/** Conflict mode (only set when action is 'conflict') */
	conflictMode?: ConflictMode;
	/** Human-readable reason for this action */
	reason: string;
	/** Expected S3 ETag for conditional writes (upload/delete-remote) */
	expectedRemoteEtag?: string;
	/** When true, expects the remote object to be absent (for If-None-Match: *) */
	expectRemoteAbsent?: boolean;
}

/**
 * Result of a complete sync operation.
 */
export interface SyncResult {
	/** Whether the sync completed without errors */
	success: boolean;
	/** Timestamp when sync started (epoch ms) */
	startedAt: number;
	/** Timestamp when sync completed (epoch ms) */
	completedAt: number;
	/** Number of files uploaded to S3 */
	filesUploaded: number;
	/** Number of files downloaded from S3 */
	filesDownloaded: number;
	/** Number of files deleted (local + remote) */
	filesDeleted: number;
	/** Number of baselines adopted without data transfer */
	filesAdopted: number;
	/** Number of stale baselines forgotten */
	filesForgotten: number;
	/** Paths with unresolved conflicts */
	conflicts: string[];
	/** Errors encountered during sync */
	errors: SyncError[];
}

/**
 * Sync error with context for diagnostics.
 */
export interface SyncError {
	/** File path (empty string for global errors) */
	path: string;
	/** Action that was being attempted */
	action: SyncAction;
	/** Human-readable error message */
	message: string;
	/** Whether the error is recoverable on next sync */
	recoverable: boolean;
}

/**
 * Classification of a local file relative to its baseline.
 *
 * - `L0` — local file absent
 * - `L+` — local file exists, no baseline
 * - `L=` — local file matches baseline (mtime+size fast path or hash)
 * - `LΔ` — local file differs from baseline
 */
export type LocalClassification = 'L0' | 'L+' | 'L=' | 'LΔ';

/**
 * Classification of a remote file relative to its baseline.
 *
 * - `R0` — remote object absent
 * - `R+` — remote object exists, no baseline
 * - `R=` — remote object matches baseline (ETag or size+mtime fast path)
 * - `RΔ` — remote object differs from baseline
 */
export type RemoteClassification = 'R0' | 'R+' | 'R=' | 'RΔ';

/**
 * Input to the decision table for a single file.
 *
 * Produced by SyncPlanner after classification.
 */
export interface DecisionInput {
	/** File path relative to vault root */
	path: string;
	/** Local classification */
	local: LocalClassification;
	/** Remote classification */
	remote: RemoteClassification;
	/** Whether an unresolved conflict record exists for this path */
	hasUnresolvedConflict: boolean;
	/** Whether LOCAL_/REMOTE_ artifact files exist on disk */
	hasConflictArtifacts: boolean;
	/** Whether the local file exists (needed for conflict resolution detection) */
	localExists: boolean;
	/** Whether the remote object exists (needed for conflict cleanup) */
	remoteExists: boolean;
	/** Whether a sync baseline exists in the journal for this path */
	hasBaseline: boolean;
	/** Content fingerprint of local file (if computed) */
	localFingerprint?: string;
	/** Content fingerprint of remote file (if computed) */
	remoteFingerprint?: string;
}

/**
 * S3 object metadata returned by HeadObject / GetObject, enriched
 * with custom sync metadata headers.
 */
export interface S3HeadResult {
	/** S3 ETag (without quotes) */
	etag: string;
	/** Content-Length in bytes */
	size: number;
	/** S3 LastModified as epoch ms */
	lastModified: number;
	/** Custom metadata: obsidian-sync-version */
	syncVersion?: number;
	/** Custom metadata: obsidian-fingerprint (content identity) */
	fingerprint?: string;
	/** Custom metadata: obsidian-mtime (client-reported epoch ms) */
	clientMtime?: number;
	/** Custom metadata: obsidian-device-id */
	deviceId?: string;
}

/**
 * S3 download result with metadata and content.
 */
export interface S3DownloadResult {
	/** Downloaded content as bytes */
	content: Uint8Array;
	/** S3 ETag (without quotes) */
	etag: string;
	/** Content-Length in bytes */
	size: number;
	/** S3 LastModified as epoch ms */
	lastModified: number;
	/** Custom metadata (same as HeadResult) */
	syncVersion?: number;
	/** Custom metadata: obsidian-fingerprint */
	fingerprint?: string;
	/** Custom metadata: obsidian-mtime */
	clientMtime?: number;
	/** Custom metadata: obsidian-device-id */
	deviceId?: string;
}

/**
 * Custom metadata to attach when uploading a file to S3.
 */
export interface SyncUploadMetadata {
	/** Content fingerprint to store as custom metadata */
	fingerprint: string;
	/** Client-reported mtime (epoch ms) */
	clientMtime: number;
	/** Device ID performing the upload */
	deviceId: string;
}

// =============================================================================
// Backup Types
// =============================================================================

/**
 * Backup manifest stored with each backup snapshot.
 *
 * Written as `.backup-manifest.json` inside each backup folder in S3. Used to
 * display backup metadata in the settings UI and to support restoration workflows.
 */
export interface BackupManifest {
	/** Manifest schema version (currently 1). Incremented on breaking changes. */
	version: number;
	/** ISO 8601 timestamp when the backup was created (e.g., "2024-12-25T14:30:00.000Z"). */
	timestamp: string;
	/** Device ID of the device that created the backup (from {@link VaultMarker}). */
	deviceId: string;
	/** Human-readable device name reported by Obsidian at the time of backup. */
	deviceName: string;
	/** Number of files included in this backup snapshot. */
	fileCount: number;
	/** Total plaintext size of all backed-up files in bytes. */
	totalSize: number;
	/** Whether the backup files are encrypted (matches the plugin encryption setting at backup time). */
	encrypted: boolean;
	/** Map of relative file path → SHA-256 hex digest for integrity verification. */
	checksums: Record<string, string>;
}

/**
 * Backup info for display in settings
 */
export interface BackupInfo {
	/** Backup folder name (backup-{timestamp}) */
	name: string;
	/** ISO timestamp */
	timestamp: string;
	/** Number of files in backup */
	fileCount: number;
	/** Total size in bytes */
	totalSize: number;
	/** Whether backup is encrypted */
	encrypted: boolean;
}

/**
 * Result of a backup operation.
 *
 * Returned by `SnapshotCreator.createSnapshot()` and propagated through
 * `BackupScheduler` callbacks to update the status bar and user notices.
 */
export interface BackupResult {
	/** Whether the backup completed without any errors. */
	success: boolean;
	/** The backup folder name in S3 (e.g., `backup-2024-12-25T14-30-00`). */
	backupName: string;
	/** Epoch ms timestamp when the backup started. */
	startedAt: number;
	/** Epoch ms timestamp when the backup completed. */
	completedAt: number;
	/** Number of files successfully uploaded to the backup folder. */
	filesBackedUp: number;
	/** Total bytes uploaded across all files in this backup. */
	totalSize: number;
	/** List of error messages for any files that failed to back up. */
	errors: string[];
}

// =============================================================================
// Status Types
// =============================================================================

/**
 * Sync status for status bar display
 */
export type SyncStatus =
	| 'idle'        // Cloud connected but no completed sync yet
	| 'synced'      // ✓ Sync completed
	| 'syncing'     // ↻ Sync in progress
	| 'error'       // ! Error occurred
	| 'conflicts'   // ⚠ Has conflicts
	| 'disabled'    // ○ Sync disabled
	| 'paused';     // ⏸ Sync paused

/**
 * Backup status for status bar display
 */
export type BackupStatus =
	| 'idle'        // Ready but no completed backup yet
	| 'completed'   // ✓ Backup completed
	| 'running'     // ↻ Backup in progress
	| 'error'       // ! Error occurred
	| 'disabled';   // ○ Backup disabled

/**
 * Runtime state for the sync system, consumed by the status bar.
 *
 * Held by the `StatusBar` instance and updated via partial merges through
 * `StatusBar.updateSyncState()`. Drives the visual representation of the
 * sync segment (icon, label, suffix, and tooltip text).
 */
export interface SyncState {
	/** Current sync status driving the icon and CSS class. */
	status: SyncStatus;
	/** Epoch ms timestamp of the last completed sync, or `null` if never synced. */
	lastSyncTime: number | null;
	/** Number of unresolved conflicts from the last sync. */
	conflictCount: number;
	/** Whether a sync operation is currently in progress. */
	isSyncing: boolean;
	/** Last sync error message, or `null` if the last sync succeeded. */
	lastError: string | null;
}

/**
 * Runtime state for the backup system, consumed by the status bar.
 *
 * Held by the `StatusBar` instance and updated via partial merges through
 * `StatusBar.updateBackupState()`. Drives the visual representation of the
 * backup segment (icon, label, suffix, and tooltip text).
 */
export interface BackupState {
	/** Current backup status driving the icon and CSS class. */
	status: BackupStatus;
	/** Epoch ms timestamp of the last completed backup, or `null` if never backed up. */
	lastBackupTime: number | null;
	/** Whether a backup operation is currently in progress. */
	isRunning: boolean;
	/** Last backup error message, or `null` if the last backup succeeded. */
	lastError: string | null;
}

// =============================================================================
// S3 Types
// =============================================================================

/**
 * S3 object metadata from list operations.
 *
 * Returned by `S3Provider.listObjects()`. Used by the sync planner to discover
 * remote files and by the retention manager to enumerate old backup folders.
 */
export interface S3ObjectInfo {
	/** Full S3 object key (e.g., `vault/Notes/my-note.md`). */
	key: string;
	/** Object size in bytes as reported by S3. */
	size: number;
	/** S3 LastModified timestamp as a `Date` object. */
	lastModified: Date;
	/** S3 ETag (may be quoted; strip quotes before comparing). Optional — not always returned. */
	etag?: string;
}

/**
 * Device registration for multi-device sync.
 *
 * Created by `getOrCreateDeviceId()` in `VaultMarker` and persisted in Obsidian's
 * plugin data. Used to tag S3 objects with the writing device so the sync engine
 * can attribute remote changes to specific devices in logs and conflict metadata.
 */
export interface DeviceInfo {
	/** Unique, stable identifier for this device (UUID v4 generated on first run). */
	deviceId: string;
	/** Human-readable device name (e.g., hostname or Obsidian app name). */
	deviceName: string;
	/** Platform string (e.g., `"desktop"`, `"mobile"`). */
	platform: string;
	/** Epoch ms timestamp when this device last connected to sync. */
	lastSeen: number;
	/** Epoch ms timestamp when this device was first registered. */
	createdAt: number;
}

// =============================================================================
// Encryption Types
// =============================================================================

/**
 * Encryption marker transition state.
 *
 * - `enabled`   — encryption is fully active; all files in S3 are encrypted.
 * - `enabling`  — migration in progress: re-uploading plaintext files as encrypted.
 *                 All devices must block sync/backup until migration completes.
 * - `disabling` — migration in progress: re-uploading encrypted files as plaintext.
 *                 All devices must block sync/backup until migration completes.
 *
 * When the marker file is **absent**, the vault is treated as plaintext (no encryption).
 */
export type EncryptionMarkerState = 'enabled' | 'enabling' | 'disabling';

/**
 * Vault encryption marker file structure.
 *
 * Stored at `{syncPrefix}/.obsidian-s3-sync/.vault.enc` in S3. Written when
 * encryption is first enabled (state = `enabling`), then flipped to `enabled`
 * after all files have been re-uploaded encrypted. On subsequent sessions, this
 * file is read to verify the passphrase (by decrypting `verificationToken`) and
 * to obtain the Argon2id salt needed to re-derive the encryption key.
 *
 * If the file is missing, the bucket is treated as unencrypted.
 */
export interface VaultEncryptionMarker {
	/** Marker schema version (currently 2 — added `state`, `updatedAt`, `updatedBy`). */
	version: number;
	/** Random 32-byte salt for Argon2id (base64 encoded). Generated once per vault. */
	salt: string;
	/** Encrypted verification token to validate the passphrase without storing the key. */
	verificationToken: string;
	/**
	 * Current encryption state of the vault.
	 *
	 * - `enabling`  — migration from plaintext → encrypted is in progress.
	 * - `enabled`   — all files are encrypted; normal sync/backup may proceed.
	 * - `disabling` — migration from encrypted → plaintext is in progress.
	 *
	 * During `enabling` or `disabling`, ALL devices must block sync and backup
	 * until the migration completes and the state transitions to `enabled` or
	 * the marker is deleted.
	 */
	state: EncryptionMarkerState;
	/** ISO 8601 timestamp when encryption was first set up on this vault. */
	createdAt: string;
	/** Device ID of the device that initially enabled encryption. */
	createdBy: string;
	/** ISO 8601 timestamp of the last state change (enable, disable, migration complete). */
	updatedAt: string;
	/** Device ID of the device that last modified the marker state. */
	updatedBy: string;
}

/**
 * Remote encryption mode as detected by the EncryptionCoordinator.
 *
 * Derived from the presence and state of the vault marker in S3:
 * - `plaintext`    — no marker file exists; vault is unencrypted.
 * - `encrypted`    — marker exists with `state: 'enabled'`.
 * - `transitioning` — marker exists with `state: 'enabling'` or `'disabling'`.
 */
export type RemoteEncryptionMode = 'plaintext' | 'encrypted' | 'transitioning';

/**
 * Runtime encryption state exposed by EncryptionCoordinator.
 *
 * Used by the settings UI to derive its display state and by sync/backup
 * guards to determine whether operations should be blocked.
 */
export interface EncryptionRuntimeState {
	/** Current remote mode derived from the vault marker in S3. */
	remoteMode: RemoteEncryptionMode;
	/** Whether a derived encryption key is currently loaded in memory. */
	hasKey: boolean;
	/** Whether a migration (enable/disable) is currently in progress on this device. */
	isBusy: boolean;
}
