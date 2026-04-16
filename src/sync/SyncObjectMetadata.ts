/**
 * Encodes and decodes custom S3 object metadata for the sync engine.
 *
 * S3 custom metadata keys are lowercased by most providers, so we use
 * lowercase keys consistently. The metadata is stored in the S3 Metadata
 * dict (x-amz-meta-* headers).
 *
 * The AWS SDK automatically prepends the `x-amz-meta-` prefix when
 * sending metadata and strips it when receiving — callers always work with
 * the bare key names defined in the constants below (e.g. `obsidian-mtime`
 * rather than `x-amz-meta-obsidian-mtime`).
 */

import { SyncUploadMetadata } from '../types';

/**
 * Current sync metadata schema version written to every uploaded object.
 *
 * Increment this when the metadata schema changes in a breaking way so that
 * older clients can detect objects written by a newer engine version.
 */
const SYNC_VERSION = 2;

/**
 * S3 metadata key that stores the sync schema version.
 *
 * Stored as a decimal string (e.g. `"2"`). The AWS SDK automatically adds
 * the `x-amz-meta-` prefix when sending and removes it on receipt.
 */
const KEY_SYNC_VERSION = 'obsidian-sync-version';

/**
 * S3 metadata key that stores the SHA-256 content fingerprint.
 *
 * Used for content-identity comparison during three-way reconciliation.
 * Format: `sha256:<hex>` (or `hmac-sha256:<hex>` when encryption is enabled).
 * The AWS SDK automatically adds the `x-amz-meta-` prefix when sending.
 */
const KEY_FINGERPRINT = 'obsidian-fingerprint';

/**
 * S3 metadata key that stores the client-side last-modified timestamp.
 *
 * Stored as epoch milliseconds in decimal string form (e.g. `"1700000000000"`).
 * The remote mtime is preserved across devices so conflict resolution can
 * compare which side changed more recently.
 * The AWS SDK automatically adds the `x-amz-meta-` prefix when sending.
 */
const KEY_MTIME = 'obsidian-mtime';

/**
 * S3 metadata key that stores the device identifier of the uploading client.
 *
 * Allows the planner to distinguish between a file uploaded by this device
 * versus another device, enabling optimistic local-wins decisions for files
 * we uploaded ourselves.
 * The AWS SDK automatically adds the `x-amz-meta-` prefix when sending.
 */
const KEY_DEVICE_ID = 'obsidian-device-id';

/**
 * Serialises a `SyncUploadMetadata` record into the flat string dictionary
 * that the AWS SDK accepts as S3 custom metadata.
 *
 * All numeric values are converted to decimal strings because S3 metadata
 * values must be strings.  The current `SYNC_VERSION` is always included so
 * `decodeMetadata` can detect schema mismatches.
 *
 * @param meta - The upload metadata to encode.
 * @returns A `Record<string, string>` suitable for the `Metadata` field of
 *   `PutObjectCommand`.
 */
export function encodeMetadata(meta: SyncUploadMetadata): Record<string, string> {
	return {
		[KEY_SYNC_VERSION]: String(SYNC_VERSION),
		[KEY_FINGERPRINT]: meta.fingerprint,
		[KEY_MTIME]: String(meta.clientMtime),
		[KEY_DEVICE_ID]: meta.deviceId,
	};
}

/**
 * Decoded representation of the custom S3 metadata attached to a synced object.
 *
 * All fields are optional because older objects may pre-date certain keys and
 * because `decodeMetadata` performs defensive parsing — a corrupted or absent
 * value is omitted rather than crashing the caller.
 */
export interface DecodedSyncMetadata {
	/**
	 * The sync engine schema version that wrote this object.
	 * Absent for objects written before versioning was introduced.
	 */
	syncVersion?: number;

	/**
	 * SHA-256 (or HMAC-SHA-256) fingerprint of the plaintext file content.
	 * Used as the content-identity token in three-way reconciliation.
	 */
	fingerprint?: string;

	/**
	 * Client-side last-modified timestamp in epoch milliseconds.
	 * Preserved across devices so the planner can perform recency comparisons.
	 */
	clientMtime?: number;

	/**
	 * Identifier of the device that last uploaded this object.
	 * Enables optimistic local-wins decisions for self-uploaded files.
	 */
	deviceId?: string;
}

/**
 * Parses the raw S3 metadata dictionary returned by `GetObjectCommand` or
 * `HeadObjectCommand` into a typed `DecodedSyncMetadata` object.
 *
 * Parsing is fully defensive: missing keys are silently omitted and numeric
 * fields use `parseInt` + `isNaN` guards because S3 always delivers metadata
 * values as strings — even values that were stored as numbers.  A corrupted
 * or non-numeric string is therefore dropped rather than surfaced as `NaN`.
 *
 * @param raw - The `Metadata` record from the S3 response, or `undefined`
 *   when the object has no custom metadata.
 * @returns A `DecodedSyncMetadata` with only the successfully parsed fields
 *   populated.  An empty object `{}` is returned when `raw` is `undefined`.
 */
export function decodeMetadata(raw: Record<string, string> | undefined): DecodedSyncMetadata {
	if (!raw) {
		return {};
	}

	const result: DecodedSyncMetadata = {};

	const version = raw[KEY_SYNC_VERSION];
	if (version !== undefined) {
		// S3 delivers all metadata values as strings; parseInt + isNaN guards
		// against corrupted or non-numeric values being surfaced as NaN.
		const parsed = parseInt(version, 10);
		if (!isNaN(parsed)) {
			result.syncVersion = parsed;
		}
	}

	const fingerprint = raw[KEY_FINGERPRINT];
	if (fingerprint !== undefined) {
		result.fingerprint = fingerprint;
	}

	const mtime = raw[KEY_MTIME];
	if (mtime !== undefined) {
		// Same defensive parseInt — mtime is stored as a decimal string.
		const parsed = parseInt(mtime, 10);
		if (!isNaN(parsed)) {
			result.clientMtime = parsed;
		}
	}

	const deviceId = raw[KEY_DEVICE_ID];
	if (deviceId !== undefined) {
		result.deviceId = deviceId;
	}

	return result;
}

/**
 * Returns the current sync metadata schema version (`SYNC_VERSION`).
 *
 * Exposed so callers can compare the version on a remote object against
 * the version supported by the running engine without importing the
 * private constant directly.
 *
 * @returns The integer sync version supported by this build of the plugin.
 */
export function getCurrentSyncVersion(): number {
	return SYNC_VERSION;
}
