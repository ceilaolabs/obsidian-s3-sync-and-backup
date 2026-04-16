jest.mock('obsidian');

jest.mock('../../src/sync/SyncEngine', () => ({
	SyncEngine: jest.fn(),
}));

import { Plugin } from 'obsidian';
import { SyncScheduler } from '../../src/sync/SyncScheduler';
import { SyncEngine } from '../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS, S3SyncBackupSettings, SyncResult } from '../../src/types';
import type { EncryptionCoordinator } from '../../src/crypto/EncryptionCoordinator';

interface MockPlugin {
	registerInterval: jest.Mock<number, [number]>;
}

interface MockSyncEngine {
	isInProgress: jest.Mock<boolean, []>;
	sync: jest.Mock<Promise<SyncResult>, []>;
}

interface MockEncryptionCoordinator {
	shouldBlock: jest.Mock<boolean, []>;
	getBlockReason: jest.Mock<string, []>;
}

interface SchedulerContext {
	plugin: Plugin;
	pluginMocks: MockPlugin;
	syncEngine: SyncEngine;
	syncEngineMocks: MockSyncEngine;
	encryptionCoordinator: EncryptionCoordinator;
	encryptionCoordinatorMocks: MockEncryptionCoordinator;
	scheduler: SyncScheduler;
	settings: S3SyncBackupSettings;
}

function createSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		...DEFAULT_SETTINGS,
		...overrides,
	};
}

function createSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		success: true,
		startedAt: 100,
		completedAt: 200,
		filesUploaded: 1,
		filesDownloaded: 0,
		filesDeleted: 0,
		filesAdopted: 0,
		filesForgotten: 0,
		conflicts: [],
		errors: [],
		...overrides,
	};
}

function createSchedulerContext(overrides: Partial<S3SyncBackupSettings> = {}): SchedulerContext {
	const settings = createSettings(overrides);
	const pluginMocks: MockPlugin = {
		registerInterval: jest.fn((id: number) => id),
	};
	const syncEngineMocks: MockSyncEngine = {
		isInProgress: jest.fn().mockReturnValue(false),
		sync: jest.fn().mockResolvedValue(createSyncResult()),
	};
	const encryptionCoordinatorMocks: MockEncryptionCoordinator = {
		shouldBlock: jest.fn().mockReturnValue(false),
		getBlockReason: jest.fn().mockReturnValue('Encryption transition in progress'),
	};

	const plugin = pluginMocks as unknown as Plugin;
	const syncEngine = syncEngineMocks as unknown as SyncEngine;
	const encryptionCoordinator = encryptionCoordinatorMocks as unknown as EncryptionCoordinator;
	const scheduler = new SyncScheduler(plugin, syncEngine, settings);

	return {
		plugin,
		pluginMocks,
		syncEngine,
		syncEngineMocks,
		encryptionCoordinator,
		encryptionCoordinatorMocks,
		scheduler,
		settings,
	};
}

/**
 * Covers SyncScheduler public lifecycle, interval, and callback orchestration.
 */
describe('SyncScheduler', () => {
	let setIntervalSpy: jest.SpiedFunction<typeof globalThis.setInterval>;
	let clearIntervalSpy: jest.SpiedFunction<typeof globalThis.clearInterval>;
	let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		jest.clearAllMocks();
		Object.defineProperty(globalThis, 'window', {
			value: globalThis,
			configurable: true,
			writable: true,
		});
		setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
		clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		setIntervalSpy.mockRestore();
		clearIntervalSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		jest.useRealTimers();
	});

	/**
	 * Verifies scheduler start and stop behavior around enablement guards and intervals.
	 */
	describe('start and stop', () => {
		it('does not start when syncEnabled is false', () => {
			const { scheduler, pluginMocks } = createSchedulerContext({ syncEnabled: false });

			scheduler.start();

			expect(pluginMocks.registerInterval).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();
			expect(scheduler.getNextSyncTime()).toBeNull();
		});

		it('does not start when autoSyncEnabled is false', () => {
			const { scheduler, pluginMocks } = createSchedulerContext({ autoSyncEnabled: false });

			scheduler.start();

			expect(pluginMocks.registerInterval).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();
			expect(scheduler.getNextSyncTime()).toBeNull();
		});

		it('does not register a second interval when start is called twice', () => {
			const { scheduler, pluginMocks } = createSchedulerContext();

			scheduler.start();
			scheduler.start();

			expect(pluginMocks.registerInterval).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		});

		it('registers the interval using syncIntervalMinutes converted to milliseconds', () => {
			const { scheduler, pluginMocks } = createSchedulerContext({ syncIntervalMinutes: 10 });

			scheduler.start();
			const registeredIntervalId = setIntervalSpy.mock.results[0]?.value;

			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 600000);
			expect(pluginMocks.registerInterval).toHaveBeenCalledTimes(1);
			expect(pluginMocks.registerInterval).toHaveBeenCalledWith(registeredIntervalId as number);
		});

		it('clears the active interval and resets the scheduler state when stopped', () => {
			const { scheduler } = createSchedulerContext();

			scheduler.start();
			scheduler.pause();
			scheduler.stop();

			expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
			expect(scheduler.getIsPaused()).toBe(false);
			expect(scheduler.getNextSyncTime()).toBeNull();
		});

		it('does nothing when stop is called while the scheduler is not running', () => {
			const { scheduler } = createSchedulerContext();

			scheduler.stop();

			expect(clearIntervalSpy).not.toHaveBeenCalled();
			expect(scheduler.getNextSyncTime()).toBeNull();
		});
	});

	/**
	 * Verifies pause state and triggerSync guard behavior without asserting engine internals.
	 */
	describe('pause and trigger guards', () => {
		it('suppresses scheduled ticks while paused and resumes scheduled ticks after resume', () => {
			const { scheduler, settings } = createSchedulerContext();
			const triggerSyncSpy = jest.spyOn(scheduler, 'triggerSync').mockResolvedValue(null);

			scheduler.start();
			scheduler.pause();
			jest.advanceTimersByTime(settings.syncIntervalMinutes * 60 * 1000);
			expect(scheduler.getIsPaused()).toBe(true);
			expect(triggerSyncSpy).not.toHaveBeenCalled();

			scheduler.resume();
			jest.advanceTimersByTime(settings.syncIntervalMinutes * 60 * 1000);

			expect(scheduler.getIsPaused()).toBe(false);
			expect(triggerSyncSpy).toHaveBeenCalledTimes(1);
			expect(triggerSyncSpy).toHaveBeenCalledWith('scheduled');
		});

		it('reports the current paused state through getIsPaused', () => {
			const { scheduler } = createSchedulerContext();

			expect(scheduler.getIsPaused()).toBe(false);
			scheduler.pause();
			expect(scheduler.getIsPaused()).toBe(true);
			scheduler.resume();
			expect(scheduler.getIsPaused()).toBe(false);
		});

		it('skips triggerSync when the sync engine reports an in-progress run', async () => {
			const { scheduler, syncEngineMocks } = createSchedulerContext();
			syncEngineMocks.isInProgress.mockReturnValue(true);

			const result = await scheduler.triggerSync('manual');

			expect(result).toBeNull();
			expect(syncEngineMocks.sync).not.toHaveBeenCalled();
		});

		it('skips triggerSync when the encryption coordinator blocks sync execution', async () => {
			const { scheduler, syncEngineMocks, encryptionCoordinator, encryptionCoordinatorMocks } = createSchedulerContext();
			encryptionCoordinatorMocks.shouldBlock.mockReturnValue(true);
			scheduler.setEncryptionCoordinator(encryptionCoordinator);

			const result = await scheduler.triggerSync('scheduled');

			expect(result).toBeNull();
			expect(encryptionCoordinatorMocks.shouldBlock).toHaveBeenCalledTimes(1);
			expect(syncEngineMocks.sync).not.toHaveBeenCalled();
		});
	});

	/**
	 * Verifies callback ordering, error forwarding, and triggerSync return values.
	 */
	describe('triggerSync callbacks', () => {
		it('calls onSyncStart before syncing and onSyncComplete after a successful sync', async () => {
			const { scheduler, syncEngineMocks } = createSchedulerContext();
			const events: string[] = [];
			const result = createSyncResult({ filesUploaded: 2 });
			syncEngineMocks.sync.mockImplementation(async () => {
				events.push('sync');
				return result;
			});

			scheduler.setCallbacks({
				onSyncStart: () => {
					events.push('start');
				},
				onSyncComplete: (syncResult: SyncResult) => {
					events.push(`complete:${syncResult.filesUploaded}`);
				},
			});

			await scheduler.triggerSync('manual');

			expect(events).toEqual(['start', 'sync', 'complete:2']);
		});

		it('calls onSyncError when the sync engine throws an exception', async () => {
			const { scheduler, syncEngineMocks } = createSchedulerContext();
			const onSyncError = jest.fn<void, [string]>();
			syncEngineMocks.sync.mockRejectedValue(new Error('Sync exploded'));

			scheduler.setCallbacks({ onSyncError });

			const result = await scheduler.triggerSync('manual');

			expect(result).toBeNull();
			expect(onSyncError).toHaveBeenCalledTimes(1);
			expect(onSyncError).toHaveBeenCalledWith('Sync exploded');
		});

		it('returns the SyncResult on success and null when the sync is skipped', async () => {
			const { scheduler, syncEngineMocks } = createSchedulerContext();
			const successResult = createSyncResult({ filesDownloaded: 3 });
			syncEngineMocks.sync.mockResolvedValue(successResult);

			await expect(scheduler.triggerSync('startup')).resolves.toEqual(successResult);

			syncEngineMocks.isInProgress.mockReturnValue(true);
			await expect(scheduler.triggerSync('startup')).resolves.toBeNull();
		});
	});

	/**
	 * Verifies settings-driven restart behavior and next-sync-time reporting.
	 */
	describe('settings updates and next sync time', () => {
		it('restarts the scheduler with the updated settings when updateSettings is called while running', () => {
			const { scheduler } = createSchedulerContext({ syncIntervalMinutes: 5 });

			scheduler.start();
			scheduler.updateSettings(createSettings({ syncIntervalMinutes: 10 }));

			expect(setIntervalSpy).toHaveBeenCalledTimes(2);
			expect(setIntervalSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 300000);
			expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 600000);
			expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		});

		it('returns null when disabled or paused and returns a Date when the scheduler is running', () => {
			const { scheduler } = createSchedulerContext({ syncIntervalMinutes: 5 });

			expect(scheduler.getNextSyncTime()).toBeNull();

			scheduler.start();
			const nextSyncTime = scheduler.getNextSyncTime();

			expect(nextSyncTime).toBeInstanceOf(Date);
			expect(nextSyncTime?.toISOString()).toBe('2026-01-01T00:05:00.000Z');

			scheduler.pause();
			expect(scheduler.getNextSyncTime()).toBeNull();
		});
	});
});
