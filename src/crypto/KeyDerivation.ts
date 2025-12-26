/**
 * Key Derivation Module
 *
 * Provides Argon2id key derivation from user passphrase using hash-wasm.
 * Used for deriving encryption keys for E2E encryption.
 */

import { argon2id } from 'hash-wasm';

/**
 * Argon2id parameters
 * Using OWASP recommended settings for password hashing
 */
const ARGON2_TIME_COST = 3;        // Number of iterations
const ARGON2_MEMORY_COST = 65536;   // 64 MB in KB
const ARGON2_PARALLELISM = 1;       // Parallelism factor
const ARGON2_HASH_LENGTH = 32;      // 32 bytes = 256 bits

/**
 * Generate a random salt
 *
 * @returns 32-byte random salt as Uint8Array
 */
export function generateSalt(): Uint8Array {
    const salt = new Uint8Array(32);
    crypto.getRandomValues(salt);
    return salt;
}

/**
 * Derive encryption key from passphrase using Argon2id
 *
 * @param passphrase - User's passphrase (minimum 12 characters recommended)
 * @param salt - 32-byte salt (use generateSalt() for new keys)
 * @returns 32-byte derived key as Uint8Array
 */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    if (!passphrase || passphrase.length === 0) {
        throw new Error('Passphrase cannot be empty');
    }

    if (salt.length !== 32) {
        throw new Error('Salt must be 32 bytes');
    }

    // Derive key using Argon2id
    const hash = await argon2id({
        password: passphrase,
        salt: salt,
        iterations: ARGON2_TIME_COST,
        memorySize: ARGON2_MEMORY_COST,
        parallelism: ARGON2_PARALLELISM,
        hashLength: ARGON2_HASH_LENGTH,
        outputType: 'binary',
    });

    return new Uint8Array(hash);
}

/**
 * Derive key and return both key and salt (for first-time setup)
 *
 * @param passphrase - User's passphrase
 * @returns Object with key and salt
 */
export async function deriveKeyWithNewSalt(passphrase: string): Promise<{
    key: Uint8Array;
    salt: Uint8Array;
}> {
    const salt = generateSalt();
    const key = await deriveKey(passphrase, salt);
    return { key, salt };
}

/**
 * Validate passphrase strength
 *
 * @param passphrase - Passphrase to validate
 * @returns Object with valid boolean and optional error message
 */
export function validatePassphrase(passphrase: string): {
    valid: boolean;
    strength: 'weak' | 'fair' | 'strong';
    message?: string;
} {
    if (!passphrase || passphrase.length === 0) {
        return { valid: false, strength: 'weak', message: 'Passphrase is required' };
    }

    if (passphrase.length < 8) {
        return { valid: false, strength: 'weak', message: 'Passphrase must be at least 8 characters' };
    }

    if (passphrase.length < 12) {
        return { valid: true, strength: 'weak', message: 'Consider using a longer passphrase' };
    }

    // Check for character variety
    const hasLower = /[a-z]/.test(passphrase);
    const hasUpper = /[A-Z]/.test(passphrase);
    const hasDigit = /\d/.test(passphrase);
    const hasSpecial = /[^a-zA-Z0-9]/.test(passphrase);

    const varietyCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

    if (passphrase.length >= 16 || (passphrase.length >= 12 && varietyCount >= 3)) {
        return { valid: true, strength: 'strong' };
    }

    if (passphrase.length >= 12 || varietyCount >= 2) {
        return { valid: true, strength: 'fair' };
    }

    return { valid: true, strength: 'weak' };
}

/**
 * Convert Uint8Array to base64 string
 */
export function bytesToBase64(bytes: Uint8Array): string {
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 */
export function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
