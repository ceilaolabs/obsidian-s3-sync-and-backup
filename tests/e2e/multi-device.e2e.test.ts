/**
 * Real-S3 E2E tests for multi-device sync flows.
 *
 * These tests spin up two fully wired E2E devices that share the same S3 sync
 * prefix but keep separate in-memory vaults and IndexedDB journals. Together
 * they verify that the real SyncEngine converges state correctly across
 * devices, including conflict creation and delete propagation.
 */

import { TFile } from 'obsidian';

import type { SyncResult } from '../../src/types';
import {
	cleanupS3Prefix,
	createDevice,
	type E2EDevice,
	generateTestPrefix,
	hasS3Credentials,
	initDevice,
	teardownDevice,
} from './helpers/e2e-harness';

const describeIfS3 = hasS3Credentials() ? describe : describe.skip;

function getFileOrThrow(device: E2EDevice, path: string): TFile {
	const file = device.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		throw new Error(`Expected file at path: ${path}`);
	}

	return file;
}

async function readVaultText(device: E2EDevice, path: string): Promise<string | null> {
	const file = device.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		return null;
	}

	return await device.vault.read(file);
}

async function readS3Text(device: E2EDevice, path: string): Promise<string> {
	return await device.s3Provider.downloadFileAsText(device.pathCodec.localToRemote(path));
}

async function listSyncKeys(device: E2EDevice, prefix: string): Promise<string[]> {
	const objects = await device.s3Provider.listObjects(prefix);
	return objects.map((object) => object.key).sort();
}

function expectSuccessfulSync(result: SyncResult): void {
	expect(result.success).toBe(true);
	expect(result.errors).toHaveLength(0);
	expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
}

/**
 * Covers real multi-device reconciliation using two independent devices that
 * share one S3 prefix but maintain separate local vaults and journals.
 */
describeIfS3('E2E multi-device sync', () => {
	let testPrefix: string;
	let deviceA: E2EDevice;
	let deviceB: E2EDevice;

	beforeEach(async () => {
		testPrefix = generateTestPrefix('multi-device');
		deviceA = createDevice({ testPrefix, deviceId: 'device-a' });
		deviceB = createDevice({ testPrefix, deviceId: 'device-b' });

		await initDevice(deviceA);
		await initDevice(deviceB);
		await cleanupS3Prefix(deviceA.s3Provider, testPrefix);
	});

	afterEach(async () => {
		await cleanupS3Prefix(deviceA.s3Provider, testPrefix);
		await teardownDevice(deviceA);
		await teardownDevice(deviceB);
		deviceA.s3Provider.destroy();
		deviceB.s3Provider.destroy();
	});

	/**
	 * Verifies that a file uploaded by device A is downloaded unchanged by device
	 * B when both devices sync against the same real S3 prefix.
	 */
	it('uploads from device A and downloads onto device B', async () => {
		const path = 'Notes/shared.md';
		const content = '# Shared note\n\nCreated on device A.';

		deviceA.vault.seed(path, content);

		const resultA = await deviceA.syncEngine.sync();
		const resultB = await deviceB.syncEngine.sync();

		expectSuccessfulSync(resultA);
		expectSuccessfulSync(resultB);
		expect(resultA.filesUploaded).toBe(1);
		expect(resultB.filesDownloaded).toBe(1);
		expect(resultA.conflicts).toHaveLength(0);
		expect(resultB.conflicts).toHaveLength(0);

		expect(await readVaultText(deviceB, path)).toBe(content);
		expect(await readS3Text(deviceA, path)).toBe(content);
		expect(await deviceA.s3Provider.fileExists(deviceA.pathCodec.localToRemote(path))).toBe(true);
	});

	/**
	 * Verifies that when each device starts with a different new file, successive
	 * sync passes converge both vaults and the shared S3 state onto the same set
	 * of files.
	 */
	it('converges when both devices start with different files', async () => {
		const deviceAPath = 'Notes/from-a.md';
		const deviceAContent = 'Created on device A';
		const deviceBPath = 'Notes/from-b.md';
		const deviceBContent = 'Created on device B';

		deviceA.vault.seed(deviceAPath, deviceAContent);
		deviceB.vault.seed(deviceBPath, deviceBContent);

		const firstA = await deviceA.syncEngine.sync();
		const firstB = await deviceB.syncEngine.sync();
		const secondA = await deviceA.syncEngine.sync();

		expectSuccessfulSync(firstA);
		expectSuccessfulSync(firstB);
		expectSuccessfulSync(secondA);
		expect(firstA.filesUploaded).toBe(1);
		expect(firstB.filesUploaded).toBe(1);
		expect(firstB.filesDownloaded).toBe(1);
		expect(secondA.filesDownloaded).toBe(1);

		expect(await readVaultText(deviceA, deviceAPath)).toBe(deviceAContent);
		expect(await readVaultText(deviceA, deviceBPath)).toBe(deviceBContent);
		expect(await readVaultText(deviceB, deviceAPath)).toBe(deviceAContent);
		expect(await readVaultText(deviceB, deviceBPath)).toBe(deviceBContent);

		await expect(listSyncKeys(deviceA, testPrefix)).resolves.toEqual(
			expect.arrayContaining([
				deviceA.pathCodec.localToRemote(deviceAPath),
				deviceA.pathCodec.localToRemote(deviceBPath),
			]),
		);
	});

	/**
	 * Verifies that when device B creates a different local file at a path that
	 * device A already uploaded, the planner reports a conflict and the executor
	 * preserves both versions as LOCAL_/REMOTE_ artifacts.
	 */
	it('detects conflicts when the same path is created with different content on both devices', async () => {
		const path = 'Conflicts/note.md';
		const deviceAContent = 'Version from device A';
		const deviceBContent = 'Version from device B';

		deviceA.vault.seed(path, deviceAContent);
		const resultA = await deviceA.syncEngine.sync();

		deviceB.vault.seed(path, deviceBContent);
		const resultB = await deviceB.syncEngine.sync();

		expectSuccessfulSync(resultA);
		expectSuccessfulSync(resultB);
		expect(resultA.filesUploaded).toBe(1);
		expect(resultB.conflicts).toEqual(expect.arrayContaining([path]));
		expect(resultB.filesUploaded).toBe(0);
		expect(resultB.filesDownloaded).toBe(0);

		const localArtifactPath = 'Conflicts/LOCAL_note.md';
		const remoteArtifactPath = 'Conflicts/REMOTE_note.md';
		expect(await readVaultText(deviceB, path)).toBeNull();
		expect(await readVaultText(deviceB, localArtifactPath)).toBe(deviceBContent);
		expect(await readVaultText(deviceB, remoteArtifactPath)).toBe(deviceAContent);
		expect(await readS3Text(deviceA, path)).toBe(deviceAContent);
	});

	/**
	 * Verifies that a file downloaded from device A can be edited on device B,
	 * uploaded back to S3, and then downloaded by device A so both devices end up
	 * on the later version.
	 */
	it('converges after sequential edits across devices', async () => {
		const path = 'Notes/sequential.md';
		const initialContent = 'First version from device A';
		const updatedContent = 'Updated version from device B';

		deviceA.vault.seed(path, initialContent);

		const firstA = await deviceA.syncEngine.sync();
		const firstB = await deviceB.syncEngine.sync();

		await deviceB.vault.modify(getFileOrThrow(deviceB, path), updatedContent);

		const secondB = await deviceB.syncEngine.sync();
		const secondA = await deviceA.syncEngine.sync();

		expectSuccessfulSync(firstA);
		expectSuccessfulSync(firstB);
		expectSuccessfulSync(secondB);
		expectSuccessfulSync(secondA);
		expect(firstA.filesUploaded).toBe(1);
		expect(firstB.filesDownloaded).toBe(1);
		expect(secondB.filesUploaded).toBe(1);
		expect(secondA.filesDownloaded).toBe(1);

		expect(await readVaultText(deviceA, path)).toBe(updatedContent);
		expect(await readVaultText(deviceB, path)).toBe(updatedContent);
		expect(await readS3Text(deviceA, path)).toBe(updatedContent);
	});

	/**
	 * Verifies that a deletion performed on device A propagates through S3 and is
	 * applied on device B during a later sync, removing the file from both the
	 * remote prefix and the second device's vault.
	 */
	it('propagates deletions from device A to device B', async () => {
		const path = 'Notes/delete-me.md';
		const content = 'This file will be deleted';
		const seededFile = deviceA.vault.seed(path, content);
		const remoteKey = deviceA.pathCodec.localToRemote(path);

		const firstA = await deviceA.syncEngine.sync();
		const firstB = await deviceB.syncEngine.sync();

		await deviceA.vault.delete(seededFile);

		const secondA = await deviceA.syncEngine.sync();
		const secondB = await deviceB.syncEngine.sync();

		expectSuccessfulSync(firstA);
		expectSuccessfulSync(firstB);
		expectSuccessfulSync(secondA);
		expectSuccessfulSync(secondB);
		expect(firstA.filesUploaded).toBe(1);
		expect(firstB.filesDownloaded).toBe(1);
		expect(secondA.filesDeleted).toBe(1);
		expect(secondB.filesDeleted).toBe(1);

		expect(await readVaultText(deviceA, path)).toBeNull();
		expect(await readVaultText(deviceB, path)).toBeNull();
		expect(await deviceA.s3Provider.fileExists(remoteKey)).toBe(false);
	});
});
