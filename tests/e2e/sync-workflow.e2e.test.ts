/**
 * E2E tests for the full sync workflow against real S3.
 *
 * This suite exercises `SyncEngine.sync()` end to end using the real sync
 * planner/executor pipeline, a real S3 bucket, fake IndexedDB journal state,
 * and the in-memory E2E vault harness.
 */

import { TFile } from 'obsidian';

import { encodeMetadata } from '../../src/sync/SyncObjectMetadata';
import { getVaultFileKind } from '../../src/utils/vaultFiles';
import {
	cleanupS3Prefix,
	createDevice,
	generateTestPrefix,
	hasS3Credentials,
	initDevice,
	teardownDevice,
	type E2EDevice,
} from './helpers/e2e-harness';

const describeIfS3 = hasS3Credentials() ? describe : describe.skip;

/**
 * Builds the metadata required for a direct-to-S3 upload that the sync planner
 * can later interpret as a normal synced object.
 */
async function createRemoteMetadata(
	device: E2EDevice,
	content: string | Uint8Array,
	clientMtime: number,
	deviceId: string,
): Promise<Record<string, string>> {
	return encodeMetadata({
		fingerprint: await device.payloadCodec.fingerprint(content),
		clientMtime,
		deviceId,
		payloadFormat: device.payloadCodec.getActivePayloadFormat(),
	});
}

/**
 * Reads a vault path and narrows it to a `TFile` for content assertions.
 */
function getRequiredVaultFile(device: E2EDevice, path: string): TFile {
	const file = device.vault.getAbstractFileByPath(path);
	expect(file).toBeInstanceOf(TFile);
	if (!(file instanceof TFile)) {
		throw new Error(`Expected vault file at path: ${path}`);
	}
	return file;
}

/**
 * Covers the single-device sync pipeline against real S3 for create, update,
 * delete, exclusion, and binary-file workflows.
 */
describeIfS3('Sync workflow E2E tests', () => {
	let device: E2EDevice;
	let testPrefix: string;

	beforeAll(async () => {
		testPrefix = generateTestPrefix('sync');
		device = createDevice({ testPrefix });
		await initDevice(device);
	});

	afterAll(async () => {
		await cleanupS3Prefix(device.s3Provider, testPrefix);
		await teardownDevice(device);
	});

	beforeEach(async () => {
		device.vault.clear();
		await device.journal.clear();
		await cleanupS3Prefix(device.s3Provider, testPrefix);

		device.settings.excludePatterns = [];
		device.syncEngine.updateSettings(device.settings);
		device.changeTracker.updateExcludePatterns(device.settings.excludePatterns);
		device.changeTracker.clearAll();
	});

	/**
	 * Verifies that an unsynced local text file is uploaded into the configured
	 * sync prefix and counted as an upload.
	 */
	it('uploads a new local file to S3 on the first sync', async () => {
		const path = 'Notes/upload-new.md';
		const content = '# Upload me';
		device.vault.seed(path, content);

		const result = await device.syncEngine.sync();
		const remote = await device.s3Provider.downloadFileWithMetadata(device.pathCodec.localToRemote(path));

		expect(result.success).toBe(true);
		expect(result.filesUploaded).toBe(1);
		expect(result.errors).toHaveLength(0);
		expect(remote).not.toBeNull();
		expect(new TextDecoder().decode(remote!.content)).toBe(content);
	});

	/**
	 * Verifies that a remote-only object with sync metadata is downloaded into
	 * the in-memory vault during a sync.
	 */
	it('downloads a new remote file into the vault', async () => {
		const path = 'Notes/download-new.md';
		const content = '# Remote note';
		const clientMtime = Date.now() - 1_000;
		await device.s3Provider.uploadFile(device.pathCodec.localToRemote(path), content, {
			contentType: 'text/plain',
			metadata: await createRemoteMetadata(device, content, clientMtime, 'remote-seed-device'),
		});

		const result = await device.syncEngine.sync();
		const localFile = getRequiredVaultFile(device, path);

		expect(result.success).toBe(true);
		expect(result.filesDownloaded).toBe(1);
		expect(device.vault.has(path)).toBe(true);
		expect(await device.vault.read(localFile)).toBe(content);
	});

	/**
	 * Verifies that rerunning sync without any local or remote changes produces
	 * a successful no-op result with zero transfer counters.
	 */
	it('reports a no-op sync when local and remote are already aligned', async () => {
		const path = 'Notes/noop.md';
		device.vault.seed(path, '# Stable note');

		const firstResult = await device.syncEngine.sync();
		const secondResult = await device.syncEngine.sync();

		expect(firstResult.success).toBe(true);
		expect(secondResult.success).toBe(true);
		expect(secondResult.filesUploaded).toBe(0);
		expect(secondResult.filesDownloaded).toBe(0);
		expect(secondResult.filesDeleted).toBe(0);
		expect(secondResult.filesAdopted).toBe(0);
		expect(secondResult.filesForgotten).toBe(0);
		expect(secondResult.errors).toHaveLength(0);
	});

	/**
	 * Verifies that modifying a previously synced local file uploads the new
	 * version and replaces the remote content.
	 */
	it('uploads a modified local file on a later sync', async () => {
		const path = 'Notes/modify-upload.md';
		const file = device.vault.seed(path, '# Version 1');
		await device.syncEngine.sync();

		await device.vault.modify(file, '# Version 2');
		const result = await device.syncEngine.sync();
		const remote = await device.s3Provider.downloadFileWithMetadata(device.pathCodec.localToRemote(path));

		expect(result.success).toBe(true);
		expect(result.filesUploaded).toBe(1);
		expect(remote).not.toBeNull();
		expect(new TextDecoder().decode(remote!.content)).toBe('# Version 2');
	});

	/**
	 * Verifies that deleting a previously synced local file removes the matching
	 * object from S3 during the next sync.
	 */
	it('deletes the remote object after the local file is removed', async () => {
		const path = 'Notes/delete-remote.md';
		const file = device.vault.seed(path, '# Delete remote');
		await device.syncEngine.sync();

		await device.vault.delete(file);
		const result = await device.syncEngine.sync();
		const remote = await device.s3Provider.downloadFileWithMetadata(device.pathCodec.localToRemote(path));

		expect(result.success).toBe(true);
		expect(result.filesDeleted).toBe(1);
		expect(remote).toBeNull();
	});

	/**
	 * Verifies that deleting a previously synced remote object causes the local
	 * file to be removed on the next sync.
	 */
	it('deletes the local file after the remote object is removed', async () => {
		const path = 'Notes/delete-local.md';
		device.vault.seed(path, '# Delete local');
		await device.syncEngine.sync();

		await device.s3Provider.deleteFile(device.pathCodec.localToRemote(path));
		const result = await device.syncEngine.sync();

		expect(result.success).toBe(true);
		expect(result.filesDeleted).toBe(1);
		expect(device.vault.has(path)).toBe(false);
	});

	/**
	 * Verifies that user-configured exclude patterns prevent matching files from
	 * entering the sync plan while still allowing non-matching files to sync.
	 */
	it('respects exclude patterns when choosing files to upload', async () => {
		device.settings.excludePatterns = ['*.tmp'];
		device.syncEngine.updateSettings(device.settings);

		device.vault.seed('notes.md', '# Included');
		device.vault.seed('data.tmp', 'ignore me');

		const result = await device.syncEngine.sync();
		const included = await device.s3Provider.downloadFileWithMetadata(device.pathCodec.localToRemote('notes.md'));
		const excluded = await device.s3Provider.downloadFileWithMetadata(device.pathCodec.localToRemote('data.tmp'));

		expect(result.success).toBe(true);
		expect(result.filesUploaded).toBe(1);
		expect(included).not.toBeNull();
		expect(excluded).toBeNull();
	});

	/**
	 * Verifies that binary payloads are read through the binary vault path,
	 * uploaded without UTF-8 corruption, and preserved byte-for-byte in S3.
	 */
	it('syncs binary files without altering their bytes', async () => {
		const path = 'Attachments/blob.bin';
		const content = new Uint8Array([0, 255, 10, 13, 128, 64, 1, 200]);
		device.vault.seed(path, content);

		const result = await device.syncEngine.sync();
		const remote = await device.s3Provider.downloadFileWithMetadata(device.pathCodec.localToRemote(path));

		expect(getVaultFileKind(path)).toBe('binary');
		expect(result.success).toBe(true);
		expect(result.filesUploaded).toBe(1);
		expect(remote).not.toBeNull();
		expect(Array.from(remote!.content)).toEqual(Array.from(content));
	});
});
