/**
 * Vault Marker Module
 *
 * Manages the vault.enc encryption marker file stored in S3.
 * Used to verify passphrase on additional devices and prevent
 * sync with wrong passphrase.
 */

import { App } from 'obsidian';
import { S3Provider } from '../storage/S3Provider';
import { EncryptionMarkerState, PayloadFormat, VaultEncryptionMarker } from '../types';
import { deriveKey, bytesToBase64, base64ToBytes, generateSalt } from './KeyDerivation';
import { encrypt, decrypt } from './FileEncryptor';

/**
 * Verification token for passphrase validation
 * This known string is encrypted with the derived key
 */
const VERIFICATION_TOKEN = 'OBSIDIAN_S3_SYNC_VAULT_MARKER_V1';

/**
 * Path to vault.enc marker file relative to sync prefix
 */
const MARKER_PATH = '.obsidian-s3-sync/.vault.enc';

/**
 * VaultMarker class - Manages encryption marker
 */
export class VaultMarker {
    private s3Provider: S3Provider;
    private syncPrefix: string;

    constructor(s3Provider: S3Provider, syncPrefix: string) {
        this.s3Provider = s3Provider;
        this.syncPrefix = syncPrefix;
    }

    /**
     * Get full S3 key for marker file
     */
    private getMarkerKey(): string {
        return `${this.syncPrefix}/${MARKER_PATH}`;
    }

    /**
     * Check if vault marker exists (vault is encrypted)
     */
    async exists(): Promise<boolean> {
        try {
            return await this.s3Provider.fileExists(this.getMarkerKey());
        } catch {
            return false;
        }
    }

    /**
     * Create a new vault marker (first-time encryption setup)
     *
     * @param passphrase - User's passphrase
     * @param deviceId - Current device identifier
     * @returns The derived encryption key
     */
    async create(passphrase: string, deviceId: string): Promise<Uint8Array> {
        // Generate salt and derive key
        const salt = generateSalt();
        const key = await deriveKey(passphrase, salt);

        // Encrypt verification token
        const tokenBytes = new TextEncoder().encode(VERIFICATION_TOKEN);
        const encryptedToken = encrypt(tokenBytes, key);

        const now = new Date().toISOString();

        // Create marker with 'transitioning' state — caller must flip to 'enabled'
        // after all files have been re-uploaded encrypted.
        const marker: VaultEncryptionMarker = {
            version: 3,
            salt: bytesToBase64(salt),
            verificationToken: bytesToBase64(encryptedToken),
            state: 'transitioning',
            fromMode: 'plaintext-v1',
            targetMode: 'xsalsa20poly1305-v1',
            migrationId: crypto.randomUUID(),
            createdAt: now,
            createdBy: deviceId,
            updatedAt: now,
            updatedBy: deviceId,
        };

        // Upload marker to S3
        const markerJson = JSON.stringify(marker, null, 2);
        await this.s3Provider.uploadFile(this.getMarkerKey(), markerJson, 'application/json');

        return key;
    }

    /**
     * Verify passphrase against existing marker
     *
     * @param passphrase - Passphrase to verify
     * @returns The derived encryption key if valid, null if invalid
     */
    async verify(passphrase: string): Promise<Uint8Array | null> {
        try {
            // Download marker
            const markerJson = await this.s3Provider.downloadFileAsText(this.getMarkerKey());
            const marker = JSON.parse(markerJson) as VaultEncryptionMarker;

            // Derive key with stored salt
            const salt = base64ToBytes(marker.salt);
            const key = await deriveKey(passphrase, salt);

            // Try to decrypt verification token
            const encryptedToken = base64ToBytes(marker.verificationToken);
            const decryptedToken = decrypt(encryptedToken, key);
            const tokenString = new TextDecoder().decode(decryptedToken);

            // Verify token matches expected value
            if (tokenString === VERIFICATION_TOKEN) {
                return key;
            }

            return null;
        } catch (error) {
            // Decryption failed or other error
            console.error('Passphrase verification failed:', error);
            return null;
        }
    }

    /**
     * Get marker metadata without verifying passphrase
     */
    async getMetadata(): Promise<Omit<VaultEncryptionMarker, 'verificationToken'> | null> {
        try {
            const markerJson = await this.s3Provider.downloadFileAsText(this.getMarkerKey());
            const marker = JSON.parse(markerJson) as VaultEncryptionMarker;

            return {
                version: marker.version,
                salt: marker.salt,
                state: marker.state ?? 'enabled',
                fromMode: marker.fromMode,
                targetMode: marker.targetMode,
                migrationId: marker.migrationId,
                createdAt: marker.createdAt,
                createdBy: marker.createdBy,
                updatedAt: marker.updatedAt ?? marker.createdAt,
                updatedBy: marker.updatedBy ?? marker.createdBy,
            };
        } catch {
            return null;
        }
    }

    /**
     * Update the marker's state field without re-deriving the key.
     *
     * When transitioning to `'transitioning'`, `fromMode` and `targetMode` must be
     * provided. When transitioning to `'enabled'`, the migration fields are cleared.
     *
     * @param newState  - The target encryption state.
     * @param deviceId  - The device performing the state transition.
     * @param migration - Required when `newState === 'transitioning'`: the source and
     *   target payload formats plus a unique migration ID for resume detection.
     */
    async updateState(
        newState: EncryptionMarkerState,
        deviceId: string,
        migration?: { fromMode: PayloadFormat; targetMode: PayloadFormat; migrationId: string },
    ): Promise<void> {
        const markerJson = await this.s3Provider.downloadFileAsText(this.getMarkerKey());
        const marker = JSON.parse(markerJson) as VaultEncryptionMarker;

        marker.state = newState;
        marker.updatedAt = new Date().toISOString();
        marker.updatedBy = deviceId;

        if (newState === 'transitioning' && migration) {
            marker.fromMode = migration.fromMode;
            marker.targetMode = migration.targetMode;
            marker.migrationId = migration.migrationId;
        } else if (newState === 'enabled') {
            delete marker.fromMode;
            delete marker.targetMode;
            delete marker.migrationId;
        }

        if (marker.version < 3) {
            marker.version = 3;
        }

        const updatedJson = JSON.stringify(marker, null, 2);
        await this.s3Provider.uploadFile(this.getMarkerKey(), updatedJson, 'application/json');
    }

    /**
     * Delete vault marker (disable encryption)
     * WARNING: This will make encrypted files unreadable
     */
    async delete(): Promise<void> {
        await this.s3Provider.deleteFile(this.getMarkerKey());
    }
}

/**
 * Vault-scoped local storage key for the device ID.
 *
 * This is the single canonical key used by both the sync engine and
 * backup/encryption subsystems.  Obsidian's {@link App.loadLocalStorage}
 * and {@link App.saveLocalStorage} automatically namespace the key
 * per-vault, so two vaults on the same device receive independent IDs.
 */
const DEVICE_ID_STORAGE_KEY = 's3-sync-device-id';

/**
 * Legacy global localStorage key used by versions prior to the
 * vault-scoped migration.  Checked once during migration so existing
 * users keep the same device ID in their first vault after the upgrade.
 */
const LEGACY_GLOBAL_STORAGE_KEY = 'obsidian-s3-sync-device-id';

/**
 * Generate a unique device ID using cryptographically random bytes.
 *
 * Format: `device-<16 hex chars>` (8 random bytes).
 *
 * @returns A new device ID string
 */
export function generateDeviceId(): string {
    const random = new Uint8Array(8);
    crypto.getRandomValues(random);
    const hex = Array.from(random)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return `device-${hex}`;
}

/**
 * Get or create a vault-scoped device ID.
 *
 * Uses Obsidian's vault-scoped storage ({@link App.loadLocalStorage} /
 * {@link App.saveLocalStorage}) so each vault on the same machine gets
 * its own device ID.  This prevents cross-vault contamination when a
 * single user runs multiple vaults.
 *
 * **Migration**: On first call after upgrade, if vault-scoped storage is
 * empty the function checks the legacy global `window.localStorage` key
 * (`obsidian-s3-sync-device-id`) and adopts that value for this vault.
 * The global key is intentionally left intact so other vaults (not yet
 * upgraded) can also migrate independently.
 *
 * @param app - The Obsidian {@link App} instance (provides vault-scoped storage)
 * @returns The device ID for this vault
 */
export function getOrCreateDeviceId(app: App): string {
    // 1. Try vault-scoped storage first
    const existing = app.loadLocalStorage(DEVICE_ID_STORAGE_KEY) as string | null;
    if (existing) {
        return existing;
    }

    // 2. Migrate from legacy global localStorage if available
    let deviceId: string | null = null;
    try {
        deviceId = window.localStorage.getItem(LEGACY_GLOBAL_STORAGE_KEY);
    } catch {
        // window.localStorage may not be available in all environments
    }

    // 3. Generate a fresh ID if no legacy value exists
    if (!deviceId) {
        deviceId = generateDeviceId();
    }

    // 4. Persist into vault-scoped storage
    app.saveLocalStorage(DEVICE_ID_STORAGE_KEY, deviceId);
    return deviceId;
}
