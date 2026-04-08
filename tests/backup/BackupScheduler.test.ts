/**
 * Unit tests for BackupScheduler.
 *
 * Verifies that backup timestamps only advance after a successful backup.
 */

import { BackupScheduler } from '../../src/backup/BackupScheduler';
import { BackupResult, S3SyncBackupSettings } from '../../src/types';

interface MockPluginData {
	[key: string]: unknown;
}

class MockPlugin {
	private data: MockPluginData;

	constructor(initialData: MockPluginData = {}) {
		this.data = { ...initialData };
	}

	async loadData(): Promise<MockPluginData> {
		return { ...this.data };
	}

	async saveData(data: MockPluginData): Promise<void> {
		this.data = { ...data };
	}

	registerInterval(id: number): number {
		return id;
	}

	getData(): MockPluginData {
		return { ...this.data };
	}
}

function createSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		provider: 'aws',
		endpoint: '',
		region: 'us-east-1',
		bucket: 'test-bucket',
		accessKeyId: 'test-key',
		secretAccessKey: 'test-secret',
		forcePathStyle: false,
		encryptionEnabled: false,
		syncEnabled: false,
		syncPrefix: 'vault',
		autoSyncEnabled: false,
		syncIntervalMinutes: 5,
		syncOnStartup: false,
		backupEnabled: true,
		backupPrefix: 'backups',
		backupInterval: '1hour',
		retentionEnabled: false,
		retentionMode: 'copies',
		retentionDays: 30,
		retentionCopies: 30,
		excludePatterns: [],
		debugLogging: false,
		...overrides,
	};
}

function createBackupResult(overrides: Partial<BackupResult> = {}): BackupResult {
	return {
		success: true,
		backupName: 'backup-2026-04-04T00-00-00',
		startedAt: 1000,
		completedAt: 2000,
		filesBackedUp: 3,
		totalSize: 123,
		errors: [],
		...overrides,
	};
}

describe('BackupScheduler', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-04-04T12:00:00.000Z'));
		(globalThis as typeof globalThis & { window?: Window & typeof globalThis }).window = globalThis as Window & typeof globalThis;
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('stops the scheduler and clears the interval', async () => {
		const plugin = new MockPlugin({
			'obsidian-s3-sync-last-backup': Date.now(),
		});
		const scheduler = new BackupScheduler(plugin as never, createSettings());
		const clearIntervalSpy = jest.spyOn(window, 'clearInterval');

		await scheduler.start();
		scheduler.stop();

		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		expect(scheduler.getNextBackupTime()).toBeNull();
	});

	it('returns the next backup time when enabled and last backup exists', async () => {
		const lastBackupTime = Date.now();
		const plugin = new MockPlugin({
			'obsidian-s3-sync-last-backup': lastBackupTime,
		});
		const scheduler = new BackupScheduler(plugin as never, createSettings({ backupInterval: '1hour' }));

		await scheduler.start();

		expect(scheduler.getNextBackupTime()).toEqual(new Date(lastBackupTime + 60 * 60 * 1000));
		scheduler.stop();
	});

	it('returns null when the scheduler is not enabled', () => {
		const plugin = new MockPlugin();
		const scheduler = new BackupScheduler(plugin as never, createSettings());

		expect(scheduler.getNextBackupTime()).toBeNull();
	});

	it('restarts when settings are updated while enabled', async () => {
		const plugin = new MockPlugin({
			'obsidian-s3-sync-last-backup': Date.now(),
		});
		const scheduler = new BackupScheduler(plugin as never, createSettings({ backupInterval: '1hour' }));
		const registerIntervalSpy = jest.spyOn(plugin, 'registerInterval');
		const clearIntervalSpy = jest.spyOn(window, 'clearInterval');

		await scheduler.start();
		scheduler.updateSettings(createSettings({ backupInterval: '6hours' }));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		expect(registerIntervalSpy).toHaveBeenCalledTimes(2);
		scheduler.stop();
	});

	it('does not schedule backups when disabled', async () => {
		const plugin = new MockPlugin();
		const scheduler = new BackupScheduler(plugin as never, createSettings({ backupEnabled: false }));
		const registerIntervalSpy = jest.spyOn(plugin, 'registerInterval');
		const loadDataSpy = jest.spyOn(plugin, 'loadData');

		await scheduler.start();

		expect(loadDataSpy).not.toHaveBeenCalled();
		expect(registerIntervalSpy).not.toHaveBeenCalled();
	});

	it('only starts once when start is called repeatedly', async () => {
		const plugin = new MockPlugin({
			'obsidian-s3-sync-last-backup': Date.now(),
		});
		const scheduler = new BackupScheduler(plugin as never, createSettings());
		const registerIntervalSpy = jest.spyOn(plugin, 'registerInterval');

		await scheduler.start();
		await scheduler.start();

		expect(registerIntervalSpy).toHaveBeenCalledTimes(1);
		scheduler.stop();
	});

	it('persists last backup time after a successful manual backup', async () => {
		const plugin = new MockPlugin();
		const scheduler = new BackupScheduler(plugin as never, createSettings());
		const result = createBackupResult({ completedAt: Date.now() });
		const onBackupComplete = jest.fn();

		scheduler.setCallbacks({
			onBackupTrigger: async () => result,
			onBackupComplete,
		});

		const returned = await scheduler.triggerManualBackup();

		expect(returned).toEqual(result);
		expect(scheduler.getLastBackupTime()).toBe(Date.now());
		expect(plugin.getData()['obsidian-s3-sync-last-backup']).toBe(Date.now());
		expect(onBackupComplete).toHaveBeenCalledWith(result);
	});

	it('does not persist last backup time when a manual backup returns an unsuccessful result', async () => {
		const plugin = new MockPlugin();
		const scheduler = new BackupScheduler(plugin as never, createSettings());
		const failedResult = createBackupResult({ success: false, errors: ['upload failed'] });
		const onBackupComplete = jest.fn();
		const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

		scheduler.setCallbacks({
			onBackupTrigger: async () => failedResult,
			onBackupComplete,
		});

		await expect(scheduler.triggerManualBackup()).rejects.toThrow('upload failed');

		expect(scheduler.getLastBackupTime()).toBeNull();
		expect(plugin.getData()['obsidian-s3-sync-last-backup']).toBeUndefined();
		expect(onBackupComplete).toHaveBeenCalledWith(null);
		expect(consoleErrorSpy).toHaveBeenCalled();
	});

	it('runs catch-up backup on start and only advances the saved timestamp after success', async () => {
		const plugin = new MockPlugin({
			'obsidian-s3-sync-last-backup': Date.now() - (2 * 60 * 60 * 1000),
		});
		const scheduler = new BackupScheduler(plugin as never, createSettings({ backupInterval: '1hour' }));
		const onBackupTrigger = jest.fn<Promise<BackupResult | null>, []>()
			.mockResolvedValueOnce(createBackupResult({ completedAt: Date.now() }));
		const onBackupComplete = jest.fn();

		scheduler.setCallbacks({
			onBackupTrigger,
			onBackupComplete,
		});

		await scheduler.start();

		expect(onBackupTrigger).toHaveBeenCalledTimes(1);
		expect(scheduler.getLastBackupTime()).toBe(Date.now());
		expect(plugin.getData()['obsidian-s3-sync-last-backup']).toBe(Date.now());
		expect(onBackupComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

		scheduler.stop();
	});
});
