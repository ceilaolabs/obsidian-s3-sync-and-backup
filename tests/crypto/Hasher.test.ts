/**
 * Unit tests for Hasher module
 * 
 * Tests SHA-256 hashing used for content deduplication and change detection.
 * Hash functions must be:
 * - Deterministic (same input → same output)
 * - Collision-resistant (different inputs → different outputs)
 * - Efficient on large files
 * 
 * Hashes are stored in sync journal and used to detect file changes without
 * downloading entire files from S3.
 */

import { hashContent, hashArrayBuffer, contentsMatch } from '../../src/crypto/Hasher';

describe('Hasher', () => {
    describe('hashContent', () => {
        /**
         * Verifies SHA-256 correctness using a known test vector
         * If this fails, hashing library is broken or misconfigured
         */
        it('should generate SHA-256 hash for content', async () => {
            const content = new TextEncoder().encode('Hello, World!');
            const hash = await hashContent(content);

            // Known SHA-256 hash for "Hello, World!"
            expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
        });

        /**
         * CRITICAL: Determinism test
         * Same content must always produce identical hash
         * Hash is used as cache key in sync journal
         */
        it('should generate consistent hashes for same content', async () => {
            const content = new TextEncoder().encode('test content');

            const hash1 = await hashContent(content);
            const hash2 = await hashContent(content);

            expect(hash1).toBe(hash2);
        });

        /**
         * CRITICAL: Collision resistance
         * Different content must produce different hashes
         * If this fails, we may incorrectly skip syncing changed files
         */
        it('should generate different hashes for different content', async () => {
            const content1 = new TextEncoder().encode('content A');
            const content2 = new TextEncoder().encode('content B');

            const hash1 = await hashContent(content1);
            const hash2 = await hashContent(content2);

            expect(hash1).not.toBe(hash2);
        });

        /**
         * Edge case: empty files are valid (e.g., .gitkeep)
         * Must hash correctly for sync journal
         */
        it('should handle empty content', async () => {
            const content = new Uint8Array(0);
            const hash = await hashContent(content);

            // Known SHA-256 of empty string
            expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        });

        /**
         * Performance: 1MB file hashing
         * Large Obsidian notes with embedded images can be this size
         */
        it('should handle large content', async () => {
            const largeContent = new Uint8Array(1024 * 1024);
            for (let i = 0; i < largeContent.length; i++) {
                largeContent[i] = i % 256;
            }

            const hash = await hashContent(largeContent);

            expect(hash).toHaveLength(64); // SHA-256 = 32 bytes = 64 hex chars
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });

        /**
         * Output format validation
         * Hash-wasm returns lowercase hex string
         */
        it('should return hex string', async () => {
            const content = new TextEncoder().encode('test');
            const hash = await hashContent(content);

            expect(typeof hash).toBe('string');
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });

        /**
         * Binary data Support
         * Images, PDFs, and other non-text files must hash correctly
         */
        it('should handle binary data correctly', async () => {
            const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253]);
            const hash = await hashContent(binaryData);

            expect(hash).toHaveLength(64);
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    describe('hashArrayBuffer', () => {
        /**
         * Verifies ArrayBuffer hashing matches Uint8Array hashing
         * Obsidian's requestUrl returns ArrayBuffer, not Uint8Array
         */
        it('should hash ArrayBuffer correctly', async () => {
            const text = 'Hello, World!';
            const buffer = new TextEncoder().encode(text).buffer;
            const hash = await hashArrayBuffer(buffer);

            expect(hash).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');
        });

        /**
         * Cross-validation: Both hash methods must agree
         * Ensures Obsidian API (ArrayBuffer) and internal (Uint8Array) hashes match
         */
        it('should match hashContent for same data', async () => {
            const text = 'test data';
            const uint8Array = new TextEncoder().encode(text);
            const buffer = uint8Array.buffer;

            const hashFromContent = await hashContent(uint8Array);
            const hashFromBuffer = await hashArrayBuffer(buffer);

            expect(hashFromBuffer).toBe(hashFromContent);
        });

        /**
         * Edge case: empty ArrayBuffer
         */
        it('should handle empty ArrayBuffer', async () => {
            const buffer = new ArrayBuffer(0);
            const hash = await hashArrayBuffer(buffer);

            expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        });

        /**
         * Performance: large ArrayBuffer hashing
         */
        it('should handle large ArrayBuffer', async () => {
            const largeBuffer = new ArrayBuffer(1024 * 1024);
            const view = new Uint8Array(largeBuffer);
            for (let i = 0; i < view.length; i++) {
                view[i] = i % 256;
            }

            const hash = await hashArrayBuffer(largeBuffer);

            expect(hash).toHaveLength(64);
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    describe('contentsMatch', () => {
        /**
         * Utility: compare two Uint8Arrays by hash
         * More efficient than byte-by-byte comparison for large files
         */
        it('should return true for matching Uint8Array content', async () => {
            const content1 = new TextEncoder().encode('test');
            const content2 = new TextEncoder().encode('test');

            expect(await contentsMatch(content1, content2)).toBe(true);
        });

        /**
         * Collision resistance check
         */
        it('should return false for different Uint8Array content', async () => {
            const content1 = new TextEncoder().encode('test1');
            const content2 = new TextEncoder().encode('test2');

            expect(await contentsMatch(content1, content2)).toBe(false);
        });

        /**
         * Type flexibility: accept strings directly
         * Convenience for comparing text content
         */
        it('should work with string content', async () => {
            const content1 = 'test';
            const content2 = 'test';

            expect(await contentsMatch(content1, content2)).toBe(true);
        });

        /**
         * IMPORTANT: Mixed-type support
         * Allows comparing downloaded content (Uint8Array) with
         * local content (string) without manual conversion
         */
        it('should work with mixed types (string and Uint8Array)', async () => {
            const content1 = 'test';
            const content2 = new TextEncoder().encode('test');

            expect(await contentsMatch(content1, content2)).toBe(true);
        });

        /**
         * Mixed-type collision resistance
         */
        it('should return false for different mixed types', async () => {
            const content1 = 'test1';
            const content2 = new TextEncoder().encode('test2');

            expect(await contentsMatch(content1, content2)).toBe(false);
        });

        /**
         * Edge case: empty content comparison
         */
        it('should handle empty content', async () => {
            const content1 = '';
            const content2 = new Uint8Array(0);

            expect(await contentsMatch(content1, content2)).toBe(true);
        });

        /**
         * Unicode support verification
         * Critical for international users
         */
        it('should handle unicode content', async () => {
            const content1 = 'Hello 日本語 🌍';
            const content2 = new TextEncoder().encode('Hello 日本語 🌍');

            expect(await contentsMatch(content1, content2)).toBe(true);
        });
    });
});
