/**
 * End-to-end tests for backup snapshot and retention workflows.
 *
 * These tests exercise the real `SnapshotCreator` and `RetentionManager`
 * modules against a live S3 bucket using the E2E harness' in-memory vault.
 */

import { BackupManifest } from '../../src/types';
import { deriveKey } from '../../src/crypto/KeyDerivation';
import {
	cleanupS3Prefix,
	createDevice,
	generateTestPrefix,
	hasS3Credentials,
	initDevice,
	teardownDevice,
	type CreateDeviceOptions,
	type E2EDevice,
} from './helpers/e2e-harness';

const describeIfS3 = hasS3Credentials() ? describe : describe.skip;

/**
 * Create isolated E2E devices and clean up every generated S3 prefix.
 */
describeIfS3('Backup workflow E2E', () => {
	let activeDevices: E2EDevice[] = [];
	let cleanupTargets: Array<{ device: E2EDevice; prefixes: string[] }> = [];

	/**
	 * Create a fully initialized device with a unique S3 prefix for one scenario.
	 */
	async function createInitializedDevice(
		overrides: Omit<CreateDeviceOptions, 'testPrefix'> = {},
	): Promise<E2EDevice> {
		const testPrefix = generateTestPrefix('backup-workflow');
		const device = createDevice({
			testPrefix,
			...overrides,
		});

		await initDevice(device);
		activeDevices.push(device);
		cleanupTargets.push({
			device,
			prefixes: [testPrefix, `${testPrefix}-backups`],
		});

		return device;
	}

	/**
	 * Build a full S3 key inside a specific backup folder.
	 */
	function getBackupObjectKey(device: E2EDevice, backupName: string, relativePath: string): string {
		return `${device.settings.backupPrefix}/${backupName}/${relativePath}`;
	}

	/**
	 * List all S3 objects stored under the configured backup prefix.
	 */
	async function listBackupObjects(device: E2EDevice): Promise<string[]> {
		const objects = await device.s3Provider.listObjects(`${device.settings.backupPrefix}/`, true);
		return objects.map((object) => object.key);
	}

	/**
	 * Download and parse a backup manifest from S3.
	 */
	async function readManifest(device: E2EDevice, backupName: string): Promise<BackupManifest> {
		const manifestKey = getBackupObjectKey(device, backupName, '.backup-manifest.json');
		const manifestJson = await device.s3Provider.downloadFileAsText(manifestKey);
		return JSON.parse(manifestJson) as BackupManifest;
	}

	/**
	 * Wait long enough to guarantee a distinct timestamp-based backup name.
	 */
	async function waitForNextBackupSecond(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 1100));
	}

	afterEach(async () => {
		for (const device of activeDevices) {
			await teardownDevice(device);
		}
		activeDevices = [];
	});

	afterAll(async () => {
		for (const target of cleanupTargets) {
			for (const prefix of target.prefixes) {
				await cleanupS3Prefix(target.device.s3Provider, prefix);
			}
			target.device.s3Provider.destroy();
		}
		cleanupTargets = [];
	});

	/**
	 * Verifies snapshot creation, manifest generation, content upload, exclusions,
	 * and encryption against real S3 storage.
	 */
	describe('SnapshotCreator workflows', () => {
		it('creates a backup snapshot and reports the expected backed-up file count', async () => {
			const device = await createInitializedDevice();
			device.vault.seed('notes/daily.md', '# Daily note');
			device.vault.seed('attachments/image.png', new Uint8Array([1, 2, 3, 4]));
			device.vault.seed('projects/plan.md', '- ship feature');

			const result = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');

			expect(result.success).toBe(true);
			expect(result.errors).toHaveLength(0);
			expect(result.filesBackedUp).toBe(3);
			expect(result.backupName).toMatch(/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
		});

		it('writes a backup manifest with file counts, checksum entries, and plaintext metadata', async () => {
			const device = await createInitializedDevice();
			device.vault.seed('notes/manifest.md', 'manifest test');
			device.vault.seed('assets/logo.txt', 'logo-bytes');

			const result = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');
			const backupObjects = await listBackupObjects(device);
			const manifestKey = backupObjects.find((key) => key.endsWith(`${result.backupName}/.backup-manifest.json`));

			expect(result.success).toBe(true);
			expect(manifestKey).toBeDefined();

			const manifest = await readManifest(device, result.backupName);

			expect(manifest.fileCount).toBe(2);
			expect(manifest.encrypted).toBe(false);
			expect(Object.keys(manifest.checksums).sort()).toEqual([
				'assets/logo.txt',
				'notes/manifest.md',
			]);
			expect(Object.values(manifest.checksums).every((checksum) => checksum.startsWith('sha256:'))).toBe(true);
		});

		it('uploads backup file bytes that match the original plaintext content', async () => {
			const device = await createInitializedDevice();
			const content = 'Known backup content for round-trip verification.';
			device.vault.seed('notes/known-content.md', content);

			const result = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');
			const key = getBackupObjectKey(device, result.backupName, 'notes/known-content.md');
			const downloaded = await device.s3Provider.downloadFileAsText(key);

			expect(result.success).toBe(true);
			expect(downloaded).toBe(content);
		});

		it('skips files matching configured exclude patterns while still backing up allowed files', async () => {
			const device = await createInitializedDevice({
				settingsOverrides: {
					excludePatterns: ['*.tmp'],
				},
			});
			device.vault.seed('notes.md', '# Included');
			device.vault.seed('data.tmp', 'temporary file');

			const result = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');
			const backupObjects = await listBackupObjects(device);

			expect(result.success).toBe(true);
			expect(result.filesBackedUp).toBe(1);
			expect(backupObjects).toContain(getBackupObjectKey(device, result.backupName, 'notes.md'));
			expect(backupObjects).not.toContain(getBackupObjectKey(device, result.backupName, 'data.tmp'));
		});

		it('encrypts backed-up file bytes and marks the manifest as encrypted when an encryption key is configured', async () => {
			const encryptionKey = await deriveKey('correct horse battery staple', new Uint8Array(32).fill(7));
			const device = await createInitializedDevice({
				encryptionKey,
				settingsOverrides: {
					encryptionEnabled: true,
				},
			});
			const secretContent = 'Highly sensitive backup payload';
			device.vault.seed('private/secret.md', secretContent);

			const result = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');
			const encryptedBytes = await device.s3Provider.downloadFile(
				getBackupObjectKey(device, result.backupName, 'private/secret.md'),
			);
			const manifest = await readManifest(device, result.backupName);
			const plaintextBytes = new TextEncoder().encode(secretContent);

			expect(result.success).toBe(true);
			expect(manifest.encrypted).toBe(true);
			expect(encryptedBytes).not.toEqual(plaintextBytes);
			expect(encryptedBytes.length).toBeGreaterThan(plaintextBytes.length);
			expect(new TextDecoder().decode(encryptedBytes)).not.toContain(secretContent);
		});

		it('excludes the plugin settings directory from backups even when the file exists in the vault', async () => {
			const device = await createInitializedDevice();
			device.vault.seed('.obsidian/plugins/s3-sync-and-backup/data.json', '{"token":"secret"}');
			device.vault.seed('notes/keep.md', 'safe content');

			const result = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');
			const backupObjects = await listBackupObjects(device);
			const manifest = await readManifest(device, result.backupName);

			expect(result.success).toBe(true);
			expect(result.filesBackedUp).toBe(1);
			expect(backupObjects).toContain(getBackupObjectKey(device, result.backupName, 'notes/keep.md'));
			expect(backupObjects).not.toContain(
				getBackupObjectKey(device, result.backupName, '.obsidian/plugins/s3-sync-and-backup/data.json'),
			);
			expect(manifest.checksums).not.toHaveProperty('.obsidian/plugins/s3-sync-and-backup/data.json');
		});
	});

	/**
	 * Verifies retention cleanup deletes older backup folders after multiple real
	 * snapshots have been written to S3.
	 */
	describe('RetentionManager workflows', () => {
		it('deletes older backups when copy-based retention is enabled and only two copies should remain', async () => {
			const device = await createInitializedDevice();
			device.vault.seed('notes/retention.md', 'retain me');

			const first = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');
			await waitForNextBackupSecond();
			const second = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');
			await waitForNextBackupSecond();
			const third = await device.snapshotCreator.createSnapshot(device.deviceId, 'E2EDevice');

			const updatedSettings = {
				...device.settings,
				retentionEnabled: true,
				retentionMode: 'copies' as const,
				retentionCopies: 2,
			};
			device.retentionManager.updateSettings(updatedSettings);

			const deletedBackups = await device.retentionManager.applyRetentionPolicy();
			const remainingBackups = await device.retentionManager.listBackups();

			expect(new Set([first.backupName, second.backupName, third.backupName]).size).toBe(3);
			expect(deletedBackups).toBe(1);
			expect(remainingBackups).toHaveLength(2);
			expect(remainingBackups.map((backup) => backup.name).sort()).toEqual([
				second.backupName,
				third.backupName,
			].sort());
		});
	});
});
