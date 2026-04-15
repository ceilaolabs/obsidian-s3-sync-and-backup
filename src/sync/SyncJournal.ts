import { DBSchema, IDBPDatabase, openDB } from 'idb';
import { ConflictRecord, SyncStateRecord } from '../types';

type SyncJournalMetadataValue = string | number | boolean;

interface SyncJournalDB extends DBSchema {
	stateRecords: {
		key: string;
		value: SyncStateRecord;
	};
	conflicts: {
		key: string;
		value: ConflictRecord;
	};
	metadata: {
		key: string;
		value: SyncJournalMetadataValue;
	};
}

const DB_NAME_PREFIX = 'obsidian-s3-sync-journal';
const DB_VERSION = 2;

export class SyncJournal {
	private db: IDBPDatabase<SyncJournalDB> | null = null;

	constructor(private vaultName: string) {}

	/**
	 * Initializes the IndexedDB journal for the current vault.
	 */
	async initialize(): Promise<void> {
		this.db = await openDB<SyncJournalDB>(`${DB_NAME_PREFIX}-${this.vaultName}`, DB_VERSION, {
			upgrade(db) {
				const legacyDatabase = db as unknown as {
					objectStoreNames: DOMStringList;
					deleteObjectStore(name: string): void;
				};

				if (legacyDatabase.objectStoreNames.contains('entries')) {
					legacyDatabase.deleteObjectStore('entries');
				}

				if (!db.objectStoreNames.contains('stateRecords')) {
					db.createObjectStore('stateRecords', { keyPath: 'path' });
				}

				if (!db.objectStoreNames.contains('conflicts')) {
					db.createObjectStore('conflicts', { keyPath: 'path' });
				}

				if (!db.objectStoreNames.contains('metadata')) {
					db.createObjectStore('metadata');
				}
			},
		});
	}

	private ensureInitialized(): void {
		if (!this.db) {
			throw new Error('SyncJournal not initialized. Call initialize() first.');
		}
	}

	/**
	 * Returns the stored baseline record for a vault path.
	 *
	 * @param path - Vault-relative file path.
	 * @returns The stored baseline or undefined when absent.
	 */
	async getStateRecord(path: string): Promise<SyncStateRecord | undefined> {
		this.ensureInitialized();
		return await this.db!.get('stateRecords', path);
	}

	/**
	 * Stores or replaces a baseline record.
	 *
	 * @param record - Baseline record to persist.
	 */
	async setStateRecord(record: SyncStateRecord): Promise<void> {
		this.ensureInitialized();
		await this.db!.put('stateRecords', record);
	}

	/**
	 * Deletes the stored baseline record for a vault path.
	 *
	 * @param path - Vault-relative file path.
	 */
	async deleteStateRecord(path: string): Promise<void> {
		this.ensureInitialized();
		await this.db!.delete('stateRecords', path);
	}

	/**
	 * Returns all stored baseline records.
	 *
	 * @returns Every baseline record currently stored.
	 */
	async getAllStateRecords(): Promise<SyncStateRecord[]> {
		this.ensureInitialized();
		return await this.db!.getAll('stateRecords');
	}

	/**
	 * Returns a stored conflict record for a vault path.
	 *
	 * @param path - Vault-relative file path.
	 * @returns The stored conflict record or undefined when absent.
	 */
	async getConflict(path: string): Promise<ConflictRecord | undefined> {
		this.ensureInitialized();
		return await this.db!.get('conflicts', path);
	}

	/**
	 * Stores or replaces a conflict record.
	 *
	 * @param record - Conflict record to persist.
	 */
	async setConflict(record: ConflictRecord): Promise<void> {
		this.ensureInitialized();
		await this.db!.put('conflicts', record);
	}

	/**
	 * Deletes a stored conflict record for a vault path.
	 *
	 * @param path - Vault-relative file path.
	 */
	async deleteConflict(path: string): Promise<void> {
		this.ensureInitialized();
		await this.db!.delete('conflicts', path);
	}

	/**
	 * Returns all stored conflict records.
	 *
	 * @returns Every unresolved conflict record currently stored.
	 */
	async getAllConflicts(): Promise<ConflictRecord[]> {
		this.ensureInitialized();
		return await this.db!.getAll('conflicts');
	}

	/**
	 * Reads a metadata value by key.
	 *
	 * @param key - Metadata key such as engineVersion or lastSuccessfulSyncAt.
	 * @returns Stored metadata value or undefined when absent.
	 */
	async getMetadata(key: string): Promise<SyncJournalMetadataValue | undefined> {
		this.ensureInitialized();
		return await this.db!.get('metadata', key);
	}

	/**
	 * Stores a metadata value under an explicit key.
	 *
	 * @param key - Metadata key such as engineVersion or lastSuccessfulSyncAt.
	 * @param value - Metadata value to persist.
	 */
	async setMetadata(key: string, value: SyncJournalMetadataValue): Promise<void> {
		this.ensureInitialized();
		await this.db!.put('metadata', value, key);
	}

	/**
	 * Clears all state, conflict, and metadata records.
	 */
	async clear(): Promise<void> {
		this.ensureInitialized();
		const tx = this.db!.transaction(['stateRecords', 'conflicts', 'metadata'], 'readwrite');
		await Promise.all([
			tx.objectStore('stateRecords').clear(),
			tx.objectStore('conflicts').clear(),
			tx.objectStore('metadata').clear(),
		]);
		await tx.done;
	}

	/**
	 * Closes the IndexedDB connection during plugin unload.
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}
