/**
 * Provides the IndexedDB persistence layer for the v2 sync engine's per-file baselines.
 *
 * ## Why this exists
 * Three-way reconciliation requires each device to remember the last-known-good state for
 * every file it has successfully synced.  That "baseline" is what lets the engine distinguish
 * "this file changed locally since the last sync" from "I never synced this file before".
 * Without it the engine would have to treat every file as new on every run.
 *
 * ## Schema (DB_VERSION = 2)
 * The database name is vault-scoped (`obsidian-s3-sync-journal-{vaultName}`) so that separate
 * Obsidian vaults stored in the same bucket do not share state.
 *
 * Three object stores:
 *
 * | Store          | Key                      | Purpose                                              |
 * |----------------|--------------------------|------------------------------------------------------|
 * | `stateRecords` | vault-relative file path | Per-file sync baseline (mtime, size, SHA-256, etag)  |
 * | `conflicts`    | vault-relative file path | Unresolved conflict records pending user resolution  |
 * | `metadata`     | arbitrary string key     | Plugin-level key/value pairs (e.g. last sync time)   |
 *
 * ## v1 → v2 migration
 * Version 1 stored everything in a single `entries` object store.  Version 2 splits the data
 * into the three specialised stores above.  The `upgrade` callback in {@link SyncJournal.initialize}
 * drops the legacy `entries` store if present so the old data is not carried forward — a fresh
 * full sync repopulates the baselines from actual S3 state.
 */

import { DBSchema, IDBPDatabase, openDB } from 'idb';
import { ConflictRecord, SyncStateRecord } from '../types';

/**
 * Allowed value types for entries in the `metadata` object store.
 *
 * Keys such as `engineVersion` carry a string, `lastSuccessfulSyncAt` carries a number
 * (epoch ms), and feature-flag keys carry a boolean.  The union avoids storing rich
 * objects in what is intentionally a flat key/value bag.
 */
type SyncJournalMetadataValue = string | number | boolean;

/**
 * Typed schema definition consumed by the `idb` library for compile-time type safety.
 *
 * Extending `DBSchema` lets `IDBPDatabase<SyncJournalDB>` enforce correct store names,
 * key types, and value types on every get/put/delete call — no string-based casts needed.
 *
 * Fields:
 * - `stateRecords` — keyed by vault-relative file path; values are {@link SyncStateRecord}.
 * - `conflicts`    — keyed by vault-relative file path; values are {@link ConflictRecord}.
 * - `metadata`     — keyed by an arbitrary string; values are {@link SyncJournalMetadataValue}.
 */
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

/** Common prefix for the IndexedDB database name; the vault name is appended at runtime. */
const DB_NAME_PREFIX = 'obsidian-s3-sync-journal';

/**
 * Current IndexedDB schema version.
 *
 * Bump this whenever an object store is added, removed, or has its key path changed.
 * Version 2 reflects the migration that replaced the v1 `entries` store with the three
 * purpose-specific stores (`stateRecords`, `conflicts`, `metadata`).
 */
const DB_VERSION = 2;

/**
 * Vault-scoped IndexedDB journal that persists per-file sync baselines, unresolved conflict
 * records, and plugin-level metadata between sync runs.
 *
 * A single `SyncJournal` instance is created per plugin lifecycle and shared across the entire
 * sync engine.  Callers must call {@link initialize} before using any other method and
 * {@link close} during plugin unload to release the IDB connection.
 *
 * The database name is derived from the vault name at construction time, ensuring that two
 * separate Obsidian vaults pointing at the same S3 bucket each maintain independent journals.
 */
export class SyncJournal {
	private db: IDBPDatabase<SyncJournalDB> | null = null;

	/**
	 * Creates a new journal bound to a specific vault.
	 *
	 * @param vaultName - The Obsidian vault's display name, used to namespace the IDB database.
	 */
	constructor(private vaultName: string) {}

	/**
	 * Initializes the IndexedDB journal for the current vault.
	 *
	 * Opens (or creates) the database, running any necessary schema upgrades.
	 * The `upgrade` callback handles both the initial creation of the three object stores
	 * and the v1→v2 migration that removes the legacy `entries` store.
	 *
	 * Must be called once before any read/write operations.
	 *
	 * @throws If IndexedDB is unavailable or the upgrade transaction fails.
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

	/**
	 * Guards all read/write operations against use-before-initialize mistakes.
	 *
	 * Called at the top of every public method so that callers get a clear error message
	 * rather than a cryptic "cannot read properties of null" crash.
	 *
	 * @throws {Error} If {@link initialize} has not been called yet.
	 */
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
	 *
	 * Runs all three `.clear()` calls inside a single readwrite transaction so the wipe
	 * is atomic — a partial failure (e.g. tab closed mid-clear) cannot leave the journal
	 * in a half-empty state.
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
