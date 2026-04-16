/**
 * Encryption Coordinator Module
 *
 * Central authority for vault encryption state. Owns the runtime encryption key
 * and propagates it to all consumers (SyncPayloadCodec, SnapshotCreator,
 * BackupDownloader). Manages enable/disable encryption flows including the
 * vault-wide file migration (re-upload all files encrypted or decrypted).
 *
 * The coordinator derives its state from the remote vault marker in S3, not from
 * local settings alone. This ensures multi-device consistency: when device A
 * enables encryption, device B detects the marker on its next sync preflight
 * and blocks until the user provides the passphrase.
 */

import { App, Notice, TFile } from 'obsidian';
import { S3Provider } from '../storage/S3Provider';
import { SyncPayloadCodec } from '../sync/SyncPayloadCodec';
import { SyncPathCodec } from '../sync/SyncPathCodec';
import { SnapshotCreator } from '../backup/SnapshotCreator';
import { BackupDownloader } from '../backup/BackupDownloader';
import { VaultMarker } from './VaultMarker';
import { validatePassphrase } from './KeyDerivation';
import { encrypt, decrypt, isLikelyEncrypted } from './FileEncryptor';
import { hashContent } from './Hasher';
import {
	EncryptionRuntimeState,
	RemoteEncryptionMode,
	S3SyncBackupSettings,
} from '../types';
import { encodeMetadata } from '../sync/SyncObjectMetadata';
import { matchesAnyGlob } from '../utils/paths';

/**
 * Orchestrates encryption lifecycle: key derivation, propagation, and
 * vault-wide migration between plaintext and encrypted states.
 */
export class EncryptionCoordinator {
	private encryptionKey: Uint8Array | null = null;
	private remoteMode: RemoteEncryptionMode = 'plaintext';
	private isBusy = false;
	private vaultMarker: VaultMarker;

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
	}

	/** Current runtime encryption state for UI and guard checks. */
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
	 * - Encryption is enabled remotely but no key is loaded (locked)
	 * - A migration (enable/disable) is in progress on any device
	 */
	shouldBlock(): boolean {
		if (this.isBusy) return true;
		if (this.remoteMode === 'transitioning') return true;
		if (this.remoteMode === 'encrypted' && this.encryptionKey === null) return true;
		return false;
	}

	/**
	 * Returns a human-readable reason why operations are blocked, or null if not blocked.
	 */
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
	 *
	 * @param saveSettings - Callback to persist settings changes to disk.
	 */
	async refreshRemoteMode(saveSettings: () => Promise<void>): Promise<void> {
		try {
			const markerExists = await this.vaultMarker.exists();

			if (!markerExists) {
				this.remoteMode = 'plaintext';
				// Auto-align local setting if remote is plaintext
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

			const state = metadata.state;
			if (state === 'enabling' || state === 'disabling') {
				this.remoteMode = 'transitioning';
			} else {
				this.remoteMode = 'encrypted';
			}

			// Auto-align: if remote is encrypted but local setting says disabled,
			// enable it locally so the UI shows the correct state.
			if (this.remoteMode === 'encrypted' && !this.settings.encryptionEnabled) {
				this.settings.encryptionEnabled = true;
				await saveSettings();
			}
		} catch (error) {
			// Network error — keep current state, don't block on transient failures
			console.error('[Encryption] Failed to refresh remote mode:', error);
		}
	}

	/**
	 * Unlock the vault with a passphrase (for existing encrypted vaults).
	 *
	 * Verifies the passphrase against the vault marker, then propagates the
	 * derived key to all consumers. Used on startup and in the settings UI.
	 *
	 * @returns true if passphrase was correct and key was set, false otherwise.
	 */
	async unlock(passphrase: string): Promise<boolean> {
		const key = await this.vaultMarker.verify(passphrase);
		if (!key) return false;

		this.propagateKey(key);
		return true;
	}

	/**
	 * Enable encryption on the vault for the first time.
	 *
	 * Flow:
	 * 1. Validate passphrase strength
	 * 2. Create vault marker in S3 (state = 'enabling')
	 * 3. Propagate derived key to all consumers
	 * 4. Re-upload all synced files encrypted
	 * 5. Flip marker state to 'enabled'
	 *
	 * @param passphrase - User's chosen passphrase.
	 * @param saveSettings - Callback to persist settings changes.
	 * @returns Result object with success flag and optional error message.
	 */
	async enableEncryption(
		passphrase: string,
		saveSettings: () => Promise<void>,
	): Promise<{ success: boolean; error?: string }> {
		const validation = validatePassphrase(passphrase);
		if (!validation.valid) {
			return { success: false, error: validation.message };
		}

		if (this.isBusy) {
			return { success: false, error: 'Migration already in progress' };
		}

		this.isBusy = true;

		try {
			// Step 1: Create marker (state = 'enabling'), derive key
			const key = await this.vaultMarker.create(passphrase, this.deviceId);
			this.propagateKey(key);

			// Step 2: Update local settings
			this.settings.encryptionEnabled = true;
			await saveSettings();

			// Step 3: Re-upload all existing synced files as encrypted
			await this.migrateAllFiles('encrypt');

			// Step 4: Flip marker to 'enabled'
			await this.vaultMarker.updateState('enabled', this.deviceId);
			this.remoteMode = 'encrypted';

			new Notice('Encryption enabled — all files re-uploaded encrypted');
			return { success: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			console.error('[Encryption] Enable failed:', error);
			// Leave marker in 'enabling' state so all devices stay blocked
			// until the issue is resolved manually.
			return { success: false, error: message };
		} finally {
			this.isBusy = false;
		}
	}

	/**
	 * Disable encryption and re-upload all files as plaintext.
	 *
	 * Flow:
	 * 1. Set marker state to 'disabling' (blocks all devices)
	 * 2. Re-upload all synced files as plaintext (key still loaded for decryption)
	 * 3. Delete the vault marker
	 * 4. Clear the encryption key from all consumers
	 *
	 * @param saveSettings - Callback to persist settings changes.
	 * @returns Result object with success flag and optional error message.
	 */
	async disableEncryption(
		saveSettings: () => Promise<void>,
	): Promise<{ success: boolean; error?: string }> {
		if (this.encryptionKey === null) {
			return { success: false, error: 'No encryption key loaded — unlock first' };
		}

		if (this.isBusy) {
			return { success: false, error: 'Migration already in progress' };
		}

		this.isBusy = true;

		try {
			// Step 1: Mark as 'disabling' to block all devices
			await this.vaultMarker.updateState('disabling', this.deviceId);
			this.remoteMode = 'transitioning';

			// Step 2: Re-upload all files as plaintext (key still loaded for read)
			await this.migrateAllFiles('decrypt');

			// Step 3: Delete marker and clear key
			await this.vaultMarker.delete();
			this.propagateKey(null);
			this.remoteMode = 'plaintext';

			// Step 4: Update local settings
			this.settings.encryptionEnabled = false;
			await saveSettings();

			new Notice('Encryption disabled — all files re-uploaded as plaintext');
			return { success: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			console.error('[Encryption] Disable failed:', error);
			// Leave marker in 'disabling' state — all devices stay blocked.
			return { success: false, error: message };
		} finally {
			this.isBusy = false;
		}
	}

	/**
	 * Re-upload all synced files in S3, either encrypting or decrypting them.
	 *
	 * Lists all objects under the sync prefix, downloads each one, transforms
	 * it (encrypt or decrypt), and re-uploads with updated metadata. Skips
	 * internal files (.obsidian-s3-sync/) and files matching exclude patterns.
	 *
	 * @param direction - 'encrypt' to encrypt plaintext files, 'decrypt' to
	 *   decrypt encrypted files back to plaintext.
	 */
	private async migrateAllFiles(direction: 'encrypt' | 'decrypt'): Promise<void> {
		if (!this.encryptionKey) {
			throw new Error('Cannot migrate files without an encryption key');
		}

		const prefix = this.settings.syncPrefix;
		const objects = await this.s3Provider.listObjects(prefix, true);

		let migrated = 0;
		let errors = 0;

		for (const obj of objects) {
			// Skip internal sync metadata files
			if (obj.key.includes('.obsidian-s3-sync/')) continue;

			// Derive the vault-relative path from the S3 key
			const vaultPath = this.pathCodec.remoteToLocal(obj.key);
			if (!vaultPath) continue;

			// Skip excluded files
			if (matchesAnyGlob(vaultPath, this.settings.excludePatterns)) continue;

			try {
				await this.migrateFile(obj.key, vaultPath, direction);
				migrated++;
			} catch (error) {
				errors++;
				console.error(`[Encryption] Failed to migrate ${obj.key}:`, error);
			}
		}

		if (this.settings.debugLogging) {
			console.debug(`[Encryption] Migration complete: ${migrated} files migrated, ${errors} errors`);
		}

		if (errors > 0) {
			throw new Error(`Migration incomplete: ${errors} file(s) failed to migrate`);
		}
	}

	/**
	 * Migrate a single file: download, transform (encrypt/decrypt), re-upload.
	 *
	 * Preserves the original plaintext fingerprint in S3 metadata so the sync
	 * planner sees no logical content change after migration.
	 */
	private async migrateFile(
		s3Key: string,
		vaultPath: string,
		direction: 'encrypt' | 'decrypt',
	): Promise<void> {
		if (!this.encryptionKey) throw new Error('No encryption key');

		// Download current content from S3
		const rawContent = await this.s3Provider.downloadFile(s3Key);

		let plaintext: Uint8Array;
		let uploadPayload: Uint8Array;

		if (direction === 'encrypt') {
			// Content is currently plaintext — encrypt it
			plaintext = rawContent;
			uploadPayload = encrypt(plaintext, this.encryptionKey);
		} else {
			// Content is currently encrypted — decrypt it.
			// Files that were synced before encryption was enabled are still
			// plaintext on S3. Detect them and skip the decryption step so
			// the migration doesn't fail on mixed-state buckets.
			if (!isLikelyEncrypted(rawContent)) {
				// Already plaintext — just re-upload with updated metadata
				plaintext = rawContent;
				uploadPayload = rawContent;
			} else {
				try {
					plaintext = decrypt(rawContent, this.encryptionKey);
					uploadPayload = plaintext;
				} catch {
					// Decryption failed — file may be plaintext that happens
					// to be large enough to pass the length check, or was
					// encrypted with a different key. Treat as plaintext to
					// avoid blocking the entire migration.
					plaintext = rawContent;
					uploadPayload = rawContent;
				}
			}
		}

		// Compute fingerprint from plaintext (always consistent regardless of encryption)
		const fingerprintHex = await hashContent(plaintext);
		const fingerprint = `sha256:${fingerprintHex}`;

		// Read local file mtime if available
		const localFile = this.app.vault.getAbstractFileByPath(vaultPath);
		const clientMtime = localFile instanceof TFile ? localFile.stat.mtime : Date.now();

		const metadata = encodeMetadata({
			fingerprint,
			clientMtime,
			deviceId: this.deviceId,
		});

		await this.s3Provider.uploadFile(s3Key, uploadPayload, { metadata });
	}

	/**
	 * Propagate the encryption key (or null) to all consumers.
	 */
	private propagateKey(key: Uint8Array | null): void {
		this.encryptionKey = key;
		this.payloadCodec.updateKey(key);
		this.snapshotCreator.setEncryptionKey(key);
		this.backupDownloader.setEncryptionKey(key);
	}

	/** Update settings reference when settings change externally. */
	updateSettings(settings: S3SyncBackupSettings): void {
		this.settings = settings;
		this.vaultMarker = new VaultMarker(this.s3Provider, settings.syncPrefix);
	}
}
