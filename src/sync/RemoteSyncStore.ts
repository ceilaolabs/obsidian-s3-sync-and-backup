/**
 * Remote sync manifest store.
 *
 * Persists shared sync state under `.obsidian-s3-sync/` so devices can reason
 * about remote files and deletions without relying only on local journals.
 */

import { S3Provider } from '../storage/S3Provider';
import {
    RemoteSyncDeviceInfo,
    RemoteSyncManifest,
} from '../types';
import {
    addPrefix,
    normalizePrefix,
    removePrefix,
} from '../utils/paths';

const METADATA_DIR = '.obsidian-s3-sync';
const MANIFEST_FILE = 'manifest.json';
const DEVICES_DIR = 'devices';

/**
 * Error thrown when the shared manifest changes concurrently.
 */
export class RemoteSyncManifestChangedError extends Error {
    constructor() {
        super('Remote sync manifest kept changing during sync. Another vault or device is syncing at the same time. Please sync again.');
        this.name = 'RemoteSyncManifestChangedError';
    }
}

/**
 * Loaded manifest state including the current S3 ETag.
 */
export interface LoadedRemoteSyncManifest {
    manifest: RemoteSyncManifest;
    etag: string | null;
    existed: boolean;
}

/**
 * RemoteSyncStore manages the shared manifest and device registry.
 */
export class RemoteSyncStore {
    private syncPrefix: string;

    constructor(private s3Provider: S3Provider, syncPrefix: string) {
        this.syncPrefix = normalizePrefix(syncPrefix);
    }

    /**
     * Update the active sync prefix.
     */
    updateSyncPrefix(syncPrefix: string): void {
        this.syncPrefix = normalizePrefix(syncPrefix);
    }

    /**
     * Load the current manifest, creating an empty in-memory manifest when none exists.
     */
    async loadManifest(): Promise<LoadedRemoteSyncManifest> {
        const manifestKey = this.getManifestKey();
        const metadata = await this.s3Provider.getFileMetadata(manifestKey);

        if (!metadata) {
            return {
                manifest: this.createEmptyManifest(),
                etag: null,
                existed: false,
            };
        }

        const manifestJson = await this.s3Provider.downloadFileAsText(manifestKey);
        const parsed = JSON.parse(manifestJson) as Partial<RemoteSyncManifest>;

        return {
            manifest: this.normalizeManifest(parsed),
            etag: metadata.etag ?? null,
            existed: true,
        };
    }

    /**
     * Persist the shared manifest using optimistic concurrency checks.
     */
    async saveManifest(manifest: RemoteSyncManifest, currentEtag: string | null): Promise<string> {
        const manifestKey = this.getManifestKey();
        const manifestJson = JSON.stringify(manifest, null, 2);

        try {
            return await this.s3Provider.uploadFile(manifestKey, manifestJson, {
                contentType: 'application/json',
                ifMatch: currentEtag ?? undefined,
                ifNoneMatch: currentEtag ? undefined : '*',
            });
        } catch (error) {
            const err = error as Error & { $metadata?: { httpStatusCode?: number }; name?: string };
            if (
                err.$metadata?.httpStatusCode === 409 ||
                err.$metadata?.httpStatusCode === 412 ||
                err.name === 'ConditionalRequestConflict' ||
                err.name === 'PreconditionFailed'
            ) {
                throw new RemoteSyncManifestChangedError();
            }
            throw error;
        }
    }

    /**
     * Register or update the current device in the remote registry.
     */
    async touchDevice(deviceInfo: RemoteSyncDeviceInfo): Promise<void> {
        const key = addPrefix(`${METADATA_DIR}/${DEVICES_DIR}/${deviceInfo.deviceId}.json`, this.syncPrefix);
        await this.s3Provider.uploadFile(key, JSON.stringify(deviceInfo, null, 2), {
            contentType: 'application/json',
        });
    }

    /**
     * Check whether an S3 object key belongs to sync metadata.
     */
    isMetadataKey(key: string): boolean {
        const relativePath = removePrefix(key, this.syncPrefix);
        return relativePath?.startsWith(`${METADATA_DIR}/`) ?? false;
    }

    /**
     * Create an empty manifest.
     */
    createEmptyManifest(): RemoteSyncManifest {
        return {
            version: 1,
            generation: 0,
            updatedAt: 0,
            updatedBy: '',
            files: {},
            tombstones: {},
        };
    }

    /**
     * Return the full S3 key for the shared manifest.
     */
    getManifestKey(): string {
        return addPrefix(`${METADATA_DIR}/${MANIFEST_FILE}`, this.syncPrefix);
    }

    /**
     * Normalize a parsed manifest into the current schema.
     */
    private normalizeManifest(parsed: Partial<RemoteSyncManifest>): RemoteSyncManifest {
        const files = parsed.files ?? {};
        const tombstones = parsed.tombstones ?? {};

        return {
            version: 1,
            generation: typeof parsed.generation === 'number' ? parsed.generation : 0,
            updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
            updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : '',
            files,
            tombstones,
        };
    }
}
