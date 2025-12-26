/**
 * File Hasher Module
 *
 * Provides SHA-256 hashing for file content using hash-wasm.
 * Used for detecting file changes and verifying file integrity.
 */

import { sha256 } from 'hash-wasm';

/**
 * Compute SHA-256 hash of content
 *
 * @param content - Content to hash (string or Uint8Array)
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashContent(content: string | Uint8Array): Promise<string> {
    if (typeof content === 'string') {
        return await sha256(content);
    }
    return await sha256(content);
}

/**
 * Compute SHA-256 hash from ArrayBuffer
 *
 * @param buffer - ArrayBuffer to hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashArrayBuffer(buffer: ArrayBuffer): Promise<string> {
    return await sha256(new Uint8Array(buffer));
}

/**
 * Check if two contents are identical by comparing hashes
 *
 * @param content1 - First content
 * @param content2 - Second content
 * @returns true if hashes match
 */
export async function contentsMatch(
    content1: string | Uint8Array,
    content2: string | Uint8Array
): Promise<boolean> {
    const hash1 = await hashContent(content1);
    const hash2 = await hashContent(content2);
    return hash1 === hash2;
}
