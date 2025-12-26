/**
 * Sync Journal Module
 *
 * Provides persistent storage for sync state using IndexedDB.
 * Tracks file hashes, modification times, and sync status for each file.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { SyncJournalEntry, SyncFileStatus } from '../types';

/**
 * IndexedDB schema for sync journal
 */
interface SyncJournalDB extends DBSchema {
    /** Main journal entries store - keyed by file path */
    entries: {
        key: string;
        value: SyncJournalEntry;
        indexes: {
            'by-status': SyncFileStatus;
            'by-synced-at': number;
        };
    };

    /** Metadata store for journal-level info */
    metadata: {
        key: string;
        value: string | number | boolean;
    };
}

/**
 * Database name and version
 * Version should be bumped when schema changes
 */
const DB_NAME = 'obsidian-s3-sync-journal';
const DB_VERSION = 1;

/**
 * SyncJournal class - Manages sync state persistence
 *
 * Uses IndexedDB to store per-file sync state including:
 * - File hashes (local and remote)
 * - Modification times
 * - Sync status
 * - Last sync timestamp
 */
export class SyncJournal {
    private db: IDBPDatabase<SyncJournalDB> | null = null;
    private vaultName: string;

    /**
     * Create a new SyncJournal instance
     *
     * @param vaultName - Name of the vault (used to namespace the database)
     */
    constructor(vaultName: string) {
        this.vaultName = vaultName;
    }

    /**
     * Initialize the journal database
     * Must be called before using other methods
     */
    async initialize(): Promise<void> {
        const dbName = `${DB_NAME}-${this.vaultName}`;

        this.db = await openDB<SyncJournalDB>(dbName, DB_VERSION, {
            upgrade(db) {
                // Create entries store with indexes
                if (!db.objectStoreNames.contains('entries')) {
                    const entriesStore = db.createObjectStore('entries', { keyPath: 'path' });
                    entriesStore.createIndex('by-status', 'status');
                    entriesStore.createIndex('by-synced-at', 'syncedAt');
                }

                // Create metadata store
                if (!db.objectStoreNames.contains('metadata')) {
                    db.createObjectStore('metadata');
                }
            },
        });
    }

    /**
     * Ensure database is initialized
     */
    private ensureInitialized(): void {
        if (!this.db) {
            throw new Error('SyncJournal not initialized. Call initialize() first.');
        }
    }

    /**
     * Get a journal entry by file path
     *
     * @param path - File path relative to vault root
     * @returns Journal entry or undefined if not found
     */
    async getEntry(path: string): Promise<SyncJournalEntry | undefined> {
        this.ensureInitialized();
        return await this.db!.get('entries', path);
    }

    /**
     * Set or update a journal entry
     *
     * @param entry - Journal entry to store
     */
    async setEntry(entry: SyncJournalEntry): Promise<void> {
        this.ensureInitialized();
        await this.db!.put('entries', entry);
    }

    /**
     * Delete a journal entry
     *
     * @param path - File path to delete
     */
    async deleteEntry(path: string): Promise<void> {
        this.ensureInitialized();
        await this.db!.delete('entries', path);
    }

    /**
     * Get all journal entries
     *
     * @returns Array of all journal entries
     */
    async getAllEntries(): Promise<SyncJournalEntry[]> {
        this.ensureInitialized();
        return await this.db!.getAll('entries');
    }

    /**
     * Get all entries with a specific status
     *
     * @param status - Status to filter by
     * @returns Array of matching entries
     */
    async getEntriesByStatus(status: SyncFileStatus): Promise<SyncJournalEntry[]> {
        this.ensureInitialized();
        return await this.db!.getAllFromIndex('entries', 'by-status', status);
    }

    /**
     * Get count of entries by status
     *
     * @returns Map of status to count
     */
    async getStatusCounts(): Promise<Map<SyncFileStatus, number>> {
        const entries = await this.getAllEntries();
        const counts = new Map<SyncFileStatus, number>();

        for (const entry of entries) {
            counts.set(entry.status, (counts.get(entry.status) || 0) + 1);
        }

        return counts;
    }

    /**
     * Get entries that have pending changes
     *
     * @returns Array of entries with status 'pending' or 'new'
     */
    async getPendingEntries(): Promise<SyncJournalEntry[]> {
        const allEntries = await this.getAllEntries();
        return allEntries.filter((e) => e.status === 'pending' || e.status === 'new');
    }

    /**
     * Get entries that are in conflict
     *
     * @returns Array of entries with status 'conflict'
     */
    async getConflictedEntries(): Promise<SyncJournalEntry[]> {
        return await this.getEntriesByStatus('conflict');
    }

    /**
     * Mark a file as synced
     *
     * @param path - File path
     * @param localHash - Current local hash
     * @param remoteHash - Current remote hash (usually same as local after sync)
     * @param localMtime - Local modification time
     * @param remoteMtime - Remote modification time
     */
    async markSynced(
        path: string,
        localHash: string,
        remoteHash: string,
        localMtime: number,
        remoteMtime: number
    ): Promise<void> {
        const entry: SyncJournalEntry = {
            path,
            localHash,
            remoteHash,
            localMtime,
            remoteMtime,
            syncedAt: Date.now(),
            status: 'synced',
        };
        await this.setEntry(entry);
    }

    /**
     * Mark a file as pending (local changes)
     *
     * @param path - File path
     * @param localHash - New local hash
     * @param localMtime - New local modification time
     */
    async markPending(path: string, localHash: string, localMtime: number): Promise<void> {
        const existing = await this.getEntry(path);

        const entry: SyncJournalEntry = {
            path,
            localHash,
            remoteHash: existing?.remoteHash || '',
            localMtime,
            remoteMtime: existing?.remoteMtime || 0,
            syncedAt: existing?.syncedAt || 0,
            status: 'pending',
        };
        await this.setEntry(entry);
    }

    /**
     * Mark a file as in conflict
     *
     * @param path - File path
     * @param localHash - Local hash
     * @param remoteHash - Remote hash
     */
    async markConflict(path: string, localHash: string, remoteHash: string): Promise<void> {
        const existing = await this.getEntry(path);

        const entry: SyncJournalEntry = {
            path,
            localHash,
            remoteHash,
            localMtime: existing?.localMtime || Date.now(),
            remoteMtime: existing?.remoteMtime || Date.now(),
            syncedAt: existing?.syncedAt || 0,
            status: 'conflict',
        };
        await this.setEntry(entry);
    }

    /**
     * Mark a file as deleted (queued for remote deletion)
     *
     * @param path - File path
     */
    async markDeleted(path: string): Promise<void> {
        const existing = await this.getEntry(path);

        if (existing) {
            existing.status = 'deleted';
            await this.setEntry(existing);
        }
    }

    /**
     * Check if a file exists in the journal
     *
     * @param path - File path
     * @returns true if entry exists
     */
    async hasEntry(path: string): Promise<boolean> {
        const entry = await this.getEntry(path);
        return entry !== undefined;
    }

    /**
     * Clear all journal entries
     * Use with caution - this will reset all sync state
     */
    async clear(): Promise<void> {
        this.ensureInitialized();
        await this.db!.clear('entries');
    }

    /**
     * Get or set metadata value
     */
    async getMetadata(key: string): Promise<string | number | boolean | undefined> {
        this.ensureInitialized();
        return await this.db!.get('metadata', key);
    }

    async setMetadata(key: string, value: string | number | boolean): Promise<void> {
        this.ensureInitialized();
        await this.db!.put('metadata', value, key);
    }

    /**
     * Export journal as JSON for backup
     *
     * @returns JSON string of all entries
     */
    async exportAsJson(): Promise<string> {
        const entries = await this.getAllEntries();
        return JSON.stringify(entries, null, 2);
    }

    /**
     * Import journal from JSON backup
     *
     * @param json - JSON string of entries to import
     * @param merge - If true, merge with existing; if false, replace all
     */
    async importFromJson(json: string, merge = true): Promise<void> {
        const entries = JSON.parse(json) as SyncJournalEntry[];

        if (!merge) {
            await this.clear();
        }

        for (const entry of entries) {
            await this.setEntry(entry);
        }
    }

    /**
     * Close the database connection
     * Call this when the plugin is unloaded
     */
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
