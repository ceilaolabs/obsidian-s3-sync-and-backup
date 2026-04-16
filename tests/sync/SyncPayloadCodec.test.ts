jest.mock('../../src/crypto/Hasher');
jest.mock('../../src/crypto/FileEncryptor');

import { decrypt, encrypt } from '../../src/crypto/FileEncryptor';
import { hashContent } from '../../src/crypto/Hasher';
import { SyncPayloadCodec } from '../../src/sync/SyncPayloadCodec';

describe('SyncPayloadCodec', () => {
	const key = new Uint8Array(32).fill(7);
	const differentKey = new Uint8Array(32).fill(9);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	const mockedHashContent = jest.mocked(hashContent);
	const mockedEncrypt = jest.mocked(encrypt);
	const mockedDecrypt = jest.mocked(decrypt);

	beforeEach(() => {
		jest.resetAllMocks();
	});

	describe('isEncryptionEnabled', () => {
		it('returns false when constructed without a key', () => {
			const codec = new SyncPayloadCodec(null);

			expect(codec.isEncryptionEnabled).toBe(false);
		});

		it('returns true when constructed with a key', () => {
			const codec = new SyncPayloadCodec(key);

			expect(codec.isEncryptionEnabled).toBe(true);
		});
	});

	describe('updateKey', () => {
		it('toggles encryption state as the key changes', () => {
			const codec = new SyncPayloadCodec(null);

			codec.updateKey(key);
			expect(codec.isEncryptionEnabled).toBe(true);

			codec.updateKey(null);
			expect(codec.isEncryptionEnabled).toBe(false);
		});
	});

	describe('getActivePayloadFormat', () => {
		it('returns plaintext-v1 when no key is loaded', () => {
			const codec = new SyncPayloadCodec(null);

			expect(codec.getActivePayloadFormat()).toBe('plaintext-v1');
		});

		it('returns xsalsa20poly1305-v1 when a key is loaded', () => {
			const codec = new SyncPayloadCodec(key);

			expect(codec.getActivePayloadFormat()).toBe('xsalsa20poly1305-v1');
		});
	});

	describe('fingerprint', () => {
		it('returns a sha256-prefixed fingerprint for string input', async () => {
			mockedHashContent.mockResolvedValue('abc123');
			const codec = new SyncPayloadCodec(null);

			await expect(codec.fingerprint('plain text')).resolves.toBe('sha256:abc123');
			expect(mockedHashContent).toHaveBeenCalledWith('plain text');
		});

		it('returns a sha256-prefixed fingerprint for binary input', async () => {
			const payload = Uint8Array.from([1, 2, 3]);
			mockedHashContent.mockResolvedValue('def456');
			const codec = new SyncPayloadCodec(key);

			await expect(codec.fingerprint(payload)).resolves.toBe('sha256:def456');
			expect(mockedHashContent).toHaveBeenCalledWith(payload);
		});
	});

	describe('encodeForUpload', () => {
		it('returns encoded bytes unchanged when encryption is disabled and input is a string', () => {
			const codec = new SyncPayloadCodec(null);

			expect(codec.encodeForUpload('hello')).toEqual(encoder.encode('hello'));
			expect(mockedEncrypt).not.toHaveBeenCalled();
		});

		it('returns the original bytes unchanged when encryption is disabled and input is binary', () => {
			const payload = Uint8Array.from([4, 5, 6]);
			const codec = new SyncPayloadCodec(null);

			expect(codec.encodeForUpload(payload)).toBe(payload);
			expect(mockedEncrypt).not.toHaveBeenCalled();
		});

		it('encrypts bytes when encryption is enabled', () => {
			const encryptedPayload = Uint8Array.from([9, 8, 7]);
			mockedEncrypt.mockReturnValue(encryptedPayload);
			const codec = new SyncPayloadCodec(key);

			expect(codec.encodeForUpload('secret')).toBe(encryptedPayload);
			expect(mockedEncrypt).toHaveBeenCalledWith(encoder.encode('secret'), key);
		});
	});

	describe('decodeAfterDownload', () => {
		it('returns the payload unchanged when encryption is disabled', () => {
			const payload = Uint8Array.from([7, 8, 9]);
			const codec = new SyncPayloadCodec(null);

			expect(codec.decodeAfterDownload(payload)).toBe(payload);
			expect(mockedDecrypt).not.toHaveBeenCalled();
		});

		it('decrypts the payload when encryption is enabled', () => {
			const payload = Uint8Array.from([7, 8, 9]);
			const decryptedPayload = Uint8Array.from([1, 2, 3]);
			mockedDecrypt.mockReturnValue(decryptedPayload);
			const codec = new SyncPayloadCodec(key);

			expect(codec.decodeAfterDownload(payload, 'xsalsa20poly1305-v1')).toBe(decryptedPayload);
			expect(mockedDecrypt).toHaveBeenCalledWith(payload, key);
		});
	});

	describe('decodeToString', () => {
		it('decodes unencrypted payloads to text', () => {
			const codec = new SyncPayloadCodec(null);

			expect(codec.decodeToString(encoder.encode('plain text'))).toBe('plain text');
		});

		it('decodes decrypted payloads to text after the key is updated', () => {
			const decryptedPayload = encoder.encode('secret text');
			mockedDecrypt.mockReturnValue(decryptedPayload);
			const codec = new SyncPayloadCodec(null);

			codec.updateKey(differentKey);

			expect(codec.decodeToString(Uint8Array.from([3, 2, 1]), 'xsalsa20poly1305-v1')).toBe(decoder.decode(decryptedPayload));
			expect(mockedDecrypt).toHaveBeenCalledWith(Uint8Array.from([3, 2, 1]), differentKey);
		});
	});
});
