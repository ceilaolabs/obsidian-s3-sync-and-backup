/**
 * Converts between local vault paths and S3 remote keys.
 *
 * Centralises prefix logic so callers never assemble S3 keys manually.
 */

import { addPrefix, removePrefix, normalizePrefix } from '../utils/paths';

const METADATA_DIR = '.obsidian-s3-sync';

export class SyncPathCodec {
	private normalizedPrefix: string;

	constructor(syncPrefix: string) {
		this.normalizedPrefix = normalizePrefix(syncPrefix);
	}

	updatePrefix(syncPrefix: string): void {
		this.normalizedPrefix = normalizePrefix(syncPrefix);
	}

	localToRemote(localPath: string): string {
		return addPrefix(localPath, this.normalizedPrefix);
	}

	remoteToLocal(remoteKey: string): string | null {
		return removePrefix(remoteKey, this.normalizedPrefix);
	}

	isMetadataKey(remoteKey: string): boolean {
		const relativePath = removePrefix(remoteKey, this.normalizedPrefix);
		return relativePath?.startsWith(`${METADATA_DIR}/`) ?? false;
	}

	getListPrefix(): string {
		return this.normalizedPrefix ? `${this.normalizedPrefix}/` : '';
	}

	getMetadataDir(): string {
		return addPrefix(METADATA_DIR, this.normalizedPrefix);
	}

	getEngineMarkerKey(): string {
		return addPrefix(`${METADATA_DIR}/engine.json`, this.normalizedPrefix);
	}
}
