/**
 * Unit tests for KeyDerivation module
 * Tests Argon2id key derivation and passphrase validation
 */

import {
    generateSalt,
    deriveKey,
    deriveKeyWithNewSalt,
    validatePassphrase,
    bytesToBase64,
    base64ToBytes,
} from '../../src/crypto/KeyDerivation';

describe('KeyDerivation', () => {
    describe('generateSalt', () => {
        it('should generate 32-byte salt', () => {
            const salt = generateSalt();
            expect(salt.length).toBe(32);
        });

        it('should generate different salts', () => {
            const salt1 = generateSalt();
            const salt2 = generateSalt();

            expect(salt1).not.toEqual(salt2);
        });

        it('should generate random salts', () => {
            const salts = new Set();
            for (let i = 0; i < 10; i++) {
                const salt = generateSalt();
                const saltStr = Array.from(salt).join(',');
                salts.add(saltStr);
            }

            // All salts should be unique
            expect(salts.size).toBe(10);
        });
    });

    describe('deriveKey', () => {
        it('should derive 32-byte key', async () => {
            const passphrase = 'test-passphrase-123';
            const salt = generateSalt();

            const key = await deriveKey(passphrase, salt);

            expect(key.length).toBe(32);
        });

        it('should produce same key for same passphrase and salt', async () => {
            const passphrase = 'my-secure-passphrase';
            const salt = generateSalt();

            const key1 = await deriveKey(passphrase, salt);
            const key2 = await deriveKey(passphrase, salt);

            expect(key1).toEqual(key2);
        });

        it('should produce different keys for different passphrases', async () => {
            const salt = generateSalt();

            const key1 = await deriveKey('passphrase-A', salt);
            const key2 = await deriveKey('passphrase-B', salt);

            expect(key1).not.toEqual(key2);
        });

        it('should produce different keys for different salts', async () => {
            const passphrase = 'same-passphrase';
            const salt1 = generateSalt();
            const salt2 = generateSalt();

            const key1 = await deriveKey(passphrase, salt1);
            const key2 = await deriveKey(passphrase, salt2);

            expect(key1).not.toEqual(key2);
        });

        it('should throw error for empty passphrase', async () => {
            const salt = generateSalt();

            await expect(deriveKey('', salt)).rejects.toThrow('Passphrase cannot be empty');
        });

        it('should throw error for invalid salt length', async () => {
            const invalidSalt = new Uint8Array(16); // Wrong size

            await expect(deriveKey('test', invalidSalt)).rejects.toThrow('Salt must be 32 bytes');
        });
    });

    describe('deriveKeyWithNewSalt', () => {
        it('should return both key and salt', async () => {
            const passphrase = 'test-passphrase';
            const result = await deriveKeyWithNewSalt(passphrase);

            expect(result.key).toBeDefined();
            expect(result.salt).toBeDefined();
            expect(result.key.length).toBe(32);
            expect(result.salt.length).toBe(32);
        });

        it('should generate different salts each time', async () => {
            const passphrase = 'test';

            const result1 = await deriveKeyWithNewSalt(passphrase);
            const result2 = await deriveKeyWithNewSalt(passphrase);

            expect(result1.salt).not.toEqual(result2.salt);
            expect(result1.key).not.toEqual(result2.key);
        });
    });

    describe('validatePassphrase', () => {
        it('should reject empty passphrase', () => {
            const result = validatePassphrase('');

            expect(result.valid).toBe(false);
            expect(result.strength).toBe('weak');
            expect(result.message).toContain('required');
        });

        it('should reject passphrases shorter than 8 characters', () => {
            const result = validatePassphrase('short');

            expect(result.valid).toBe(false);
            expect(result.strength).toBe('weak');
            expect(result.message).toContain('8 characters');
        });

        it('should accept 8+ character passphrase but mark as weak', () => {
            const result = validatePassphrase('12345678');

            expect(result.valid).toBe(true);
            expect(result.strength).toBe('weak');
        });

        it('should mark fair strength for 12+ chars', () => {
            const result = validatePassphrase('password1234');

            expect(result.valid).toBe(true);
            expect(result.strength).toBe('fair');
        });

        it('should mark strong for 16+ chars', () => {
            const result = validatePassphrase('very-long-passphrase-here');

            expect(result.valid).toBe(true);
            expect(result.strength).toBe('strong');
        });

        it('should mark strong for varied character types', () => {
            const result = validatePassphrase('Pass123!word');

            expect(result.valid).toBe(true);
            expect(result.strength).toBe('strong');
        });

        it('should handle edge case with exactly 12 characters and 1 char type', () => {
            const result = validatePassphrase('aaaaaaaaaaaa'); // exactly 12 lowercase
            expect(result.valid).toBe(true);
            // With 12 chars, it gets 'fair' rating even with low variety
            expect(result.strength).toBe('fair');
        });

        it('should handle passphrase with only special characters', () => {
            const result = validatePassphrase('!@#$%^&*()_+');
            expect(result.valid).toBe(true);
            // 12 chars with 1 variety (special) should be weak or fair
            expect(['weak', 'fair']).toContain(result.strength);
        });

        it('should handle passphrase with only digits', () => {
            const result = validatePassphrase('123456789012');
            expect(result.valid).toBe(true);
            expect(['weak', 'fair']).toContain(result.strength);
        });

        it('should handle mixed case but no special chars', () => {
            const result = validatePassphrase('PasswordTest'); // 12 chars, 2 variety
            expect(result.valid).toBe(true);
            expect(result.strength).toBe('fair');
        });

        it('should handle exactly 16 characters with low variety', () => {
            const result = validatePassphrase('aaaaaaaaaaaaaaaa'); // 16 lowercase
            expect(result.valid).toBe(true);
            expect(result.strength).toBe('strong'); // Length trumps variety
        });

        it('should handle 12 chars with 3 varieties', () => {
            const result = validatePassphrase('Pass1234word'); // lower, upper, digit
            expect(result.valid).toBe(true);
            expect(result.strength).toBe('strong');
        });

        it('should handle 11 chars with high variety', () => {
            const result = validatePassphrase('Pass123!wrd'); // 11 chars, 4 varieties
            expect(result.valid).toBe(true);
            expect(result.strength).toBe('weak'); // Just under 12 char threshold
        });

        it('should handle unicode characters', () => {
            const result = validatePassphrase('密码Password123');
            expect(result.valid).toBe(true);
            expect(result.strength).toBe('strong');
        });

        it('should handle whitespace in passphrase', () => {
            const result = validatePassphrase('my secure passphrase');
            expect(result.valid).toBe(true);
            expect(result.strength).toBe('strong'); // 20 chars
        });
    });

    describe('bytesToBase64', () => {
        it('should encode bytes to base64', () => {
            const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
            const base64 = bytesToBase64(bytes);

            expect(base64).toBe('SGVsbG8=');
        });

        it('should handle empty array', () => {
            const bytes = new Uint8Array(0);
            const base64 = bytesToBase64(bytes);

            expect(base64).toBe('');
        });

        it('should encode binary data', () => {
            const bytes = new Uint8Array([0, 1, 2, 255, 254, 253]);
            const base64 = bytesToBase64(bytes);

            expect(typeof base64).toBe('string');
            expect(base64.length).toBeGreaterThan(0);
        });
    });

    describe('base64ToBytes', () => {
        it('should decode base64 to bytes', () => {
            const base64 = 'SGVsbG8=';
            const bytes = base64ToBytes(base64);

            expect(bytes).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
        });

        it('should handle empty string', () => {
            const bytes = base64ToBytes('');

            expect(bytes.length).toBe(0);
        });

        it('should roundtrip correctly', () => {
            const original = new Uint8Array([0, 1, 2, 127, 255, 254, 253]);
            const base64 = bytesToBase64(original);
            const decoded = base64ToBytes(base64);

            expect(decoded).toEqual(original);
        });
    });
});
