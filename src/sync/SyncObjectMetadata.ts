/**
 * Encodes and decodes custom S3 object metadata for the sync engine.
 *
 * S3 custom metadata keys are lowercased by most providers, so we use
 * lowercase keys consistently. The metadata is stored in the S3 Metadata
 * dict (x-amz-meta-* headers).
 */

import { SyncUploadMetadata } from '../types';

const SYNC_VERSION = 2;

const KEY_SYNC_VERSION = 'obsidian-sync-version';
const KEY_FINGERPRINT = 'obsidian-fingerprint';
const KEY_MTIME = 'obsidian-mtime';
const KEY_DEVICE_ID = 'obsidian-device-id';

export function encodeMetadata(meta: SyncUploadMetadata): Record<string, string> {
	return {
		[KEY_SYNC_VERSION]: String(SYNC_VERSION),
		[KEY_FINGERPRINT]: meta.fingerprint,
		[KEY_MTIME]: String(meta.clientMtime),
		[KEY_DEVICE_ID]: meta.deviceId,
	};
}

export interface DecodedSyncMetadata {
	syncVersion?: number;
	fingerprint?: string;
	clientMtime?: number;
	deviceId?: string;
}

export function decodeMetadata(raw: Record<string, string> | undefined): DecodedSyncMetadata {
	if (!raw) {
		return {};
	}

	const result: DecodedSyncMetadata = {};

	const version = raw[KEY_SYNC_VERSION];
	if (version !== undefined) {
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

export function getCurrentSyncVersion(): number {
	return SYNC_VERSION;
}
