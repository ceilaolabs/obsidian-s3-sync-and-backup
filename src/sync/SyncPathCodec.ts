/**
 * Converts between local vault paths and S3 remote keys.
 *
 * Centralises prefix logic so callers never assemble S3 keys manually.
 * All path ↔ key translations go through this codec, ensuring a single
 * source of truth for the `syncPrefix` configuration and the internal
 * metadata directory layout.
 */

import { addPrefix, removePrefix, normalizePrefix } from '../utils/paths';

/**
 * Hidden directory stored inside the sync prefix on S3.
 *
 * Contains plugin-internal objects (e.g. the encryption marker `.vault.enc`)
 * that must not be treated as user vault files.  The directory is prefixed
 * with a dot so it is hidden on most file browsers and is reliably detected
 * by `isMetadataKey()`.
 */
const METADATA_DIR = '.obsidian-s3-sync';

/**
 * Converts vault-relative file paths to S3 object keys and back, applying
 * a configurable sync prefix to every key.
 *
 * All methods are pure transforms — no I/O is performed.  The codec is
 * constructed with a sync prefix (e.g. `"vault"`) and exposes helper
 * methods used by `SyncPlanner`, `SyncExecutor`, and `S3Provider` to
 * build or decode S3 keys without duplicating prefix logic.
 *
 * @example
 * ```ts
 * const codec = new SyncPathCodec('vault');
 * codec.localToRemote('Notes/readme.md'); // → 'vault/Notes/readme.md'
 * codec.remoteToLocal('vault/Notes/readme.md'); // → 'Notes/readme.md'
 * codec.isMetadataKey('vault/.obsidian-s3-sync/.vault.enc'); // → true
 * ```
 */
export class SyncPathCodec {
	private normalizedPrefix: string;

	/**
	 * Creates a new `SyncPathCodec` with the given sync prefix.
	 *
	 * The prefix is normalised (leading/trailing slashes stripped) so that
	 * callers do not need to sanitise it before construction.
	 *
	 * @param syncPrefix - The S3 key prefix under which all vault files are
	 *   stored (e.g. `"vault"` maps `Notes/a.md` → `vault/Notes/a.md`).
	 *   Pass an empty string for no prefix (files stored at bucket root).
	 */
	constructor(syncPrefix: string) {
		this.normalizedPrefix = normalizePrefix(syncPrefix);
	}

	/**
	 * Replaces the sync prefix without constructing a new codec instance.
	 *
	 * Called by the settings handler whenever the user updates the
	 * `syncPrefix` setting so existing references to the codec remain valid.
	 *
	 * @param syncPrefix - The new prefix value (will be normalised).
	 */
	updatePrefix(syncPrefix: string): void {
		this.normalizedPrefix = normalizePrefix(syncPrefix);
	}

	/**
	 * Converts a vault-relative local path to its corresponding S3 object key.
	 *
	 * @param localPath - A vault-relative path such as `"Notes/readme.md"`.
	 * @returns The S3 key with the sync prefix applied, e.g. `"vault/Notes/readme.md"`.
	 */
	localToRemote(localPath: string): string {
		return addPrefix(localPath, this.normalizedPrefix);
	}

	/**
	 * Converts an S3 object key back to a vault-relative local path.
	 *
	 * @param remoteKey - An S3 key such as `"vault/Notes/readme.md"`.
	 * @returns The vault-relative path (e.g. `"Notes/readme.md"`), or `null`
	 *   if the key does not start with the configured sync prefix and therefore
	 *   does not belong to this vault's sync namespace.
	 */
	remoteToLocal(remoteKey: string): string | null {
		return removePrefix(remoteKey, this.normalizedPrefix);
	}

	/**
	 * Returns `true` when the given S3 key refers to a plugin-internal
	 * metadata object rather than a user vault file.
	 *
	 * Metadata keys reside under the `METADATA_DIR` subdirectory inside the
	 * sync prefix (e.g. `vault/.obsidian-s3-sync/...`).  The planner uses
	 * this check to skip metadata objects when listing remote vault files.
	 *
	 * @param remoteKey - The S3 object key to test.
	 * @returns `true` if the key belongs to the metadata directory.
	 */
	isMetadataKey(remoteKey: string): boolean {
		const relativePath = removePrefix(remoteKey, this.normalizedPrefix);
		return relativePath?.startsWith(`${METADATA_DIR}/`) ?? false;
	}

	/**
	 * Returns the S3 key prefix to use when listing all objects in the
	 * sync namespace (passed as the `Prefix` parameter to `ListObjectsV2`).
	 *
	 * The trailing slash ensures only keys inside the prefix directory are
	 * returned and not a key that is the prefix itself.
	 *
	 * @returns A string like `"vault/"`, or an empty string when no prefix is configured.
	 */
	getListPrefix(): string {
		return this.normalizedPrefix ? `${this.normalizedPrefix}/` : '';
	}

	/**
	 * Returns the full S3 key for the metadata directory itself.
	 *
	 * Used when the engine needs to check whether the metadata directory
	 * exists or when constructing keys for objects within it.
	 *
	 * @returns The prefixed metadata directory key, e.g. `"vault/.obsidian-s3-sync"`.
	 */
	getMetadataDir(): string {
		return addPrefix(METADATA_DIR, this.normalizedPrefix);
	}

	/**
	 * Returns the S3 key for the engine marker file.
	 *
	 * The marker file (`engine.json`) is written once during first-time setup
	 * to record which sync engine version initialised the bucket namespace.
	 * Its presence allows future versions to detect and handle legacy layouts.
	 *
	 * @returns The prefixed engine marker key, e.g. `"vault/.obsidian-s3-sync/engine.json"`.
	 */
	getEngineMarkerKey(): string {
		return addPrefix(`${METADATA_DIR}/engine.json`, this.normalizedPrefix);
	}
}
