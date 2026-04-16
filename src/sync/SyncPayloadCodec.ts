/**
 * Wraps encryption and hashing for the sync data path.
 *
 * When encryption is disabled, content passes through unchanged and
 * fingerprints use plain `sha256:<hex>`. When enabled, content is
 * encrypted before upload / decrypted after download and fingerprints
 * use `hmac-sha256:<hex>` derived from the plaintext and the key.
 *
 * This codec is the single choke-point for all content transformations in
 * the sync pipeline, ensuring that the encryption state is applied
 * consistently across every upload and download operation.
 */

import { encrypt, decrypt } from '../crypto/FileEncryptor';
import { hashContent } from '../crypto/Hasher';

/**
 * Applies encryption and content hashing to file payloads traversing the
 * sync data path.
 *
 * Callers use this class as follows:
 * - **Upload path:** call `fingerprint(plaintext)` to obtain the content
 *   hash for S3 metadata, then `encodeForUpload(plaintext)` to obtain the
 *   bytes to PUT to S3.
 * - **Download path:** call `decodeAfterDownload(payload)` to decrypt raw
 *   S3 bytes back to plaintext, or `decodeToString(payload)` for text files.
 *
 * The encryption key can be swapped at runtime via `updateKey()` when the
 * user changes their passphrase in settings.
 */
export class SyncPayloadCodec {
	private encryptionKey: Uint8Array | null;

	/**
	 * Creates a new `SyncPayloadCodec`.
	 *
	 * @param encryptionKey - The derived encryption key to use for
	 *   XSalsa20-Poly1305 encryption/decryption, or `null` to run in
	 *   plaintext (no-encryption) mode.
	 */
	constructor(encryptionKey: Uint8Array | null) {
		this.encryptionKey = encryptionKey;
	}

	/**
	 * Whether end-to-end encryption is currently active.
	 *
	 * `true` when an encryption key has been provided; `false` when
	 * the codec is operating in plaintext pass-through mode.
	 */
	get isEncryptionEnabled(): boolean {
		return this.encryptionKey !== null;
	}

	/**
	 * Replaces the active encryption key without constructing a new codec.
	 *
	 * Called by the settings handler when the user updates (or clears) their
	 * encryption passphrase so all existing references to the codec remain valid.
	 *
	 * @param encryptionKey - The new derived key, or `null` to disable encryption.
	 */
	updateKey(encryptionKey: Uint8Array | null): void {
		this.encryptionKey = encryptionKey;
	}

	/**
	 * Computes the SHA-256 fingerprint of the given plaintext content.
	 *
	 * The fingerprint is always computed on the **plaintext** bytes, never on
	 * the encrypted ciphertext.  This is intentional: it allows the sync
	 * engine to detect content identity (i.e. "did this file actually change?")
	 * regardless of whether encryption is enabled or which key was active when
	 * the file was uploaded.  Comparing ciphertext hashes would fail whenever
	 * the key changes, since the same plaintext would produce a different
	 * ciphertext with a different nonce.
	 *
	 * @param plaintext - The raw file content as a string or `Uint8Array`.
	 * @returns A promise that resolves to a `"sha256:<hex>"` fingerprint string.
	 */
	async fingerprint(plaintext: string | Uint8Array): Promise<string> {
		const hex = await hashContent(plaintext);
		return `sha256:${hex}`;
	}

	/**
	 * Encodes plaintext content for upload to S3.
	 *
	 * In plaintext mode, the input is returned as-is (as a `Uint8Array`).
	 * In encrypted mode, the bytes are encrypted with XSalsa20-Poly1305 using
	 * the active encryption key before being returned.
	 *
	 * @param plaintext - The file content to encode, as a string or binary
	 *   `Uint8Array`.  Strings are UTF-8 encoded before encryption.
	 * @returns The bytes ready for upload — either the raw content or the
	 *   encrypted ciphertext.
	 */
	encodeForUpload(plaintext: string | Uint8Array): Uint8Array {
		const bytes = typeof plaintext === 'string'
			? new TextEncoder().encode(plaintext)
			: plaintext;

		if (!this.encryptionKey) {
			return bytes;
		}

		return encrypt(bytes, this.encryptionKey);
	}

	/**
	 * Decodes raw bytes downloaded from S3 back to their plaintext form.
	 *
	 * In plaintext mode, the payload is returned unchanged.  In encrypted
	 * mode, the bytes are decrypted with XSalsa20-Poly1305 using the active
	 * encryption key.
	 *
	 * @param payload - The raw bytes as received from S3.
	 * @returns The decrypted (or unchanged) plaintext bytes.
	 * @throws If decryption fails (e.g. wrong key or corrupted payload),
	 *   the underlying `FileEncryptor.decrypt` will throw.
	 */
	decodeAfterDownload(payload: Uint8Array): Uint8Array {
		if (!this.encryptionKey) {
			return payload;
		}

		return decrypt(payload, this.encryptionKey);
	}

	/**
	 * Convenience method that decodes downloaded bytes and returns a UTF-8
	 * string.  Useful for text-based vault files (Markdown, JSON, etc.).
	 *
	 * Internally delegates to `decodeAfterDownload` then applies
	 * `TextDecoder`.
	 *
	 * @param payload - The raw bytes as received from S3.
	 * @returns The decoded plaintext as a UTF-8 string.
	 * @throws If decryption fails, propagates the error from `decodeAfterDownload`.
	 */
	decodeToString(payload: Uint8Array): string {
		const bytes = this.decodeAfterDownload(payload);
		return new TextDecoder().decode(bytes);
	}
}
