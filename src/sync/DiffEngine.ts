/**
 * Diff Engine Module
 *
 * Provides three-way diff detection for sync conflict resolution.
 * Compares local, remote, and journal (base) states to determine sync actions.
 */

import { SyncJournalEntry } from '../types';

/**
 * Diff result types
 */
export type DiffResult =
    | 'unchanged'        // No changes
    | 'local-only'       // Only local changed
    | 'remote-only'      // Only remote changed
    | 'both-changed'     // Both changed (conflict)
    | 'new-local'        // New local file (not in journal)
    | 'new-remote'       // New remote file (not in journal)
    | 'deleted-local'    // Deleted locally
    | 'deleted-remote';  // Deleted remotely

/**
 * File state for diff comparison
 */
export interface FileSnapshot {
    exists: boolean;
    hash?: string;
    mtime?: number;
}

/**
 * Compare local, remote, and base states to determine diff result
 *
 * This implements three-way merge logic:
 * - Base state is from the sync journal (last known synced state)
 * - Local state is current file in vault
 * - Remote state is current file in S3
 *
 * @param local - Local file state
 * @param remote - Remote file state
 * @param journal - Journal entry (base state) or undefined if never synced
 * @returns Diff result indicating what changed
 */
export function computeThreeWayDiff(
    local: FileSnapshot,
    remote: FileSnapshot,
    journal?: SyncJournalEntry
): DiffResult {
    // Case: File exists in both local and remote
    if (local.exists && remote.exists) {
        // If hashes match, no changes
        if (local.hash && remote.hash && local.hash === remote.hash) {
            return 'unchanged';
        }

        // If no journal entry, this is first sync
        if (!journal) {
            // Both exist but never synced - compare timestamps to decide
            // Caller should handle this as potential conflict or merge
            return 'both-changed';
        }

        // Check if local changed from base
        const localChanged = local.hash !== journal.localHash;
        // Check if remote changed from base
        const remoteChanged = remote.hash !== journal.remoteHash;

        if (localChanged && remoteChanged) {
            return 'both-changed';
        } else if (localChanged) {
            return 'local-only';
        } else if (remoteChanged) {
            return 'remote-only';
        } else {
            return 'unchanged';
        }
    }

    // Case: Only exists locally
    if (local.exists && !remote.exists) {
        if (journal) {
            // Was previously synced, now missing remotely
            return 'deleted-remote';
        } else {
            // New local file
            return 'new-local';
        }
    }

    // Case: Only exists remotely
    if (!local.exists && remote.exists) {
        if (journal) {
            // Was previously synced, now missing locally
            return 'deleted-local';
        } else {
            // New remote file
            return 'new-remote';
        }
    }

    // Case: Neither exists (shouldn't happen in practice)
    return 'unchanged';
}

/**
 * Determine sync action from diff result
 *
 * @param diff - Diff result
 * @returns Recommended action
 */
export function diffToAction(diff: DiffResult): string {
    switch (diff) {
        case 'unchanged':
            return 'skip';
        case 'local-only':
        case 'new-local':
            return 'upload';
        case 'remote-only':
        case 'new-remote':
            return 'download';
        case 'deleted-local':
            return 'delete-remote';
        case 'deleted-remote':
            return 'delete-local';
        case 'both-changed':
            return 'conflict';
    }
}

/**
 * Check if two files are identical by hash
 *
 * @param hash1 - First file hash
 * @param hash2 - Second file hash
 * @returns true if hashes match (or both undefined)
 */
export function hashesMatch(hash1?: string, hash2?: string): boolean {
    if (!hash1 || !hash2) return false;
    return hash1 === hash2;
}
