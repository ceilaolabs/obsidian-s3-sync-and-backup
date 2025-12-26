/**
 * File Encryptor Module
 *
 * Provides XSalsa20-Poly1305 encryption for file content using TweetNaCl.
 * Used for E2E encryption of synced and backed up files.
 */

import nacl from 'tweetnacl';

/**
 * Nonce size in bytes (24 bytes for XSalsa20)
 */
const NONCE_SIZE = 24;

/**
 * Encrypt content using XSalsa20-Poly1305
 *
 * @param content - Content to encrypt (string or Uint8Array)
 * @param key - 32-byte encryption key
 * @returns Encrypted content as Uint8Array (nonce + ciphertext)
 */
export function encrypt(content: string | Uint8Array, key: Uint8Array): Uint8Array {
    if (key.length !== 32) {
        throw new Error('Encryption key must be 32 bytes');
    }

    // Convert string to Uint8Array if needed
    const plaintext = typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content;

    // Generate random nonce
    const nonce = nacl.randomBytes(NONCE_SIZE);

    // Encrypt using secretbox (XSalsa20-Poly1305)
    const ciphertext = nacl.secretbox(plaintext, nonce, key);

    // Combine nonce + ciphertext
    const encrypted = new Uint8Array(NONCE_SIZE + ciphertext.length);
    encrypted.set(nonce, 0);
    encrypted.set(ciphertext, NONCE_SIZE);

    return encrypted;
}

/**
 * Decrypt content using XSalsa20-Poly1305
 *
 * @param encrypted - Encrypted content (nonce + ciphertext)
 * @param key - 32-byte encryption key
 * @returns Decrypted content as Uint8Array
 * @throws Error if decryption fails (wrong key or corrupted data)
 */
export function decrypt(encrypted: Uint8Array, key: Uint8Array): Uint8Array {
    if (key.length !== 32) {
        throw new Error('Encryption key must be 32 bytes');
    }

    if (encrypted.length < NONCE_SIZE + 16) { // 16 is Poly1305 tag size
        throw new Error('Encrypted data too short');
    }

    // Extract nonce and ciphertext
    const nonce = encrypted.slice(0, NONCE_SIZE);
    const ciphertext = encrypted.slice(NONCE_SIZE);

    // Decrypt using secretbox.open
    const plaintext = nacl.secretbox.open(ciphertext, nonce, key);

    if (!plaintext) {
        throw new Error('Decryption failed: invalid key or corrupted data');
    }

    return plaintext;
}

/**
 * Decrypt content and return as string
 *
 * @param encrypted - Encrypted content
 * @param key - 32-byte encryption key
 * @returns Decrypted content as string
 */
export function decryptToString(encrypted: Uint8Array, key: Uint8Array): string {
    const plaintext = decrypt(encrypted, key);
    return new TextDecoder().decode(plaintext);
}

/**
 * Check if content appears to be encrypted
 * (Simple heuristic - encrypted content is random bytes)
 *
 * @param content - Content to check
 * @returns true if likely encrypted
 */
export function isLikelyEncrypted(content: Uint8Array): boolean {
    // Encrypted content should be at least nonce + tag size
    return content.length >= NONCE_SIZE + 16;
}

/**
 * Get the overhead added by encryption (nonce + auth tag)
 */
export function getEncryptionOverhead(): number {
    return NONCE_SIZE + 16; // 24 byte nonce + 16 byte Poly1305 tag
}
