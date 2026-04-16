/**
 * Vault File Read Helpers
 *
 * Determines whether a vault file should be read via Obsidian's text API (`vault.read`)
 * or binary API (`vault.readBinary`) based on file extension, and provides helpers to
 * perform those reads and convert the results for further processing.
 *
 * This module is shared by both the sync flow (`SyncExecutor`) and the backup flow
 * (`SnapshotCreator`) so that extension-based dispatch logic lives in one place.
 *
 * Design rationale: Obsidian exposes two separate vault read methods with different
 * return types. Text files are cheaper to handle as strings (no encoding overhead), while
 * binary files must go through `readBinary` to avoid corruption. The `VaultFileKind`
 * union type and the `TEXT_FILE_EXTENSIONS` allowlist encode that boundary.
 */

import { TFile, Vault } from 'obsidian';
import { VaultFileKind } from '../types';
import { getExtension } from './paths';

/**
 * Allowlist of file extensions whose content is human-readable text.
 *
 * Any extension in this set will be read via `vault.read()` (returns a UTF-8 string).
 * All other extensions fall back to `vault.readBinary()` (returns an `ArrayBuffer`).
 *
 * Inclusion criteria: the file format must be a plain-text, UTF-8 encodable format where
 * reading as a string is both correct and lossless. Binary formats (images, audio, video,
 * compiled files) must NOT be added here — treating them as text risks data corruption.
 */
const TEXT_FILE_EXTENSIONS = new Set([
    'md',
    'markdown',
    'txt',
    'json',
    'canvas',
    'yaml',
    'yml',
    'csv',
    'tsv',
    'svg',
    'html',
    'htm',
    'xml',
    'opml',
    'css',
    'js',
    'cjs',
    'mjs',
    'ts',
    'tsx',
    'jsx',
    'py',
    'sh',
]);

/**
 * Determine how a vault file should be read based on its extension.
 *
 * Files with no extension are treated as text (e.g. `Makefile`, `Dockerfile`).
 * Extension matching is case-insensitive.
 *
 * @param path - The vault-relative file path (extension is extracted internally).
 * @returns `'text'` if the file should be read with `vault.read()`;
 *          `'binary'` if it should be read with `vault.readBinary()`.
 *
 * @example
 * getVaultFileKind('Notes/note.md')        // → 'text'
 * getVaultFileKind('Attachments/img.png')  // → 'binary'
 * getVaultFileKind('Makefile')             // → 'text'  (no extension → text)
 */
export function getVaultFileKind(path: string): VaultFileKind {
    const extension = getExtension(path).toLowerCase();

    if (!extension) {
        return 'text';
    }

    return TEXT_FILE_EXTENSIONS.has(extension) ? 'text' : 'binary';
}

/**
 * Read a file from the vault using the correct text or binary API.
 *
 * Delegates to `vault.read()` for text files (returns a UTF-8 string) and
 * `vault.readBinary()` wrapped in a `Uint8Array` for binary files. The caller
 * can distinguish the two cases by checking `typeof result === 'string'`.
 *
 * @param vault - The Obsidian `Vault` instance to read from.
 * @param file  - The `TFile` handle for the vault file to read.
 * @returns A `string` for text files, or a `Uint8Array` for binary files.
 *
 * @example
 * const content = await readVaultFile(vault, file);
 * if (typeof content === 'string') {
 *     // handle text
 * } else {
 *     // handle binary Uint8Array
 * }
 */
export async function readVaultFile(vault: Vault, file: TFile): Promise<string | Uint8Array> {
    if (getVaultFileKind(file.path) === 'text') {
        return await vault.read(file);
    }

    return new Uint8Array(await vault.readBinary(file));
}

/**
 * Convert a `Uint8Array` to a compact, standalone `ArrayBuffer`.
 *
 * A `Uint8Array` is a typed-array *view* — its `.buffer` property may be a larger
 * `ArrayBuffer` that the view only partially covers (non-zero `byteOffset` or
 * `byteLength < buffer.byteLength`). Passing `.buffer` directly to APIs that expect
 * a full `ArrayBuffer` (e.g. encryption functions, S3 `PutObject` body) can cause
 * them to operate on unexpected extra bytes. `.slice()` creates a fresh, zero-offset
 * `ArrayBuffer` containing exactly the bytes of this view.
 *
 * @param content - The `Uint8Array` whose underlying bytes should be extracted.
 * @returns A new `ArrayBuffer` containing exactly `content.byteLength` bytes,
 *          starting at `content.byteOffset` within the original buffer.
 *
 * @example
 * const buf = toArrayBuffer(uint8Array);
 * // buf.byteLength === uint8Array.byteLength  (always true)
 */
export function toArrayBuffer(content: Uint8Array): ArrayBuffer {
    // Uint8Array may be a view into a larger ArrayBuffer; slice creates a compact copy
    // that spans exactly [byteOffset, byteOffset + byteLength) of the original buffer.
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
}
