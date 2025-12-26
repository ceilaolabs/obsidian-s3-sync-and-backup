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

	excludePatterns: ['workspace*', '.trash/*'],
	debugLogging: false,
};

// =============================================================================
// Sync Types
// =============================================================================

/**
 * Status of a file in the sync system
 */
export type SyncFileStatus =
	| 'synced'       // File is in sync
	| 'pending'      // Local changes waiting to sync
	| 'conflict'     // Both local and remote changed
	| 'deleted'      // Marked for deletion
	| 'new';         // New file not yet synced

/**
 * Sync journal entry for tracking file state
 */
export interface SyncJournalEntry {
	/** File path relative to vault root */
	path: string;
	/** SHA-256 hash of local file content */
	localHash: string;
	/** SHA-256 hash of remote file content */
	remoteHash: string;
	/** Local file modification time (epoch ms) */
	localMtime: number;
	/** Remote file modification time (epoch ms) */
	remoteMtime: number;
	/** Last sync timestamp (epoch ms) */
	syncedAt: number;
	/** Current sync status */
	status: SyncFileStatus;
	/** Device ID that last modified this file */
	lastModifiedBy?: string;
}

/**
 * Action to take for a file during sync
 */
export type SyncAction =
	| 'upload'
	| 'download'
	| 'delete-local'
	| 'delete-remote'
	| 'conflict'
	| 'skip';

/**
 * Sync plan item describing what to do with a file
 */
export interface SyncPlanItem {
	path: string;
	action: SyncAction;
	reason: string;
	localHash?: string;
	remoteHash?: string;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
	success: boolean;
	startedAt: number;
	completedAt: number;
	filesUploaded: number;
	filesDownloaded: number;
	filesDeleted: number;
	conflicts: string[];
	errors: SyncError[];
}

/**
 * Sync error with context
 */
export interface SyncError {
	path: string;
	action: SyncAction;
	message: string;
	recoverable: boolean;
}

// =============================================================================
// Backup Types
// =============================================================================

/**
 * Backup manifest stored with each backup snapshot
 */
export interface BackupManifest {
	version: number;
	timestamp: string;
	deviceId: string;
	deviceName: string;
	fileCount: number;
	totalSize: number;
	encrypted: boolean;
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
 * Result of a backup operation
 */
export interface BackupResult {
	success: boolean;
	backupName: string;
	startedAt: number;
	completedAt: number;
	filesBackedUp: number;
	totalSize: number;
	errors: string[];
}

// =============================================================================
// Status Types
// =============================================================================

/**
 * Sync status for status bar display
 */
export type SyncStatus =
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
	| 'completed'   // ✓ Backup completed
	| 'running'     // ↻ Backup in progress
	| 'error'       // ! Error occurred
	| 'disabled';   // ○ Backup disabled

/**
 * Runtime state for sync system
 */
export interface SyncState {
	status: SyncStatus;
	lastSyncTime: number | null;
	conflictCount: number;
	isSyncing: boolean;
	lastError: string | null;
}

/**
 * Runtime state for backup system
 */
export interface BackupState {
	status: BackupStatus;
	lastBackupTime: number | null;
	isRunning: boolean;
	lastError: string | null;
}

// =============================================================================
// S3 Types
// =============================================================================

/**
 * S3 object metadata from list operations
 */
export interface S3ObjectInfo {
	key: string;
	size: number;
	lastModified: Date;
	etag?: string;
}

/**
 * Device registration for multi-device sync
 */
export interface DeviceInfo {
	deviceId: string;
	deviceName: string;
	platform: string;
	lastSeen: number;
	createdAt: number;
}

// =============================================================================
// Encryption Types
// =============================================================================

/**
 * Vault encryption marker file structure
 * Stored at {syncPrefix}/.obsidian-s3-sync/vault.enc
 */
export interface VaultEncryptionMarker {
	version: number;
	/** Random 32-byte salt for Argon2id (base64 encoded) */
	salt: string;
	/** Encrypted verification token to validate passphrase */
	verificationToken: string;
	/** Timestamp when encryption was set up */
	createdAt: string;
	/** Device ID that created the encryption */
	createdBy: string;
}
