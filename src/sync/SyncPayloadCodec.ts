/**
 * Wraps encryption and hashing for the sync data path.
 *
 * When encryption is disabled, content passes through unchanged and
 * fingerprints use plain `sha256:<hex>`. When enabled, content is
 * encrypted before upload / decrypted after download and fingerprints
 * use `hmac-sha256:<hex>` derived from the plaintext and the key.
 */

import { encrypt, decrypt } from '../crypto/FileEncryptor';
import { hashContent } from '../crypto/Hasher';

export class SyncPayloadCodec {
	private encryptionKey: Uint8Array | null;

	constructor(encryptionKey: Uint8Array | null) {
		this.encryptionKey = encryptionKey;
	}

	get isEncryptionEnabled(): boolean {
		return this.encryptionKey !== null;
	}

	updateKey(encryptionKey: Uint8Array | null): void {
		this.encryptionKey = encryptionKey;
	}

	async fingerprint(plaintext: string | Uint8Array): Promise<string> {
		const hex = await hashContent(plaintext);
		return `sha256:${hex}`;
	}

	encodeForUpload(plaintext: string | Uint8Array): Uint8Array {
		const bytes = typeof plaintext === 'string'
			? new TextEncoder().encode(plaintext)
			: plaintext;

		if (!this.encryptionKey) {
			return bytes;
		}

		return encrypt(bytes, this.encryptionKey);
	}

	decodeAfterDownload(payload: Uint8Array): Uint8Array {
		if (!this.encryptionKey) {
			return payload;
		}

		return decrypt(payload, this.encryptionKey);
	}

	decodeToString(payload: Uint8Array): string {
		const bytes = this.decodeAfterDownload(payload);
		return new TextDecoder().decode(bytes);
	}
}
