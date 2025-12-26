/**
 * Vault Marker Module
 *
 * Manages the vault.enc encryption marker file stored in S3.
 * Used to verify passphrase on additional devices and prevent
 * sync with wrong passphrase.
 */

import { S3Provider } from '../storage/S3Provider';
import { VaultEncryptionMarker } from '../types';
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

        // Create marker object
        const marker: VaultEncryptionMarker = {
            version: 1,
            salt: bytesToBase64(salt),
            verificationToken: bytesToBase64(encryptedToken),
            createdAt: new Date().toISOString(),
            createdBy: deviceId,
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

            // Return metadata without sensitive fields
            return {
                version: marker.version,
                salt: marker.salt,
                createdAt: marker.createdAt,
                createdBy: marker.createdBy,
            };
        } catch {
            return null;
        }
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
 * Generate a unique device ID
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
 * Get or create device ID
 * Uses a simple random ID - note: localStorage is used here as this is
 * for device identification, not vault-specific data
 */
export function getOrCreateDeviceId(): string {
    const STORAGE_KEY = 'obsidian-s3-sync-device-id';

    // Try to get existing device ID from window localStorage
    // Note: Using window.localStorage directly as this is device-specific, not vault-specific
    let deviceId = window.localStorage.getItem(STORAGE_KEY);

    if (!deviceId) {
        // Generate new device ID
        deviceId = generateDeviceId();
        window.localStorage.setItem(STORAGE_KEY, deviceId);
    }

    return deviceId;
}
