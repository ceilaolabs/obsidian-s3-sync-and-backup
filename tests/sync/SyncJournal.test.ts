/**
 * Unit tests for SyncJournal mutation helpers.
 *
 * These tests exercise methods directly on a mocked instance so they can
 * validate entry-shaping logic without requiring IndexedDB in Jest.
 */

jest.mock('idb', () => ({
    openDB: jest.fn(),
}));

import { openDB } from 'idb';
import { SyncJournal } from '../../src/sync/SyncJournal';
import { SyncJournalEntry } from '../../src/types';

type MockedDatabase = {
    clear: jest.Mock<Promise<void>, ['entries']>;
    close: jest.Mock<void, []>;
    createObjectStore: jest.Mock<{ createIndex: jest.Mock }, [string, { keyPath?: string }?]>;
    get: jest.Mock<Promise<unknown>, [string, string]>;
    getAll: jest.Mock<Promise<SyncJournalEntry[]>, ['entries']>;
    getAllFromIndex: jest.Mock<Promise<SyncJournalEntry[]>, [string, string, SyncJournalEntry['status']]>;
    objectStoreNames: {
        contains: jest.Mock<boolean, [string]>;
    };
    put: jest.Mock<Promise<void>, [string, unknown, string?]>;
};

type MockedJournal = {
    initialize: SyncJournal['initialize'];
    markPending: SyncJournal['markPending'];
    markDeleted: SyncJournal['markDeleted'];
    markSynced: SyncJournal['markSynced'];
    markConflict: SyncJournal['markConflict'];
    hasEntry: SyncJournal['hasEntry'];
    getStatusCounts: SyncJournal['getStatusCounts'];
    getPendingEntries: SyncJournal['getPendingEntries'];
    getConflictedEntries: SyncJournal['getConflictedEntries'];
    getAllEntries: SyncJournal['getAllEntries'];
    getEntriesByStatus: SyncJournal['getEntriesByStatus'];
    clear: SyncJournal['clear'];
    getMetadata: SyncJournal['getMetadata'];
    setMetadata: SyncJournal['setMetadata'];
    exportAsJson: SyncJournal['exportAsJson'];
    importFromJson: SyncJournal['importFromJson'];
    close: SyncJournal['close'];
    getEntry: jest.Mock<Promise<SyncJournalEntry | undefined>, [string]>;
    setEntry: jest.Mock<Promise<void>, [SyncJournalEntry]>;
    deleteEntry: jest.Mock<Promise<void>, [string]>;
    db: MockedDatabase | null;
};

function createMockJournal(existing?: SyncJournalEntry): MockedJournal {
    const journal = Object.create(SyncJournal.prototype) as MockedJournal;
    journal.getEntry = jest.fn().mockResolvedValue(existing);
    journal.setEntry = jest.fn().mockResolvedValue(undefined);
    journal.deleteEntry = jest.fn().mockResolvedValue(undefined);
    journal.getAllEntries = jest.fn();
    journal.getEntriesByStatus = jest.fn();
    journal.db = null;
    return journal;
}

describe('SyncJournal', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('initializes the database with the expected schema', async () => {
        const entriesStore = {
            createIndex: jest.fn(),
        };
        const db = {
            objectStoreNames: {
                contains: jest.fn().mockReturnValue(false),
            },
            createObjectStore: jest.fn().mockReturnValue(entriesStore),
        } as unknown as MockedDatabase;

        const fakeConnection = {
            close: jest.fn(),
            clear: jest.fn(),
            createObjectStore: jest.fn(),
            get: jest.fn(),
            getAll: jest.fn(),
            getAllFromIndex: jest.fn(),
            objectStoreNames: {
                contains: jest.fn(),
            },
            put: jest.fn(),
        } as MockedDatabase;

        const mockedOpenDB = openDB as jest.MockedFunction<typeof openDB>;
        mockedOpenDB.mockImplementation(async (_name, _version, options) => {
            options?.upgrade?.(db as never, 0, 1, {} as never, {} as never);
            return fakeConnection as never;
        });

        const journal = new SyncJournal('vault');

        await journal.initialize();

        expect(mockedOpenDB).toHaveBeenCalledWith(
            'obsidian-s3-sync-journal-vault',
            1,
            expect.objectContaining({ upgrade: expect.any(Function) })
        );
        expect(db.createObjectStore).toHaveBeenCalledWith('entries', { keyPath: 'path' });
        expect(entriesStore.createIndex).toHaveBeenCalledWith('by-status', 'status');
        expect(entriesStore.createIndex).toHaveBeenCalledWith('by-synced-at', 'syncedAt');
        expect(db.createObjectStore).toHaveBeenCalledWith('metadata');
        expect((journal as unknown as { db: MockedDatabase | null }).db).toBe(fakeConnection);
    });

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
                localHash: 'local-current-hash',
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
                localHash: 'new-local-hash',
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

    describe('markDeleted', () => {
        /**
         * E7 fix: markDeleted must create a tombstone for files that have no prior
         * journal record so that the sync engine can still propagate the deletion to
         * the remote side even when the file was never tracked locally.
         */
        it('creates tombstone entry for file not in journal (E7 fix)', async () => {
            const journal = createMockJournal();

            await journal.markDeleted('unknown-file.md');

            expect(journal.setEntry).toHaveBeenCalledWith({
                path: 'unknown-file.md',
                localHash: '',
                remoteHash: '',
                localMtime: 0,
                remoteMtime: 0,
                syncedAt: 0,
                status: 'deleted',
            });
        });

        /**
         * When a fully synced entry already exists the method must preserve all
         * existing fields and only flip the status to 'deleted'.
         */
        it('marks existing synced entry as deleted', async () => {
            const existing: SyncJournalEntry = {
                path: 'note.md',
                localHash: 'local-hash-abc',
                remoteHash: 'remote-hash-abc',
                remoteEtag: 'etag-xyz',
                localMtime: 100,
                remoteMtime: 200,
                syncedAt: 300,
                status: 'synced',
                lastModifiedBy: 'device-b',
            };

            const journal = createMockJournal(existing);

            await journal.markDeleted('note.md');

            expect(journal.setEntry).toHaveBeenCalledWith({
                path: 'note.md',
                localHash: 'local-hash-abc',
                remoteHash: 'remote-hash-abc',
                remoteEtag: 'etag-xyz',
                localMtime: 100,
                remoteMtime: 200,
                syncedAt: 300,
                status: 'deleted',
                lastModifiedBy: 'device-b',
            });
        });

        /**
         * An entry that is already in 'pending' state (awaiting upload) should
         * also transition cleanly to 'deleted' with all other fields preserved.
         */
        it('marks existing pending entry as deleted', async () => {
            const existing: SyncJournalEntry = {
                path: 'pending.md',
                localHash: 'local-pending-hash',
                remoteHash: 'remote-old-hash',
                remoteEtag: 'etag-old',
                localMtime: 50,
                remoteMtime: 40,
                syncedAt: 30,
                status: 'pending',
                lastModifiedBy: 'device-c',
            };

            const journal = createMockJournal(existing);

            await journal.markDeleted('pending.md');

            expect(journal.setEntry).toHaveBeenCalledWith({
                path: 'pending.md',
                localHash: 'local-pending-hash',
                remoteHash: 'remote-old-hash',
                remoteEtag: 'etag-old',
                localMtime: 50,
                remoteMtime: 40,
                syncedAt: 30,
                status: 'deleted',
                lastModifiedBy: 'device-c',
            });
        });
    });

    describe('markSynced', () => {
        it('stores a synced entry with the expected shape', async () => {
            const journal = createMockJournal();
            const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(123456789);

            try {
                await journal.markSynced('note.md', 'local-hash', 'remote-hash', 10, 20, 'etag-1', 'device-a');

                expect(journal.setEntry).toHaveBeenCalledWith({
                    path: 'note.md',
                    localHash: 'local-hash',
                    remoteHash: 'remote-hash',
                    remoteEtag: 'etag-1',
                    localMtime: 10,
                    remoteMtime: 20,
                    syncedAt: 123456789,
                    status: 'synced',
                    lastModifiedBy: 'device-a',
                });
            } finally {
                nowSpy.mockRestore();
            }
        });
    });

    describe('markConflict', () => {
        it('preserves existing conflict metadata when no new ETag is provided', async () => {
            const existing: SyncJournalEntry = {
                path: 'note.md',
                localHash: 'old-local-hash',
                remoteHash: 'old-remote-hash',
                remoteEtag: 'etag-old',
                localMtime: 11,
                remoteMtime: 22,
                syncedAt: 33,
                status: 'synced',
                lastModifiedBy: 'device-x',
            };
            const journal = createMockJournal(existing);

            await journal.markConflict('note.md', 'new-local-hash', 'new-remote-hash');

            expect(journal.setEntry).toHaveBeenCalledWith({
                path: 'note.md',
                localHash: 'new-local-hash',
                remoteHash: 'new-remote-hash',
                remoteEtag: 'etag-old',
                localMtime: 11,
                remoteMtime: 22,
                syncedAt: 33,
                status: 'conflict',
                lastModifiedBy: 'device-x',
            });
        });
    });

    describe('status helpers', () => {
        it('counts entries by status using the full entry list', async () => {
            const journal = createMockJournal();
            (journal.getAllEntries as jest.Mock).mockResolvedValue([
                { path: 'a', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'pending' },
                { path: 'b', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'pending' },
                { path: 'c', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'synced' },
                { path: 'd', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'conflict' },
            ]);

            await expect(journal.getStatusCounts()).resolves.toEqual(
                new Map([
                    ['pending', 2],
                    ['synced', 1],
                    ['conflict', 1],
                ])
            );
        });

        it('returns only entries that are pending or new', async () => {
            const journal = createMockJournal();
            (journal.getAllEntries as jest.Mock).mockResolvedValue([
                { path: 'a', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'pending' },
                { path: 'b', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'new' },
                { path: 'c', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'synced' },
                { path: 'd', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'deleted' },
            ]);

            await expect(journal.getPendingEntries()).resolves.toEqual([
                { path: 'a', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'pending' },
                { path: 'b', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'new' },
            ]);
        });

        it('returns conflicted entries using the indexed lookup', async () => {
            const journal = createMockJournal();
            const conflicts: SyncJournalEntry[] = [
                { path: 'conflict.md', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'conflict' },
            ];
            (journal.getEntriesByStatus as jest.Mock).mockResolvedValue(conflicts);

            await expect(journal.getConflictedEntries()).resolves.toBe(conflicts);
            expect(journal.getEntriesByStatus).toHaveBeenCalledWith('conflict');
        });
    });

    describe('entry and db helpers', () => {
        it('reports whether an entry exists', async () => {
            const journal = createMockJournal();
            journal.getEntry
                .mockResolvedValueOnce({ path: 'note.md', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'synced' })
                .mockResolvedValueOnce(undefined);

            await expect(journal.hasEntry('note.md')).resolves.toBe(true);
            await expect(journal.hasEntry('missing.md')).resolves.toBe(false);
        });

        it('reads all entries directly from the mocked IndexedDB connection', async () => {
            const journal = createMockJournal();
            journal.getAllEntries = SyncJournal.prototype.getAllEntries.bind(journal);
            const db: MockedDatabase = {
                clear: jest.fn(),
                close: jest.fn(),
                createObjectStore: jest.fn(),
                get: jest.fn(),
                getAll: jest.fn().mockResolvedValue([
                    { path: 'a', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'synced' },
                ]),
                getAllFromIndex: jest.fn(),
                objectStoreNames: { contains: jest.fn() },
                put: jest.fn(),
            };
            journal.db = db;

            await expect(journal.getAllEntries()).resolves.toEqual([
                { path: 'a', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'synced' },
            ]);
            expect(db.getAll).toHaveBeenCalledWith('entries');
        });

        it('reads status-filtered entries directly from the mocked IndexedDB connection', async () => {
            const journal = createMockJournal();
            journal.getEntriesByStatus = SyncJournal.prototype.getEntriesByStatus.bind(journal);
            const db: MockedDatabase = {
                clear: jest.fn(),
                close: jest.fn(),
                createObjectStore: jest.fn(),
                get: jest.fn(),
                getAll: jest.fn(),
                getAllFromIndex: jest.fn().mockResolvedValue([
                    { path: 'conflict.md', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'conflict' },
                ]),
                objectStoreNames: { contains: jest.fn() },
                put: jest.fn(),
            };
            journal.db = db;

            await expect(journal.getEntriesByStatus('conflict')).resolves.toEqual([
                { path: 'conflict.md', localHash: '', remoteHash: '', localMtime: 0, remoteMtime: 0, syncedAt: 0, status: 'conflict' },
            ]);
            expect(db.getAllFromIndex).toHaveBeenCalledWith('entries', 'by-status', 'conflict');
        });

        it('clears the journal entries using the mocked database connection', async () => {
            const journal = createMockJournal();
            const db: MockedDatabase = {
                clear: jest.fn().mockResolvedValue(undefined),
                close: jest.fn(),
                createObjectStore: jest.fn(),
                get: jest.fn(),
                getAll: jest.fn(),
                getAllFromIndex: jest.fn(),
                objectStoreNames: { contains: jest.fn() },
                put: jest.fn(),
            };
            journal.db = db;

            await journal.clear();

            expect(db.clear).toHaveBeenCalledWith('entries');
        });

        it('gets metadata values from the mocked metadata store', async () => {
            const journal = createMockJournal();
            const db: MockedDatabase = {
                clear: jest.fn(),
                close: jest.fn(),
                createObjectStore: jest.fn(),
                get: jest.fn().mockResolvedValue('value-1'),
                getAll: jest.fn(),
                getAllFromIndex: jest.fn(),
                objectStoreNames: { contains: jest.fn() },
                put: jest.fn(),
            };
            journal.db = db;

            await expect(journal.getMetadata('key-1')).resolves.toBe('value-1');
            expect(db.get).toHaveBeenCalledWith('metadata', 'key-1');
        });

        it('sets metadata values in the mocked metadata store', async () => {
            const journal = createMockJournal();
            const db: MockedDatabase = {
                clear: jest.fn(),
                close: jest.fn(),
                createObjectStore: jest.fn(),
                get: jest.fn(),
                getAll: jest.fn(),
                getAllFromIndex: jest.fn(),
                objectStoreNames: { contains: jest.fn() },
                put: jest.fn().mockResolvedValue(undefined),
            };
            journal.db = db;

            await journal.setMetadata('key-1', true);

            expect(db.put).toHaveBeenCalledWith('metadata', true, 'key-1');
        });

        it('exports entries as a formatted JSON string', async () => {
            const journal = createMockJournal();
            const entries: SyncJournalEntry[] = [
                { path: 'a', localHash: '1', remoteHash: '2', localMtime: 3, remoteMtime: 4, syncedAt: 5, status: 'synced' },
            ];
            (journal.getAllEntries as jest.Mock).mockResolvedValue(entries);

            await expect(journal.exportAsJson()).resolves.toBe(JSON.stringify(entries, null, 2));
        });

        it('imports entries from JSON and merges them into the journal', async () => {
            const journal = createMockJournal();
            const clearSpy = jest.spyOn(journal, 'clear');
            const entries: SyncJournalEntry[] = [
                { path: 'a', localHash: '1', remoteHash: '2', localMtime: 3, remoteMtime: 4, syncedAt: 5, status: 'synced' },
                { path: 'b', localHash: '6', remoteHash: '7', localMtime: 8, remoteMtime: 9, syncedAt: 10, status: 'pending' },
            ];

            await journal.importFromJson(JSON.stringify(entries));

            expect(journal.setEntry).toHaveBeenNthCalledWith(1, entries[0]);
            expect(journal.setEntry).toHaveBeenNthCalledWith(2, entries[1]);
            expect(clearSpy).not.toHaveBeenCalled();
        });

        it('replaces existing entries when importing with merge disabled', async () => {
            const journal = createMockJournal();
            const clearSpy = jest.spyOn(journal, 'clear').mockResolvedValue(undefined);
            const entries: SyncJournalEntry[] = [
                { path: 'a', localHash: '1', remoteHash: '2', localMtime: 3, remoteMtime: 4, syncedAt: 5, status: 'synced' },
            ];

            await journal.importFromJson(JSON.stringify(entries), false);

            expect(clearSpy).toHaveBeenCalledTimes(1);
            expect(journal.setEntry).toHaveBeenCalledWith(entries[0]);
        });

        it('closes the database connection and clears the cached handle', () => {
            const journal = createMockJournal();
            const db: MockedDatabase = {
                clear: jest.fn(),
                close: jest.fn(),
                createObjectStore: jest.fn(),
                get: jest.fn(),
                getAll: jest.fn(),
                getAllFromIndex: jest.fn(),
                objectStoreNames: { contains: jest.fn() },
                put: jest.fn(),
            };
            journal.db = db;

            journal.close();

            expect(db.close).toHaveBeenCalledTimes(1);
            expect(journal.db).toBeNull();
        });
    });
});
