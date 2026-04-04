/**
 * Vault file helpers shared by sync and backup flows.
 */

import { TFile, Vault } from 'obsidian';
import { VaultFileKind } from '../types';
import { getExtension } from './paths';

/**
 * Text-based extensions that should be handled with Obsidian text APIs.
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
 * Determine how a vault path should be handled.
 */
export function getVaultFileKind(path: string): VaultFileKind {
    const extension = getExtension(path).toLowerCase();

    if (!extension) {
        return 'text';
    }

    return TEXT_FILE_EXTENSIONS.has(extension) ? 'text' : 'binary';
}

/**
 * Read a file from the vault using the correct text/binary API.
 */
export async function readVaultFile(vault: Vault, file: TFile): Promise<string | Uint8Array> {
    if (getVaultFileKind(file.path) === 'text') {
        return await vault.read(file);
    }

    return new Uint8Array(await vault.readBinary(file));
}

/**
 * Convert a Uint8Array to a compact ArrayBuffer.
 */
export function toArrayBuffer(content: Uint8Array): ArrayBuffer {
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
}
