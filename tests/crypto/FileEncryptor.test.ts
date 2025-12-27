/**
 * Unit tests for FileEncryptor module
 * 
 * Tests XSalsa20-Poly1305 authenticated encryption using TweetNaCl.
 * This is critical security code - tests verify:
 * - Correct encryption/decryption roundtrips
 * - Authentication tag validation (tamper detection)
 * - Nonce uniqueness (prevents replay attacks)
 * - Proper handling of edge cases (empty data, large files)
 */

import { encrypt, decrypt, decryptToString, isLikelyEncrypted, getEncryptionOverhead } from '../../src/crypto/FileEncryptor';

describe('FileEncryptor', () => {
    // Test key: deterministic 32-byte key for reproducible tests
    // In production, keys are derived from user passphrase via Argon2id
    const testKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        testKey[i] = i;
    }

    describe('encrypt', () => {
        /**
         * Verifies basic encryption functionality
         * - Output differs from input (confidentiality)
         * - Output length = input + 40 bytes (24-byte nonce + 16-byte Poly1305 tag)
         */
        it('should encrypt content', () => {
            const content = new TextEncoder().encode('Hello, World!');
            const encrypted = encrypt(content, testKey);

            expect(encrypted).not.toEqual(content);
            expect(encrypted.length).toBe(content.length + 24 + 16);
        });

        /**
         * Edge case: encrypting empty content should still produce valid ciphertext
         * Important for syncing empty files or deleted content markers
         */
        it('should handle empty content', () => {
            const content = new Uint8Array(0);
            const encrypted = encrypt(content, testKey);

            // Empty plaintext still gets nonce + auth tag
            expect(encrypted.length).toBe(24 + 16);
        });

        /**
         * SECURITY: Verifies nonce uniqueness across encryptions
         * Same plaintext + same key must produce different ciphertext each time
         * This prevents attackers from detecting when same content is re-encrypted
         */
        it('should produce different ciphertext each time (random nonce)', () => {
            const content = new TextEncoder().encode('test');

            const encrypted1 = encrypt(content, testKey);
            const encrypted2 = encrypt(content, testKey);

            // Different nonces → different ciphertext
            expect(encrypted1).not.toEqual(encrypted2);
        });

        /**
         * Performance test: verifies encryption works on large files
         * 1MB is a reasonable upper bound for Obsidian notes
         */
        it('should handle large content', () => {
            const largeContent = new Uint8Array(1024 * 1024); // 1MB
            for (let i = 0; i < largeContent.length; i++) {
                largeContent[i] = i % 256;
            }

            const encrypted = encrypt(largeContent, testKey);

            expect(encrypted.length).toBe(largeContent.length + 24 + 16);
        });
    });

    describe('decrypt', () => {
        /**
         * Verifies encryption/decryption roundtrip: decrypt(encrypt(x)) = x
         * This is the fundamental requirement for any encryption scheme
         */
        it('should decrypt encrypted content', () => {
            const original = new TextEncoder().encode('Secret message');
            const encrypted = encrypt(original, testKey);
            const decrypted = decrypt(encrypted, testKey);

            expect(decrypted).toEqual(original);
        });

        /**
         * Edge case: empty content roundtrip
         */
        it('should handle empty content', () => {
            const original = new Uint8Array(0);
            const encrypted = encrypt(original, testKey);
            const decrypted = decrypt(encrypted, testKey);

            expect(decrypted).toEqual(original);
        });

        /**
         * SECURITY: Wrong decryption key must be rejected
         * Poly1305 authentication prevents decryption with wrong key
         */
        it('should throw error with wrong key', () => {
            const original = new TextEncoder().encode('test');
            const encrypted = encrypt(original, testKey);

            // Create different key
            const wrongKey = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                wrongKey[i] = 255 - i;
            }

            expect(() => decrypt(encrypted, wrongKey)).toThrow();
        });

        /**
         * SECURITY: Tampered ciphertext must be detected
         * Poly1305 MAC provides authentication - any bit flip should fail
         */
        it('should throw error with tampered ciphertext', () => {
            const original = new TextEncoder().encode('test');
            const encrypted = encrypt(original, testKey);

            // Tamper with one bit in the ciphertext
            const tampered = new Uint8Array(encrypted);
            tampered[30] ^= 1; // XOR bit flip

            expect(() => decrypt(tampered, testKey)).toThrow();
        });

        /**
         * Input validation: reject impossibly short ciphertext
         * Minimum valid ciphertext is 40 bytes (24 nonce + 16 tag)
         */
        it('should throw error with invalid encrypted data length', () => {
            const tooShort = new Uint8Array(10);

            expect(() => decrypt(tooShort, testKey)).toThrow();
        });
    });

    describe('encrypt/decrypt roundtrip', () => {
        /**
         * Verifies Unicode handling through TextEncoder/Decoder
         * Important for international users with non-ASCII content
         */
        it('should roundtrip text content', () => {
            const original = new TextEncoder().encode('This is a test message with unicode: 日本語');
            const encrypted = encrypt(original, testKey);
            const decrypted = decrypt(encrypted, testKey);

            expect(decrypted).toEqual(original);

            // Verify text decoding works
            const text = new TextDecoder().decode(decrypted);
            expect(text).toBe('This is a test message with unicode: 日本語');
        });

        /**
         * Verifies handling of arbitrary binary data
         * Important for images, PDFs, or other non-text files
         */
        it('should roundtrip binary content', () => {
            const original = new Uint8Array([0, 1, 2, 127, 128, 255, 254, 253]);
            const encrypted = encrypt(original, testKey);
            const decrypted = decrypt(encrypted, testKey);

            expect(decrypted).toEqual(original);
        });

        /**
         * Performance test: 100KB roundtrip
         * Verifies correctness at moderate file sizes
         */
        it('should roundtrip large content', () => {
            const original = new Uint8Array(100000);
            for (let i = 0; i < original.length; i++) {
                original[i] = i % 256;
            }

            const encrypted = encrypt(original, testKey);
            const decrypted = decrypt(encrypted, testKey);

            expect(decrypted).toEqual(original);
        });
    });

    describe('key requirements', () => {
        /**
         * XSalsa20-Poly1305 requires exactly 32-byte keys
         * Shorter keys must be rejected for security
         */
        it('should require 32-byte key for encryption', () => {
            const content = new TextEncoder().encode('test');
            const shortKey = new Uint8Array(16);

            expect(() => encrypt(content, shortKey)).toThrow();
        });

        /**
         * Decryption key length validation
         */
        it('should require 32-byte key for decryption', () => {
            const content = new TextEncoder().encode('test');
            const encrypted = encrypt(content, testKey);
            const shortKey = new Uint8Array(16);

            expect(() => decrypt(encrypted, shortKey)).toThrow();
        });
    });

    describe('nonce handling', () => {
        /**
         * SECURITY: Verifies nonce randomness
         * Nonces are prepended to ciphertext and must be unique
         */
        it('should include unique nonce in encrypted data', () => {
            const content = new TextEncoder().encode('test');

            const enc1 = encrypt(content, testKey);
            const enc2 = encrypt(content, testKey);

            // Extract nonces (first 24 bytes)
            const nonce1 = enc1.slice(0, 24);
            const nonce2 = enc2.slice(0, 24);

            expect(nonce1).not.toEqual(nonce2);
        });

        /**
         * Verifies nonce is correctly extracted during decryption
         * The nonce used for decryption must match the one used for encryption
         */
        it('should use nonce from encrypted data for decryption', () => {
            const original = new TextEncoder().encode('test message');
            const encrypted = encrypt(original, testKey);

            // Decrypt should extract and use the prepended nonce
            const decrypted = decrypt(encrypted, testKey);

            expect(decrypted).toEqual(original);
        });
    });

    describe('utility functions', () => {
        /**
         * Tests convenience function for text decryption
         * Commonly used for decrypting note content
         */
        it('should decrypt to string', () => {
            const original = 'Hello, World! 日本語';
            const content = new TextEncoder().encode(original);
            const encrypted = encrypt(content, testKey);

            const decrypted = decryptToString(encrypted, testKey);
            expect(decrypted).toBe(original);
        });

        /**
         * Edge case: empty string decryption
         */
        it('should handle empty string decryption', () => {
            const content = new TextEncoder().encode('');
            const encrypted = encrypt(content, testKey);

            const decrypted = decryptToString(encrypted, testKey);
            expect(decrypted).toBe('');
        });

        /**
         * Tests heuristic for detecting encrypted content
         * Used to determine if a file needs decryption before reading
         * Simple check: encrypted data >= 40 bytes (nonce + tag)
         */
        it('should detect likely encrypted content', () => {
            const content = new TextEncoder().encode('test');
            const encrypted = encrypt(content, testKey);

            expect(isLikelyEncrypted(encrypted)).toBe(true);
            expect(isLikelyEncrypted(content)).toBe(false);
        });

        /**
         * Heuristic boundary: data < 40 bytes cannot be encrypted
         */
        it('should not detect short data as encrypted', () => {
            const tooShort = new Uint8Array(10);
            expect(isLikelyEncrypted(tooShort)).toBe(false);
        });

        /**
         * Boundary case: exactly 40 bytes is minimum valid encrypted size
         * (empty plaintext + 24 nonce + 16 tag = 40 bytes)
         */
        it('should detect exact minimum length as encrypted', () => {
            const minLength = new Uint8Array(40);
            expect(isLikelyEncrypted(minLength)).toBe(true);
        });

        /**
         * Verifies overhead constant is correct
         * Used for estimating encrypted file sizes
         */
        it('should return correct encryption overhead', () => {
            expect(getEncryptionOverhead()).toBe(40); // 24 nonce + 16 tag
        });

        /**
         * Cross-validation: overhead constant matches actual encryption behavior
         * If this fails, the constant is out of sync with implementation
         */
        it('should verify overhead matches actual encryption size difference', () => {
            const content = new TextEncoder().encode('test data');
            const encrypted = encrypt(content, testKey);

            const overhead = encrypted.length - content.length;
            expect(overhead).toBe(getEncryptionOverhead());
        });
    });
});
