/**
 * Unit tests for SyncJournal mutation helpers.
 *
 * These tests exercise methods directly on a mocked instance so they can
 * validate entry-shaping logic without requiring IndexedDB in Jest.
 */

import { SyncJournal } from '../../src/sync/SyncJournal';
import { SyncJournalEntry } from '../../src/types';

type MockedJournal = SyncJournal & {
    getEntry: jest.Mock<Promise<SyncJournalEntry | undefined>, [string]>;
    setEntry: jest.Mock<Promise<void>, [SyncJournalEntry]>;
};

function createMockJournal(existing?: SyncJournalEntry): MockedJournal {
    const journal = Object.create(SyncJournal.prototype) as MockedJournal;
    journal.getEntry = jest.fn().mockResolvedValue(existing);
    journal.setEntry = jest.fn().mockResolvedValue(undefined);
    return journal;
}

describe('SyncJournal', () => {
    describe('markPending', () => {
        it('preserves the last synced snapshot for modified files', async () => {
            const existing: SyncJournalEntry = {
                path: 'note.md',
                localHash: 'local-synced-hash',
                remoteHash: 'remote-synced-hash',
                remoteEtag: 'etag-123',
                localMtime: 10,
                remoteMtime: 20,
                syncedAt: 30,
                status: 'synced',
                lastModifiedBy: 'device-a',
            };

            const journal = createMockJournal(existing);

            await journal.markPending('note.md', 'local-current-hash', 99);

            expect(journal.setEntry).toHaveBeenCalledWith({
                path: 'note.md',
                localHash: 'local-synced-hash',
                remoteHash: 'remote-synced-hash',
                remoteEtag: 'etag-123',
                localMtime: 99,
                remoteMtime: 20,
                syncedAt: 30,
                status: 'pending',
                lastModifiedBy: 'device-a',
            });
        });

        it('marks unseen files as new without inventing a synced baseline', async () => {
            const journal = createMockJournal();

            await journal.markPending('new-note.md', 'new-local-hash', 123);

            expect(journal.setEntry).toHaveBeenCalledWith({
                path: 'new-note.md',
                localHash: '',
                remoteHash: '',
                remoteEtag: undefined,
                localMtime: 123,
                remoteMtime: 0,
                syncedAt: 0,
                status: 'new',
                lastModifiedBy: undefined,
            });
        });
    });
});
