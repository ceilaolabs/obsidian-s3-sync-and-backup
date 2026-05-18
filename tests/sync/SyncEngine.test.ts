jest.mock('obsidian');

jest.mock('../../src/storage/S3Provider', () => ({
	S3Provider: jest.fn(),
}));

jest.mock('../../src/sync/SyncJournal', () => ({
	SyncJournal: jest.fn(),
}));

jest.mock('../../src/sync/SyncPathCodec', () => ({
	SyncPathCodec: jest.fn(),
}));

jest.mock('../../src/sync/SyncPayloadCodec', () => ({
	SyncPayloadCodec: jest.fn(),
}));

jest.mock('../../src/sync/ChangeTracker', () => ({
	ChangeTracker: jest.fn(),
}));

jest.mock('../../src/sync/SyncPlanner', () => ({
	SyncPlanner: jest.fn(),
}));

jest.mock('../../src/sync/SyncExecutor', () => ({
	SyncExecutor: jest.fn(),
}));

import { App } from 'obsidian';
import { S3Provider } from '../../src/storage/S3Provider';
import { ChangeTracker } from '../../src/sync/ChangeTracker';
import { SyncEngine } from '../../src/sync/SyncEngine';
import { SyncExecutor } from '../../src/sync/SyncExecutor';
import { SyncJournal } from '../../src/sync/SyncJournal';
import { SyncPathCodec } from '../../src/sync/SyncPathCodec';
import { SyncPayloadCodec } from '../../src/sync/SyncPayloadCodec';
import { SyncPlanner } from '../../src/sync/SyncPlanner';
import { DEFAULT_SETTINGS, S3SyncBackupSettings, SyncPlanItem, SyncResult } from '../../src/types';

interface MockPlanner {
	buildPlan: jest.Mock<Promise<SyncPlanItem[]>, []>;
}

interface MockExecutor {
	execute: jest.Mock<Promise<SyncResult>, [SyncPlanItem[]]>;
}

interface MockJournal {
	setMetadata: jest.Mock<Promise<void>, [string, number | string]>;
	getMetadata: jest.Mock<Promise<string | number | undefined>, [string]>;
	clear: jest.Mock<Promise<void>, []>;
}

interface MockChangeTracker {
	setSyncInProgress: jest.Mock<void, [boolean]>;
}

interface MockPathCodec {
	updatePrefix: jest.Mock<void, [string]>;
}

interface MockPayloadCodec {
	readonly kind: 'payload-codec';
}

interface MockS3Provider {
	readonly kind: 's3-provider';
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

interface EngineContext {
	app: App;
	s3Provider: MockS3Provider;
	journal: MockJournal;
	pathCodec: MockPathCodec;
	payloadCodec: MockPayloadCodec;
	changeTracker: MockChangeTracker;
	planner: MockPlanner;
	executor: MockExecutor;
	settings: S3SyncBackupSettings;
	engine: SyncEngine;
}

const mockedSyncPlanner = jest.mocked(SyncPlanner);
const mockedSyncExecutor = jest.mocked(SyncExecutor);

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

function createSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		...DEFAULT_SETTINGS,
		...overrides,
	};
}

function createPlanItem(path: string, action: SyncPlanItem['action'] = 'skip'): SyncPlanItem {
	return {
		path,
		action,
		reason: `${action} ${path}`,
	};
}

function createSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		success: true,
		startedAt: 100,
		completedAt: 200,
		filesUploaded: 0,
		filesDownloaded: 0,
		filesDeleted: 0,
		filesAdopted: 0,
		filesForgotten: 0,
		conflicts: [],
		errors: [],
		...overrides,
	};
}

function createEngineContext(overrides: Partial<S3SyncBackupSettings> = {}): EngineContext {
	const app = new App();
	const s3Provider: MockS3Provider = { kind: 's3-provider' };
	const journal: MockJournal = {
		setMetadata: jest.fn().mockResolvedValue(undefined),
		getMetadata: jest.fn().mockResolvedValue(undefined),
		clear: jest.fn().mockResolvedValue(undefined),
	};
	const pathCodec: MockPathCodec = {
		updatePrefix: jest.fn(),
	};
	const payloadCodec: MockPayloadCodec = {
		kind: 'payload-codec',
	};
	const changeTracker: MockChangeTracker = {
		setSyncInProgress: jest.fn(),
	};
	const planner: MockPlanner = {
		buildPlan: jest.fn().mockResolvedValue([]),
	};
	const executor: MockExecutor = {
		execute: jest.fn().mockResolvedValue(createSyncResult()),
	};
	const settings = createSettings(overrides);

	mockedSyncPlanner.mockImplementation(() => planner as unknown as SyncPlanner);
	mockedSyncExecutor.mockImplementation(() => executor as unknown as SyncExecutor);

	const engine = new SyncEngine(
		app,
		s3Provider as unknown as S3Provider,
		journal as unknown as SyncJournal,
		pathCodec as unknown as SyncPathCodec,
		payloadCodec as unknown as SyncPayloadCodec,
		changeTracker as unknown as ChangeTracker,
		settings,
		'device-123',
	);

	return {
		app,
		s3Provider,
		journal,
		pathCodec,
		payloadCodec,
		changeTracker,
		planner,
		executor,
		settings,
		engine,
	};
}

/**
 * Covers SyncEngine's top-level orchestration responsibilities:
 * mutex behavior, lifecycle flags, planner/executor wiring, metadata persistence,
 * runtime settings propagation, wrapped errors, and debug logging.
 */
describe('SyncEngine', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	/**
	 * Covers SyncEngine's mutex and in-progress lifecycle behavior around sync entry,
	 * exit, and finally-block cleanup.
	 */
	describe('sync lifecycle', () => {
		it('throws when sync is called while another sync is already in progress', async () => {
			const context = createEngineContext();
			const plannerDeferred = createDeferred<SyncPlanItem[]>();
			context.planner.buildPlan.mockReturnValueOnce(plannerDeferred.promise);

			const activeSync = context.engine.sync();

			expect(context.engine.isInProgress()).toBe(true);
			await expect(context.engine.sync()).rejects.toThrow('Sync already in progress');

			plannerDeferred.resolve([]);
			await activeSync;
		});

		it('resets isSyncing to false after a successful sync completes', async () => {
			const context = createEngineContext();

			expect(context.engine.isInProgress()).toBe(false);
			await context.engine.sync();
			expect(context.engine.isInProgress()).toBe(false);
		});

		it('resets isSyncing to false after a failed sync when the planner throws', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockRejectedValueOnce(new Error('planner exploded'));

			const result = await context.engine.sync();

			expect(result.success).toBe(false);
			expect(context.engine.isInProgress()).toBe(false);
		});

		it('returns true from isInProgress during sync and false before and after completion', async () => {
			const context = createEngineContext();
			const executeDeferred = createDeferred<SyncResult>();
			context.executor.execute.mockReturnValueOnce(executeDeferred.promise);

			expect(context.engine.isInProgress()).toBe(false);
			const syncPromise = context.engine.sync();
			expect(context.engine.isInProgress()).toBe(true);

			executeDeferred.resolve(createSyncResult());
			await syncPromise;

			expect(context.engine.isInProgress()).toBe(false);
		});
	});

	/**
	 * Covers SyncEngine's wiring to ChangeTracker so dirty-path suppression is enabled
	 * at sync start and always released in the finally block.
	 */
	describe('ChangeTracker integration', () => {
		it('sets ChangeTracker syncInProgress to true at start and false in finally on success', async () => {
			const context = createEngineContext();
			const plannerDeferred = createDeferred<SyncPlanItem[]>();
			context.planner.buildPlan.mockReturnValueOnce(plannerDeferred.promise);

			const syncPromise = context.engine.sync();

			expect(context.changeTracker.setSyncInProgress).toHaveBeenNthCalledWith(1, true);

			plannerDeferred.resolve([]);
			await syncPromise;

			expect(context.changeTracker.setSyncInProgress).toHaveBeenNthCalledWith(2, false);
		});

		it('resets ChangeTracker syncInProgress to false when sync fails', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockRejectedValueOnce(new Error('planner exploded'));

			await context.engine.sync();

			expect(context.changeTracker.setSyncInProgress).toHaveBeenNthCalledWith(1, true);
			expect(context.changeTracker.setSyncInProgress).toHaveBeenNthCalledWith(2, false);
		});
	});

	/**
	 * Covers SyncEngine's planner-to-executor orchestration contract, ensuring it builds
	 * a plan first and then hands that exact plan to the executor.
	 */
	describe('planner and executor orchestration', () => {
		it('calls planner.buildPlan before executor.execute during a sync cycle', async () => {
			const context = createEngineContext();
			const plan = [createPlanItem('notes/one.md')];
			context.planner.buildPlan.mockResolvedValueOnce(plan);

			await context.engine.sync();

			expect(context.planner.buildPlan).toHaveBeenCalledTimes(1);
			expect(context.executor.execute).toHaveBeenCalledTimes(1);
			expect(context.planner.buildPlan.mock.invocationCallOrder[0]).toBeLessThan(
				context.executor.execute.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
			);
		});

		it('passes the planner output directly to executor.execute', async () => {
			const context = createEngineContext();
			const plan = [createPlanItem('notes/one.md', 'upload'), createPlanItem('notes/two.md', 'download')];
			context.planner.buildPlan.mockResolvedValueOnce(plan);

			await context.engine.sync();

			expect(context.executor.execute).toHaveBeenCalledWith(plan);
		});
	});

	/**
	 * Covers SyncEngine's success and failure result handling, including journal metadata
	 * persistence and conversion of unexpected top-level failures into SyncResult values.
	 */
	describe('result handling', () => {
		it('persists lastSuccessfulSyncAt metadata after a successful sync', async () => {
			const context = createEngineContext();
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(12_345);

			await context.engine.sync();

			expect(context.journal.setMetadata).toHaveBeenCalledWith('lastSuccessfulSyncAt', 12_345);
			nowSpy.mockRestore();
		});

		it('does not persist lastSuccessfulSyncAt when the executor returns a failed result', async () => {
			const context = createEngineContext();
			context.executor.execute.mockResolvedValueOnce(createSyncResult({
				success: false,
				errors: [{ path: 'notes/fail.md', action: 'upload', message: 'failed', recoverable: true }],
			}));

			await context.engine.sync();

			// Note: setMetadata may still be called to record the destination fingerprint;
			// only the lastSuccessfulSyncAt key must be skipped on failure.
			expect(context.journal.setMetadata).not.toHaveBeenCalledWith('lastSuccessfulSyncAt', expect.anything());
		});

		it('wraps an unexpected planner Error into a failed SyncResult', async () => {
			const context = createEngineContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(54_321);
			context.planner.buildPlan.mockRejectedValueOnce(new Error('planner exploded'));

			const result = await context.engine.sync();

			expect(result).toEqual({
				success: false,
				startedAt: 54_321,
				completedAt: 54_321,
				filesUploaded: 0,
				filesDownloaded: 0,
				filesDeleted: 0,
				filesAdopted: 0,
				filesForgotten: 0,
				conflicts: [],
				errors: [{ path: '', action: 'skip', message: 'planner exploded', recoverable: false }],
			});
			expect(consoleErrorSpy).toHaveBeenCalledWith('[S3 Sync] Sync failed: planner exploded');

			nowSpy.mockRestore();
			consoleErrorSpy.mockRestore();
		});

		it('wraps a non-Error throwable into a failed SyncResult with an unknown error message', async () => {
			const context = createEngineContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(98_765);
			context.planner.buildPlan.mockRejectedValueOnce('bad payload');

			const result = await context.engine.sync();

			expect(result.errors).toEqual([{ path: '', action: 'skip', message: 'Unknown error', recoverable: false }]);
			expect(result.startedAt).toBe(98_765);
			expect(result.completedAt).toBe(98_765);
			expect(consoleErrorSpy).toHaveBeenCalledWith('[S3 Sync] Sync failed: Unknown error');

			nowSpy.mockRestore();
			consoleErrorSpy.mockRestore();
		});
	});

	/**
	 * Covers SyncEngine's destination-change detection: when the sync journal was built
	 * against a different S3 destination (bucket / endpoint / region / prefix / provider),
	 * baselines from the old destination would mis-classify untouched local files as
	 * "remotely deleted" and trigger mass `delete-local` actions. The engine must detect
	 * the mismatch via a stored destination fingerprint and clear the stale baselines
	 * before planning runs.
	 */
	describe('destination fingerprint', () => {
		it('records the current destination fingerprint on the first sync', async () => {
			const context = createEngineContext({
				provider: 'aws',
				region: 'us-east-1',
				endpoint: '',
				bucket: 'my-bucket',
				syncPrefix: 'vault',
			});

			await context.engine.sync();

			const expected = JSON.stringify({
				provider: 'aws',
				region: 'us-east-1',
				endpoint: '',
				bucket: 'my-bucket',
				prefix: 'vault',
			});
			expect(context.journal.setMetadata).toHaveBeenCalledWith('destinationFingerprint', expected);
			expect(context.journal.clear).not.toHaveBeenCalled();
		});

		it('clears stale baselines and records the new fingerprint when the destination changes', async () => {
			const context = createEngineContext({ bucket: 'new-bucket', syncPrefix: 'vault' });
			const stale = JSON.stringify({
				provider: 'aws',
				region: 'us-east-1',
				endpoint: '',
				bucket: 'old-bucket',
				prefix: 'vault',
			});
			context.journal.getMetadata.mockResolvedValueOnce(stale);

			await context.engine.sync();

			expect(context.journal.clear).toHaveBeenCalledTimes(1);
			const expected = JSON.stringify({
				provider: 'aws',
				region: 'us-east-1',
				endpoint: '',
				bucket: 'new-bucket',
				prefix: 'vault',
			});
			expect(context.journal.setMetadata).toHaveBeenCalledWith('destinationFingerprint', expected);
			// Clear must happen before the planner runs so stale baselines cannot drive a destructive plan.
			expect(context.journal.clear.mock.invocationCallOrder[0]).toBeLessThan(
				context.planner.buildPlan.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
			);
		});

		it('aborts when the destination changes between the initial check and plan completion', async () => {
			// The reconcile step runs before the planner, but the planner does async S3
			// I/O during which the user could change destination-affecting settings.  A
			// post-plan re-check must catch that and refuse to execute against a plan
			// that was built against a different destination than the one we validated.
			const context = createEngineContext({ bucket: 'bucket-a' });
			const plannerDeferred = createDeferred<SyncPlanItem[]>();
			context.planner.buildPlan.mockReturnValueOnce(plannerDeferred.promise);

			const syncPromise = context.engine.sync();
			// Simulate `saveSettings` flipping the destination while the planner is awaiting S3.
			context.engine.updateSettings(createSettings({ bucket: 'bucket-b' }));
			plannerDeferred.resolve([createPlanItem('notes/a.md', 'upload')]);

			const result = await syncPromise;

			expect(context.executor.execute).not.toHaveBeenCalled();
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toMatch(/destination changed/i);
		});

		it('aborts before planning when clearing stale baselines fails', async () => {
			// If clear() throws, the destructive plan guard can't run and the journal is
			// in an uncertain state.  The engine must abort with a contextualised error
			// rather than fall through to a planner that would see stale baselines.
			const context = createEngineContext({ bucket: 'new-bucket' });
			context.journal.getMetadata.mockResolvedValueOnce(JSON.stringify({
				provider: 'aws', region: 'us-east-1', endpoint: '', bucket: 'old-bucket', prefix: 'vault',
			}));
			context.journal.clear.mockRejectedValueOnce(new Error('IDB write failure'));
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const result = await context.engine.sync();

			expect(context.planner.buildPlan).not.toHaveBeenCalled();
			expect(context.executor.execute).not.toHaveBeenCalled();
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toMatch(/clearing stale journal baselines.*IDB write failure/i);
			consoleErrorSpy.mockRestore();
		});

		it('aborts before planning when recording the new destination fingerprint fails', async () => {
			const context = createEngineContext();
			context.journal.setMetadata.mockRejectedValueOnce(new Error('IDB write failure'));
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const result = await context.engine.sync();

			expect(context.planner.buildPlan).not.toHaveBeenCalled();
			expect(context.executor.execute).not.toHaveBeenCalled();
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toMatch(/recording new destination fingerprint.*IDB write failure/i);
			consoleErrorSpy.mockRestore();
		});

		it('does not clear or rewrite the fingerprint when the destination is unchanged', async () => {
			const context = createEngineContext({ bucket: 'same-bucket', syncPrefix: 'vault' });
			const current = JSON.stringify({
				provider: 'aws',
				region: 'us-east-1',
				endpoint: '',
				bucket: 'same-bucket',
				prefix: 'vault',
			});
			context.journal.getMetadata.mockResolvedValueOnce(current);

			await context.engine.sync();

			expect(context.journal.clear).not.toHaveBeenCalled();
			expect(context.journal.setMetadata).not.toHaveBeenCalledWith('destinationFingerprint', expect.anything());
		});
	});

	/**
	 * Covers SyncEngine's plan-time safety guard: when a planner output contains an
	 * unusually high number of `delete-local` actions and the destination has no prior
	 * successful sync recorded, the engine must refuse to execute and surface a clear
	 * error.  This is the belt-and-braces backstop against future bugs that would
	 * otherwise produce a destructive plan slipping past the destination-fingerprint
	 * invalidation.
	 */
	describe('destructive plan guard', () => {
		function createDeletePlan(count: number): SyncPlanItem[] {
			return Array.from({ length: count }, (_, i) => ({
				path: `notes/file-${i}.md`,
				action: 'delete-local' as const,
				reason: 'baseline says remotely deleted',
			}));
		}

		it('blocks execution when a new destination produces many delete-local actions', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockResolvedValueOnce(createDeletePlan(50));

			const result = await context.engine.sync();

			expect(context.executor.execute).not.toHaveBeenCalled();
			expect(result.success).toBe(false);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/destructive plan/i);
			expect(result.errors[0]?.recoverable).toBe(false);
		});

		it('allows delete-local actions when the destination has a prior successful sync', async () => {
			const context = createEngineContext();
			// Stored fingerprint matches current so the planner is invoked; a prior
			// lastSuccessfulSyncAt signals this destination has been seen before, so
			// large deletions are legitimate cleanup (e.g. another device wiped files).
			context.journal.getMetadata.mockImplementation(async (key: string) => {
				if (key === 'destinationFingerprint') {
					return JSON.stringify({
						provider: 'aws',
						region: 'us-east-1',
						endpoint: '',
						bucket: '',
						prefix: 'vault',
					});
				}
				if (key === 'lastSuccessfulSyncAt') {
					return 1_700_000_000_000;
				}
				return undefined;
			});
			context.planner.buildPlan.mockResolvedValueOnce(createDeletePlan(50));

			await context.engine.sync();

			expect(context.executor.execute).toHaveBeenCalledTimes(1);
		});

		it('blocks even a single delete-local on a destination with no prior successful sync', async () => {
			// Without baselines, the decision table cannot legitimately produce any
			// delete-local action (deletion requires `L= / R0 + hasBaseline`).  So any
			// delete on a never-synced destination signals a bug and must be refused
			// regardless of how small it is.
			const context = createEngineContext();
			const plan: SyncPlanItem[] = [
				...createDeletePlan(1),
				...Array.from({ length: 99 }, (_, i) => createPlanItem(`notes/upload-${i}.md`, 'upload')),
			];
			context.planner.buildPlan.mockResolvedValueOnce(plan);

			const result = await context.engine.sync();

			expect(context.executor.execute).not.toHaveBeenCalled();
			expect(result.success).toBe(false);
			expect(result.errors[0]?.message).toMatch(/destructive plan/i);
		});

		it('does not block plans without any delete-local actions', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockResolvedValueOnce([
				createPlanItem('notes/a.md', 'upload'),
				createPlanItem('notes/b.md', 'download'),
			]);

			await context.engine.sync();

			expect(context.executor.execute).toHaveBeenCalledTimes(1);
		});

		it('does not block when the plan is empty', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockResolvedValueOnce([]);

			await context.engine.sync();

			expect(context.executor.execute).toHaveBeenCalledTimes(1);
		});

		it('returns a fully populated blocked SyncResult shape (zeroed counters, single error)', async () => {
			const context = createEngineContext();
			context.planner.buildPlan.mockResolvedValueOnce(createDeletePlan(50));

			const result = await context.engine.sync();

			expect(result).toMatchObject({
				success: false,
				filesUploaded: 0,
				filesDownloaded: 0,
				filesDeleted: 0,
				filesAdopted: 0,
				filesForgotten: 0,
				conflicts: [],
			});
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toMatchObject({
				path: '',
				action: 'delete-local',
				recoverable: false,
			});
		});
	});

	/**
	 * Covers SyncEngine's runtime configuration updates, verifying the path codec,
	 * planner settings, and executor debug flag all reflect the latest settings snapshot.
	 */
	describe('updateSettings', () => {
		it('propagates updated settings to the path codec and future planner and executor instances', async () => {
			const context = createEngineContext();
			const updatedSettings = createSettings({
				syncPrefix: 'updated-vault',
				debugLogging: true,
				excludePatterns: ['**/.cache/**'],
			});

			context.engine.updateSettings(updatedSettings);
			await context.engine.sync();

			expect(context.pathCodec.updatePrefix).toHaveBeenCalledWith('updated-vault');
			expect(mockedSyncPlanner).toHaveBeenLastCalledWith(
				context.app,
				context.s3Provider,
				context.journal,
				context.pathCodec,
				context.payloadCodec,
				updatedSettings,
			);
			expect(mockedSyncExecutor).toHaveBeenLastCalledWith(
				context.app,
				context.s3Provider,
				context.journal,
				context.pathCodec,
				context.payloadCodec,
				context.changeTracker,
				'device-123',
				true,
			);
		});
	});

	/**
	 * Covers SyncEngine's private debug logging behavior indirectly through sync(),
	 * verifying that the runtime debug flag controls console.debug output.
	 */
	describe('debug logging', () => {
		it('writes debug logs when debug logging is enabled', async () => {
			const context = createEngineContext({ debugLogging: true });
			const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

			await context.engine.sync();

			expect(debugSpy).toHaveBeenCalledWith('[S3 Sync] Starting sync');
			expect(debugSpy).toHaveBeenCalledWith('[S3 Sync] Plan contains 0 action(s)');
			expect(debugSpy).toHaveBeenCalledWith('[S3 Sync] Sync completed with 0 error(s)');

			debugSpy.mockRestore();
		});

		it('does not write debug logs when debug logging is disabled', async () => {
			const context = createEngineContext({ debugLogging: false });
			const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

			await context.engine.sync();

			expect(debugSpy).not.toHaveBeenCalled();
			debugSpy.mockRestore();
		});
	});
});
