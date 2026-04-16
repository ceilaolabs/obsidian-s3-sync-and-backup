/**
 * End-to-end encryption workflow tests.
 *
 * These tests exercise encrypted and plaintext payload handling through the
 * real sync pipeline against a real S3 bucket. They verify that sync uploads
 * the expected wire format, that downloads decode according to payload format
 * metadata, and that multiple devices can interoperate when they share (or do
 * not share) the same derived encryption key.
 */

import { randomFillSync } from 'node:crypto';

import { TFile } from 'obsidian';

import { decrypt, encrypt } from '../../src/crypto/FileEncryptor';
import { hashContent } from '../../src/crypto/Hasher';
import { deriveKey } from '../../src/crypto/KeyDerivation';
import { encodeMetadata } from '../../src/sync/SyncObjectMetadata';
import { E2EDevice, cleanupS3Prefix, createDevice, generateTestPrefix, hasS3Credentials, initDevice, teardownDevice } from './helpers/e2e-harness';

const describeIfS3 = hasS3Credentials() ? describe : describe.skip;

/**
 * Creates and initializes a device for a scenario-specific child prefix.
 */
async function createInitializedDevice(options: {
	deviceId: string;
	testPrefix: string;
	encryptionKey?: Uint8Array | null;
}): Promise<E2EDevice> {
	const device = createDevice({
		deviceId: options.deviceId,
		testPrefix: options.testPrefix,
		encryptionKey: options.encryptionKey ?? null,
		settingsOverrides: {
			encryptionEnabled: options.encryptionKey !== undefined && options.encryptionKey !== null,
		},
	});

	await initDevice(device);
	return device;
}

/**
 * Reads a text file from the in-memory vault and fails loudly if it is absent.
 */
async function readVaultText(device: E2EDevice, path: string): Promise<string> {
	const file = device.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		throw new Error(`Expected vault file to exist: ${path}`);
	}

	return await device.vault.read(file);
}

/**
 * Computes the sync fingerprint string stored in object metadata.
 */
async function createPlaintextFingerprint(content: string): Promise<string> {
	return `sha256:${await hashContent(content)}`;
}

/**
 * Encryption workflows through the real sync pipeline and real S3.
 */
describeIfS3('E2E encryption workflow', () => {
	let suitePrefix: string;
	let suiteSalt: Uint8Array;
	let suiteEncryptionKey: Uint8Array;
	let suiteDevice: E2EDevice;
	const devices: E2EDevice[] = [];

	beforeAll(async () => {
		suitePrefix = generateTestPrefix('encryption-workflow');
		suiteSalt = randomFillSync(new Uint8Array(32));
		suiteEncryptionKey = await deriveKey('correct horse battery staple', suiteSalt);
		suiteDevice = await createInitializedDevice({
			deviceId: 'suite-encrypted-device',
			testPrefix: suitePrefix,
			encryptionKey: suiteEncryptionKey,
		});
		devices.push(suiteDevice);
	});

	afterAll(async () => {
		if (suiteDevice) {
			await cleanupS3Prefix(suiteDevice.s3Provider, suitePrefix);
		}

		for (const device of devices) {
			await teardownDevice(device);
		}
	});

	/** Verifies that sync uploads ciphertext rather than plaintext bytes. */
	it('uploads encrypted ciphertext to S3 instead of plaintext when encryption is enabled', async () => {
		const scenarioPrefix = `${suitePrefix}/encrypted-upload`;
		const device = await createInitializedDevice({
			deviceId: 'encrypted-upload-device',
			testPrefix: scenarioPrefix,
			encryptionKey: suiteEncryptionKey,
		});
		devices.push(device);

		const path = 'notes/encrypted-upload.md';
		const plaintext = '# Secret note\nThis content should be encrypted in S3.';
		const plaintextBytes = new TextEncoder().encode(plaintext);
		device.vault.seed(path, plaintext);

		const result = await device.syncEngine.sync();
		expect(result.success).toBe(true);
		expect(result.errors).toHaveLength(0);

		const remoteKey = device.pathCodec.localToRemote(path);
		const downloaded = await device.s3Provider.downloadFileWithMetadata(remoteKey);
		expect(downloaded).not.toBeNull();
		expect(downloaded?.payloadFormat).toBe('xsalsa20poly1305-v1');
		expect(Array.from(downloaded!.content)).not.toEqual(Array.from(plaintextBytes));

		const manuallyDecrypted = decrypt(downloaded!.content, suiteEncryptionKey);
		expect(new TextDecoder().decode(manuallyDecrypted)).toBe(plaintext);
	});

	/** Verifies that the codec can decrypt a downloaded encrypted payload. */
	it('decrypts an encrypted S3 payload back to the original plaintext on download', async () => {
		const scenarioPrefix = `${suitePrefix}/codec-decrypt`;
		const device = await createInitializedDevice({
			deviceId: 'codec-decrypt-device',
			testPrefix: scenarioPrefix,
			encryptionKey: suiteEncryptionKey,
		});
		devices.push(device);

		const path = 'notes/codec-decrypt.md';
		const plaintext = 'Decrypt this payload through SyncPayloadCodec.';
		device.vault.seed(path, plaintext);

		const result = await device.syncEngine.sync();
		expect(result.success).toBe(true);

		const remoteKey = device.pathCodec.localToRemote(path);
		const downloaded = await device.s3Provider.downloadFileWithMetadata(remoteKey);
		expect(downloaded).not.toBeNull();

		const decoded = device.payloadCodec.decodeAfterDownload(downloaded!.content, downloaded!.payloadFormat);
		expect(new TextDecoder().decode(decoded)).toBe(plaintext);
	});

	/** Verifies a full encrypted round-trip between two devices sharing the same key. */
	it('round-trips an encrypted file from device A to device B when both share the same key', async () => {
		const scenarioPrefix = `${suitePrefix}/round-trip`;
		const deviceA = await createInitializedDevice({
			deviceId: 'device-a',
			testPrefix: scenarioPrefix,
			encryptionKey: suiteEncryptionKey,
		});
		devices.push(deviceA);

		const deviceB = await createInitializedDevice({
			deviceId: 'device-b',
			testPrefix: scenarioPrefix,
			encryptionKey: suiteEncryptionKey,
		});
		devices.push(deviceB);

		const path = 'shared/round-trip.md';
		const plaintext = 'Shared encrypted note that should appear on the second device.';
		deviceA.vault.seed(path, plaintext);

		const uploadResult = await deviceA.syncEngine.sync();
		expect(uploadResult.success).toBe(true);

		const downloadResult = await deviceB.syncEngine.sync();
		expect(downloadResult.success).toBe(true);
		expect(downloadResult.filesDownloaded).toBeGreaterThanOrEqual(1);

		expect(deviceB.vault.has(path)).toBe(true);
		expect(await readVaultText(deviceB, path)).toBe(plaintext);
	});

	/** Verifies that a device with the wrong key fails when it encounters encrypted content. */
	it('fails gracefully when a second device syncs encrypted content with the wrong passphrase-derived key', async () => {
		const scenarioPrefix = `${suitePrefix}/wrong-passphrase`;
		const deviceA = await createInitializedDevice({
			deviceId: 'wrong-pass-source',
			testPrefix: scenarioPrefix,
			encryptionKey: suiteEncryptionKey,
		});
		devices.push(deviceA);

		const wrongKey = await deriveKey('this is definitely the wrong passphrase', suiteSalt);
		const deviceB = await createInitializedDevice({
			deviceId: 'wrong-pass-target',
			testPrefix: scenarioPrefix,
			encryptionKey: wrongKey,
		});
		devices.push(deviceB);

		const path = 'shared/wrong-passphrase.md';
		const plaintext = 'Only the correct derived key should decrypt this.';
		deviceA.vault.seed(path, plaintext);

		const uploadResult = await deviceA.syncEngine.sync();
		expect(uploadResult.success).toBe(true);

		const syncResult = await deviceB.syncEngine.sync();
		expect(syncResult.success).toBe(false);
		expect(syncResult.errors.length).toBeGreaterThan(0);
		expect(syncResult.errors.some(error => /decrypt|invalid key|corrupted/i.test(error.message))).toBe(true);

		const remoteKey = deviceA.pathCodec.localToRemote(path);
		const downloaded = await deviceA.s3Provider.downloadFileWithMetadata(remoteKey);
		expect(downloaded).not.toBeNull();
		expect(() => deviceB.payloadCodec.decodeAfterDownload(downloaded!.content, downloaded!.payloadFormat)).toThrow(/decrypt|invalid key|corrupted/i);
	});

	/** Verifies that devices without an encryption key upload plaintext bytes. */
	it('uploads plaintext bytes to S3 when no encryption key is configured', async () => {
		const scenarioPrefix = `${suitePrefix}/plaintext-upload`;
		const device = await createInitializedDevice({
			deviceId: 'plaintext-device',
			testPrefix: scenarioPrefix,
			encryptionKey: null,
		});
		devices.push(device);

		const path = 'notes/plaintext.md';
		const plaintext = 'This file should remain plaintext in S3.';
		const plaintextBytes = new TextEncoder().encode(plaintext);
		device.vault.seed(path, plaintext);

		const result = await device.syncEngine.sync();
		expect(result.success).toBe(true);

		const remoteKey = device.pathCodec.localToRemote(path);
		const downloaded = await device.s3Provider.downloadFileWithMetadata(remoteKey);
		expect(downloaded).not.toBeNull();
		expect(downloaded?.payloadFormat).toBe('plaintext-v1');
		expect(Array.from(downloaded!.content)).toEqual(Array.from(plaintextBytes));
	});

	/** Verifies that an encrypted device still accepts plaintext-tagged remote payloads. */
	it('downloads and reads plaintext-tagged remote objects even when the syncing device has encryption enabled', async () => {
		const scenarioPrefix = `${suitePrefix}/mixed-format`;
		const device = await createInitializedDevice({
			deviceId: 'mixed-format-device',
			testPrefix: scenarioPrefix,
			encryptionKey: suiteEncryptionKey,
		});
		devices.push(device);

		const path = 'notes/plaintext-from-remote.md';
		const plaintext = 'This remote object is plaintext but explicitly tagged as plaintext-v1.';
		const remoteKey = device.pathCodec.localToRemote(path);

		await device.s3Provider.uploadFile(remoteKey, new TextEncoder().encode(plaintext), {
			contentType: 'text/markdown',
			metadata: encodeMetadata({
				fingerprint: await createPlaintextFingerprint(plaintext),
				clientMtime: Date.now(),
				deviceId: 'manual-plaintext-uploader',
				payloadFormat: 'plaintext-v1',
			}),
		});

		const result = await device.syncEngine.sync();
		expect(result.success).toBe(true);
		expect(device.vault.has(path)).toBe(true);
		expect(await readVaultText(device, path)).toBe(plaintext);
	});

	/** Verifies that a manually encrypted remote object is readable through the sync pipeline. */
	it('downloads a manually encrypted remote object when metadata marks it as xsalsa20poly1305-v1', async () => {
		const scenarioPrefix = `${suitePrefix}/manual-encrypted-object`;
		const device = await createInitializedDevice({
			deviceId: 'manual-encrypted-device',
			testPrefix: scenarioPrefix,
			encryptionKey: suiteEncryptionKey,
		});
		devices.push(device);

		const path = 'notes/manual-encrypted.md';
		const plaintext = 'This object was encrypted manually before the sync download path touched it.';
		const ciphertext = encrypt(plaintext, suiteEncryptionKey);
		const remoteKey = device.pathCodec.localToRemote(path);

		await device.s3Provider.uploadFile(remoteKey, ciphertext, {
			contentType: 'text/markdown',
			metadata: encodeMetadata({
				fingerprint: await createPlaintextFingerprint(plaintext),
				clientMtime: Date.now(),
				deviceId: 'manual-encrypted-uploader',
				payloadFormat: 'xsalsa20poly1305-v1',
			}),
		});

		const result = await device.syncEngine.sync();
		expect(result.success).toBe(true);
		expect(device.vault.has(path)).toBe(true);
		expect(await readVaultText(device, path)).toBe(plaintext);
	});
});
