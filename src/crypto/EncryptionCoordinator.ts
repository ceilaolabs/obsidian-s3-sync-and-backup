/**
 * Encryption Coordinator Module
 *
 * Central authority for vault encryption state. Owns the runtime encryption key
 * and propagates it to all consumers (SyncPayloadCodec, SnapshotCreator,
 * BackupDownloader). Manages enable/disable encryption flows including the
 * vault-wide file migration (re-upload all files in the target payload format).
 *
 * Key architectural decision: migration reads file content from the **local vault**
 * (which is always plaintext on disk), encodes it to the target payload format,
 * and uploads. This avoids the fragile download-decrypt-reupload pattern that
 * broke when files had mixed encryption states on S3.
 *
 * Multi-device safety is ensured by:
 * 1. A `transitioning` marker state that blocks sync/backup on all devices.
 * 2. A remote lease lock ({@link SyncLease}) that prevents concurrent migrations.
 * 3. Payload-format metadata on every uploaded object so decode never guesses.
 */

import { App, Notice, TFile } from 'obsidian';
import { S3Provider } from '../storage/S3Provider';
import { SyncPayloadCodec } from '../sync/SyncPayloadCodec';
import { SyncPathCodec } from '../sync/SyncPathCodec';
import { SyncLease } from '../sync/SyncLease';
import { SnapshotCreator } from '../backup/SnapshotCreator';
import { BackupDownloader } from '../backup/BackupDownloader';
import { VaultMarker } from './VaultMarker';
import { validatePassphrase } from './KeyDerivation';
import { encrypt } from './FileEncryptor';
import { hashContent } from './Hasher';
import {
	EncryptionRuntimeState,
	PayloadFormat,
	RemoteEncryptionMode,
	S3SyncBackupSettings,
	SyncUploadMetadata,
} from '../types';
import { encodeMetadata } from '../sync/SyncObjectMetadata';
import { matchesAnyGlob, isPluginOwnPath } from '../utils/paths';
import { readVaultFile } from '../utils/vaultFiles';

/**
 * Callbacks provided by the plugin's main module so the coordinator can
 * pause/resume schedulers and persist settings without circular imports.
 */
export interface EncryptionCoordinatorCallbacks {
	saveSettings: () => Promise<void>;
	pauseSchedulers: () => void;
	resumeSchedulers: () => void;
}

/**
 * Orchestrates encryption lifecycle: key derivation, propagation, and
 * vault-wide migration between plaintext and encrypted states.
 */
export class EncryptionCoordinator {
	private encryptionKey: Uint8Array | null = null;
	private remoteMode: RemoteEncryptionMode = 'plaintext';
	private isBusy = false;
	private vaultMarker: VaultMarker;
	private syncLease: SyncLease;

	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private payloadCodec: SyncPayloadCodec,
		private pathCodec: SyncPathCodec,
		private snapshotCreator: SnapshotCreator,
		private backupDownloader: BackupDownloader,
		private settings: S3SyncBackupSettings,
		private deviceId: string,
	) {
		this.vaultMarker = new VaultMarker(s3Provider, settings.syncPrefix);
		this.syncLease = new SyncLease(s3Provider, settings.syncPrefix);
	}

	getState(): EncryptionRuntimeState {
		return {
			remoteMode: this.remoteMode,
			hasKey: this.encryptionKey !== null,
			isBusy: this.isBusy,
		};
	}

	/**
	 * Whether sync and backup operations should be blocked.
	 *
	 * Returns true when:
	 * - A migration is in progress locally
	 * - The remote marker is in transitioning state (migration on another device)
	 * - Encryption is enabled remotely but no key is loaded
	 */
	shouldBlock(): boolean {
		if (this.isBusy) return true;
		if (this.remoteMode === 'transitioning') return true;
		if (this.remoteMode === 'encrypted' && this.encryptionKey === null) return true;
		return false;
	}

	getBlockReason(): string | null {
		if (this.isBusy) return 'Encryption migration in progress';
		if (this.remoteMode === 'transitioning') return 'Encryption state transition in progress on another device';
		if (this.remoteMode === 'encrypted' && this.encryptionKey === null) {
			return 'Vault is encrypted — enter passphrase in settings to unlock';
		}
		return null;
	}

	/**
	 * Check the remote vault marker and update local state accordingly.
	 *
	 * Called on plugin startup and before every sync/backup operation.
	 * If the remote marker indicates encryption but the local setting disagrees,
	 * the local setting is auto-aligned (multi-device detection).
	 */
	async refreshRemoteMode(saveSettings: () => Promise<void>): Promise<void> {
		try {
			const markerExists = await this.vaultMarker.exists();

			if (!markerExists) {
				this.remoteMode = 'plaintext';
				if (this.settings.encryptionEnabled) {
					this.settings.encryptionEnabled = false;
					await saveSettings();
				}
				return;
			}

			const metadata = await this.vaultMarker.getMetadata();
			if (!metadata) {
				this.remoteMode = 'plaintext';
				return;
			}

			if (metadata.state === 'transitioning') {
				this.remoteMode = 'transitioning';
			} else {
				this.remoteMode = 'encrypted';
			}

			if (this.remoteMode === 'encrypted' && !this.settings.encryptionEnabled) {
				this.settings.encryptionEnabled = true;
				await saveSettings();
			}
		} catch (error) {
			console.error('[Encryption] Failed to refresh remote mode:', error);
		}
	}

	/**
	 * Unlock the vault with a passphrase (for existing encrypted vaults).
	 *
	 * Verifies the passphrase against the vault marker, then propagates the
	 * derived key to all consumers.
	 *
	 * @returns true if passphrase was correct and key was set.
	 */
	async unlock(passphrase: string): Promise<boolean> {
		const key = await this.vaultMarker.verify(passphrase);
		if (!key) return false;

		this.propagateKey(key);
		return true;
	}

	/**
	 * Enable encryption on the vault.
	 *
	 * Flow:
	 * 1. Validate passphrase
	 * 2. Pause schedulers to prevent sync/backup during migration
	 * 3. Acquire remote lease lock
	 * 4. Create vault marker (state = 'transitioning', plaintext → encrypted)
	 * 5. Propagate derived key
	 * 6. Migrate all files: read local plaintext → encrypt → upload with payload-format tag
	 * 7. Flip marker to 'enabled'
	 * 8. Save settings
	 * 9. Release lease, resume schedulers
	 */
	async enableEncryption(
		passphrase: string,
		callbacks: EncryptionCoordinatorCallbacks,
	): Promise<{ success: boolean; error?: string }> {
		const validation = validatePassphrase(passphrase);
		if (!validation.valid) {
			return { success: false, error: validation.message };
		}

		if (this.isBusy) {
			return { success: false, error: 'Migration already in progress' };
		}

		this.isBusy = true;
		callbacks.pauseSchedulers();

		try {
			await this.syncLease.acquire(this.deviceId, 'migration');

			const key = await this.vaultMarker.create(passphrase, this.deviceId);
			this.propagateKey(key);
			this.remoteMode = 'transitioning';

			await this.migrateAllFiles('xsalsa20poly1305-v1');

			await this.vaultMarker.updateState('enabled', this.deviceId);
			this.remoteMode = 'encrypted';

			this.settings.encryptionEnabled = true;
			await callbacks.saveSettings();

			new Notice('Encryption enabled — all files re-uploaded encrypted');
			return { success: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			console.error('[Encryption] Enable failed:', error);
			return { success: false, error: message };
		} finally {
			await this.syncLease.release().catch((e) => console.error('[Encryption] Lease release failed:', e));
			this.isBusy = false;
			callbacks.resumeSchedulers();
		}
	}

	/**
	 * Disable encryption and re-upload all files as plaintext.
	 *
	 * Flow:
	 * 1. Pause schedulers
	 * 2. Acquire remote lease lock
	 * 3. Set marker to 'transitioning' (encrypted → plaintext)
	 * 4. Migrate all files: read local plaintext → upload as-is with plaintext payload-format
	 * 5. Delete vault marker
	 * 6. Clear encryption key
	 * 7. Save settings
	 * 8. Release lease, resume schedulers
	 */
	async disableEncryption(
		callbacks: EncryptionCoordinatorCallbacks,
	): Promise<{ success: boolean; error?: string }> {
		if (this.encryptionKey === null) {
			return { success: false, error: 'No encryption key loaded — unlock first' };
		}

		if (this.isBusy) {
			return { success: false, error: 'Migration already in progress' };
		}

		this.isBusy = true;
		callbacks.pauseSchedulers();

		try {
			await this.syncLease.acquire(this.deviceId, 'migration');

			const migrationId = crypto.randomUUID();
			await this.vaultMarker.updateState('transitioning', this.deviceId, {
				fromMode: 'xsalsa20poly1305-v1',
				targetMode: 'plaintext-v1',
				migrationId,
			});
			this.remoteMode = 'transitioning';

			await this.migrateAllFiles('plaintext-v1');

			await this.vaultMarker.delete();
			this.propagateKey(null);
			this.remoteMode = 'plaintext';

			this.settings.encryptionEnabled = false;
			await callbacks.saveSettings();

			new Notice('Encryption disabled — all files re-uploaded as plaintext');
			return { success: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			console.error('[Encryption] Disable failed:', error);
			return { success: false, error: message };
		} finally {
			await this.syncLease.release().catch((e) => console.error('[Encryption] Lease release failed:', e));
			this.isBusy = false;
			callbacks.resumeSchedulers();
		}
	}

	/**
	 * Migrate all vault files to the target payload format by reading from the
	 * local vault (always plaintext on disk) and uploading with the correct
	 * payload-format metadata tag.
	 *
	 * This approach is fundamentally more reliable than download-decrypt-reupload
	 * because it never needs to determine how a remote file is currently encoded.
	 *
	 * @param targetFormat - The payload format every file should be uploaded as.
	 */
	private async migrateAllFiles(targetFormat: PayloadFormat): Promise<void> {
		if (targetFormat === 'xsalsa20poly1305-v1' && !this.encryptionKey) {
			throw new Error('Cannot encrypt files without an encryption key');
		}

		const vaultFiles = this.app.vault.getFiles();
		let migrated = 0;
		let skipped = 0;
		let errors = 0;

		for (const file of vaultFiles) {
			if (matchesAnyGlob(file.path, this.settings.excludePatterns)
				|| isPluginOwnPath(file.path, this.app.vault.configDir)) {
				skipped++;
				continue;
			}

			try {
				await this.migrateFile(file, targetFormat);
				migrated++;
			} catch (error) {
				errors++;
				console.error(`[Encryption] Failed to migrate ${file.path}:`, error);
			}

			// Renew lease periodically to prevent expiry during large migrations
			if (migrated % 50 === 0) {
				await this.syncLease.renew().catch(() => { /* best effort */ });
			}
		}

		if (this.settings.debugLogging) {
			console.debug(`[Encryption] Migration complete: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
		}

		if (errors > 0) {
			throw new Error(`Migration incomplete: ${errors} file(s) failed. Marker left in transitioning state for retry.`);
		}
	}

	/**
	 * Migrate a single file: read from local vault, encode to target format, upload.
	 *
	 * Reads the file from the Obsidian vault (always plaintext on disk), computes
	 * the fingerprint, encodes to the target format, and uploads with full metadata
	 * including the payload-format tag.
	 */
	private async migrateFile(file: TFile, targetFormat: PayloadFormat): Promise<void> {
		const plaintext = await readVaultFile(this.app.vault, file);
		const plaintextBytes = typeof plaintext === 'string'
			? new TextEncoder().encode(plaintext)
			: plaintext;

		const fingerprintHex = await hashContent(plaintextBytes);
		const fingerprint = `sha256:${fingerprintHex}`;

		let uploadPayload: Uint8Array;
		if (targetFormat === 'xsalsa20poly1305-v1') {
			if (!this.encryptionKey) throw new Error('No encryption key');
			uploadPayload = encrypt(plaintextBytes, this.encryptionKey);
		} else {
			uploadPayload = plaintextBytes;
		}

		const remoteKey = this.pathCodec.localToRemote(file.path);
		const uploadMeta: SyncUploadMetadata = {
			fingerprint,
			clientMtime: file.stat.mtime,
			deviceId: this.deviceId,
			payloadFormat: targetFormat,
		};

		await this.s3Provider.uploadFile(remoteKey, uploadPayload, {
			metadata: encodeMetadata(uploadMeta),
		});
	}

	private propagateKey(key: Uint8Array | null): void {
		this.encryptionKey = key;
		this.payloadCodec.updateKey(key);
		this.snapshotCreator.setEncryptionKey(key);
		this.backupDownloader.setEncryptionKey(key);
	}

	updateSettings(settings: S3SyncBackupSettings): void {
		this.settings = settings;
		this.vaultMarker = new VaultMarker(this.s3Provider, settings.syncPrefix);
		this.syncLease = new SyncLease(this.s3Provider, settings.syncPrefix);
	}

	/** Expose lease for external checks (e.g., settings UI). */
	getSyncLease(): SyncLease {
		return this.syncLease;
	}
}
