/**
 * Unit tests for DiffEngine module
 * Tests three-way diff logic for sync conflicts
 */

import { computeThreeWayDiff, diffToAction, FileSnapshot, hashesMatch } from '../../src/sync/DiffEngine';
import { SyncJournalEntry } from '../../src/types';

describe('DiffEngine', () => {
    describe('computeThreeWayDiff', () => {
        it('should detect unchanged files', () => {
            const local: FileSnapshot = { exists: true, hash: 'abc123' };
            const remote: FileSnapshot = { exists: true, hash: 'abc123' };
            const journal: SyncJournalEntry = {
                path: 'file.md',
                localHash: 'abc123',
                remoteHash: 'abc123',
                lastSyncTime: Date.now(),
                modifiedTime: Date.now(),
                status: 'synced',
            };

            const result = computeThreeWayDiff(local, remote, journal);
            expect(result).toBe('unchanged');
        });

        it('should detect new local file', () => {
            const local: FileSnapshot = { exists: true, hash: 'abc123' };
            const remote: FileSnapshot = { exists: false };

            const result = computeThreeWayDiff(local, remote);
            expect(result).toBe('new-local');
        });

        it('should detect new remote file', () => {
            const local: FileSnapshot = { exists: false };
            const remote: FileSnapshot = { exists: true, hash: 'abc123' };

            const result = computeThreeWayDiff(local, remote);
            expect(result).toBe('new-remote');
        });

        it('should detect local-only changes', () => {
            const local: FileSnapshot = { exists: true, hash: 'new-hash' };
            const remote: FileSnapshot = { exists: true, hash: 'old-hash' };
            const journal: SyncJournalEntry = {
                path: 'file.md',
                localHash: 'old-hash',
                remoteHash: 'old-hash',
                lastSyncTime: Date.now(),
                modifiedTime: Date.now(),
                status: 'synced',
            };

            const result = computeThreeWayDiff(local, remote, journal);
            expect(result).toBe('local-only');
        });

        it('should detect remote-only changes', () => {
            const local: FileSnapshot = { exists: true, hash: 'old-hash' };
            const remote: FileSnapshot = { exists: true, hash: 'new-hash' };
            const journal: SyncJournalEntry = {
                path: 'file.md',
                localHash: 'old-hash',
                remoteHash: 'old-hash',
                lastSyncTime: Date.now(),
                modifiedTime: Date.now(),
                status: 'synced',
            };

            const result = computeThreeWayDiff(local, remote, journal);
            expect(result).toBe('remote-only');
        });

        it('should detect both-changed (conflict)', () => {
            const local: FileSnapshot = { exists: true, hash: 'local-new' };
            const remote: FileSnapshot = { exists: true, hash: 'remote-new' };
            const journal: SyncJournalEntry = {
                path: 'file.md',
                localHash: 'old-hash',
                remoteHash: 'old-hash',
                lastSyncTime: Date.now(),
                modifiedTime: Date.now(),
                status: 'synced',
            };

            const result = computeThreeWayDiff(local, remote, journal);
            expect(result).toBe('both-changed');
        });

        it('should detect deleted-local', () => {
            const local: FileSnapshot = { exists: false };
            const remote: FileSnapshot = { exists: true, hash: 'abc123' };
            const journal: SyncJournalEntry = {
                path: 'file.md',
                localHash: 'abc123',
                remoteHash: 'abc123',
                lastSyncTime: Date.now(),
                modifiedTime: Date.now(),
                status: 'synced',
            };

            const result = computeThreeWayDiff(local, remote, journal);
            expect(result).toBe('deleted-local');
        });

        it('should detect deleted-remote', () => {
            const local: FileSnapshot = { exists: true, hash: 'abc123' };
            const remote: FileSnapshot = { exists: false };
            const journal: SyncJournalEntry = {
                path: 'file.md',
                localHash: 'abc123',
                remoteHash: 'abc123',
                lastSyncTime: Date.now(),
                modifiedTime: Date.now(),
                status: 'synced',
            };

            const result = computeThreeWayDiff(local, remote, journal);
            expect(result).toBe('deleted-remote');
        });

        it('should treat first-time sync with both existing as conflict', () => {
            const local: FileSnapshot = { exists: true, hash: 'hash1' };
            const remote: FileSnapshot = { exists: true, hash: 'hash2' };

            const result = computeThreeWayDiff(local, remote);
            expect(result).toBe('both-changed');
        });
    });

    describe('diffToAction', () => {
        it('should skip unchanged files', () => {
            expect(diffToAction('unchanged')).toBe('skip');
        });

        it('should upload local-only files', () => {
            expect(diffToAction('local-only')).toBe('upload');
            expect(diffToAction('new-local')).toBe('upload');
        });

        it('should download remote-only files', () => {
            expect(diffToAction('remote-only')).toBe('download');
            expect(diffToAction('new-remote')).toBe('download');
        });

        it('should delete remote for deleted-remote', () => {
            expect(diffToAction('deleted-remote')).toBe('delete-local');
        });

        it('should delete local for deleted-local', () => {
            expect(diffToAction('deleted-local')).toBe('delete-remote');
        });

        it('should mark both-changed as conflict', () => {
            expect(diffToAction('both-changed')).toBe('conflict');
        });
    });

    describe('hashesMatch', () => {
        it('should return true for matching hashes', () => {
            expect(hashesMatch('abc123', 'abc123')).toBe(true);
        });

        it('should return false for different hashes', () => {
            expect(hashesMatch('abc123', 'def456')).toBe(false);
        });

        it('should return false when first hash is undefined', () => {
            expect(hashesMatch(undefined, 'abc123')).toBe(false);
        });

        it('should return false when second hash is undefined', () => {
            expect(hashesMatch('abc123', undefined)).toBe(false);
        });

        it('should return false when both hashes are undefined', () => {
            expect(hashesMatch(undefined, undefined)).toBe(false);
        });

        it('should be case-sensitive', () => {
            expect(hashesMatch('ABC123', 'abc123')).toBe(false);
        });

        it('should handle empty string hashes', () => {
            expect(hashesMatch('', '')).toBe(false);
        });
    });
});
