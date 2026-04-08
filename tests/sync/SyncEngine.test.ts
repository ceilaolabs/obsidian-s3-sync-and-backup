import { App, TFile } from 'obsidian';
import { SyncEngine } from '../../src/sync/SyncEngine';
import { ChangeTracker } from '../../src/sync/ChangeTracker';
import { SyncJournal } from '../../src/sync/SyncJournal';
import {
	RemoteSyncFileEntry,
	RemoteSyncManifest,
	RemoteSyncTombstone,
	S3SyncBackupSettings,
	SyncAction,
} from '../../src/types';
import {
	LoadedRemoteSyncManifest,
	RemoteSyncManifestChangedError,
} from '../../src/sync/RemoteSyncStore';

jest.mock('../../src/crypto/Hasher', () => ({
	hashContent: jest.fn().mockResolvedValue('mock-hash'),
}));

jest.mock('../../src/utils/vaultFiles', () => ({
	readVaultFile: jest.fn().mockResolvedValue('mock-content'),
	getVaultFileKind: jest.fn().mockReturnValue('text'),
	toArrayBuffer: jest.fn().mockReturnValue(new ArrayBuffer(0)),
}));

type TestSyncExecutionOutcome = {
	path: string;
	action: SyncAction;
	clearPendingPaths: string[];
	requiresManifestCommit: boolean;
	manifestEntry?: RemoteSyncFileEntry | null;
	tombstone?: RemoteSyncTombstone | null;
	applyJournal: () => Promise<void>;
	postCommitCleanup?: () => Promise<void>;
};

function makeManifest(overrides: Partial<RemoteSyncManifest> = {}): RemoteSyncManifest {
	return {
		version: 1,
		generation: 1,
		updatedAt: Date.now(),
		updatedBy: 'device-a',
		files: {},
		tombstones: {},
		...overrides,
	};
}

function makeFileEntry(overrides: Partial<RemoteSyncFileEntry> = {}): RemoteSyncFileEntry {
	return {
		path: 'test.md',
		contentHash: 'abc123',
		size: 42,
		kind: 'text',
		updatedAt: Date.now(),
		lastModifiedBy: 'device-a',
		etag: 'etag-1',
		...overrides,
	};
}

function makeTombstone(overrides: Partial<RemoteSyncTombstone> = {}): RemoteSyncTombstone {
	return {
		path: 'test.md',
		deletedAt: Date.now(),
		deletedBy: 'device-a',
		previousHash: 'abc123',
		...overrides,
	};
}

function makeOutcome(overrides: Partial<TestSyncExecutionOutcome> = {}): TestSyncExecutionOutcome {
	return {
		path: 'test.md',
		action: 'upload',
		clearPendingPaths: ['test.md'],
		requiresManifestCommit: true,
		applyJournal: jest.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function createSettings(): S3SyncBackupSettings {
	return {
		provider: 'aws',
		endpoint: '',
		region: 'us-east-1',
		bucket: 'test-bucket',
		accessKeyId: 'access-key',
		secretAccessKey: 'secret-key',
		forcePathStyle: false,
		encryptionEnabled: false,
		syncEnabled: true,
		syncPrefix: 'vault',
		autoSyncEnabled: true,
		syncIntervalMinutes: 5,
		syncOnStartup: true,
		backupEnabled: false,
		backupPrefix: 'backups',
		backupInterval: '1day',
		retentionEnabled: false,
		retentionMode: 'copies',
		retentionDays: 30,
		retentionCopies: 30,
		excludePatterns: [],
		debugLogging: false,
	};
}

function createEngine(): SyncEngine {
	const mockApp = {
		loadLocalStorage: jest.fn().mockReturnValue('test-device-id'),
		saveLocalStorage: jest.fn(),
		vault: {
			getFiles: jest.fn().mockReturnValue([]),
		},
	} as unknown as App;

	const mockS3Provider = {
		getFileMetadata: jest.fn(),
		downloadFileAsText: jest.fn(),
		uploadFile: jest.fn(),
		listObjects: jest.fn().mockResolvedValue([]),
		deleteFile: jest.fn(),
		downloadFile: jest.fn(),
	};

	const mockJournal = {} as SyncJournal;
	const mockChangeTracker = {} as ChangeTracker;

	return new SyncEngine(
		mockApp,
		mockS3Provider as never,
		mockJournal,
		mockChangeTracker,
		createSettings()
	);
}

describe('SyncEngine rebasePendingOutcomes', () => {
	let engine: SyncEngine;

	beforeEach(() => {
		jest.clearAllMocks();
		engine = createEngine();
	});

	it('skips an upload outcome when the fresh manifest already has the same content hash', () => {
		const outcome = makeOutcome({
			manifestEntry: makeFileEntry({ contentHash: 'abc123' }),
		});
		const freshManifest = makeManifest({
			files: {
				'test.md': makeFileEntry({ contentHash: 'abc123', etag: 'etag-2' }),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], freshManifest);

		expect(rebased.pending).toEqual([]);
		expect(rebased.converged).toEqual([outcome]);
	});

	it('silently skips a stale upload outcome when the fresh manifest has a different content hash', () => {
		const outcome = makeOutcome({
			manifestEntry: makeFileEntry({ contentHash: 'abc123' }),
		});
		const freshManifest = makeManifest({
			files: {
				'test.md': makeFileEntry({ contentHash: 'xyz789' }),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], freshManifest);

		expect(rebased.pending).toEqual([]);
		expect(rebased.converged).toEqual([]);
	});

	it('keeps an upload outcome pending when the path is not present in the fresh manifest', () => {
		const outcome = makeOutcome({
			manifestEntry: makeFileEntry({ contentHash: 'abc123' }),
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], makeManifest());

		expect(rebased.pending).toEqual([outcome]);
		expect(rebased.converged).toEqual([]);
	});

	it('skips a delete outcome when the fresh manifest is already tombstoned', () => {
		const outcome = makeOutcome({
			action: 'delete-remote',
			manifestEntry: null,
			tombstone: makeTombstone(),
		});
		const freshManifest = makeManifest({
			tombstones: {
				'test.md': makeTombstone({ deletedBy: 'device-b' }),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], freshManifest);

		expect(rebased.pending).toEqual([]);
		expect(rebased.converged).toEqual([outcome]);
	});

	it('silently skips a delete outcome when the file was re-added by another device', () => {
		const outcome = makeOutcome({
			action: 'delete-remote',
			manifestEntry: null,
			tombstone: makeTombstone(),
		});
		const freshManifest = makeManifest({
			files: {
				'test.md': makeFileEntry({ contentHash: 'xyz789' }),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], freshManifest);

		expect(rebased.pending).toEqual([]);
		expect(rebased.converged).toEqual([]);
	});

	it('keeps a delete outcome pending when the path is absent from both files and tombstones', () => {
		const outcome = makeOutcome({
			action: 'delete-remote',
			manifestEntry: null,
			tombstone: makeTombstone(),
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], makeManifest());

		expect(rebased.pending).toEqual([outcome]);
		expect(rebased.converged).toEqual([]);
	});

	it('rebases mixed outcomes by dropping converged and stale work while keeping pending work', () => {
		const converged = makeOutcome({
			path: 'same.md',
			manifestEntry: makeFileEntry({ path: 'same.md', contentHash: 'same-hash' }),
			clearPendingPaths: ['same.md'],
		});
		const stale = makeOutcome({
			path: 'stale.md',
			manifestEntry: makeFileEntry({ path: 'stale.md', contentHash: 'old-hash' }),
			clearPendingPaths: ['stale.md'],
		});
		const pending = makeOutcome({
			path: 'pending.md',
			manifestEntry: makeFileEntry({ path: 'pending.md', contentHash: 'pending-hash' }),
			clearPendingPaths: ['pending.md'],
		});
		const freshManifest = makeManifest({
			files: {
				'same.md': makeFileEntry({ path: 'same.md', contentHash: 'same-hash' }),
				'stale.md': makeFileEntry({ path: 'stale.md', contentHash: 'new-hash' }),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([converged, stale, pending], freshManifest);

		expect(rebased.pending).toEqual([pending]);
		expect(rebased.converged).toEqual([converged]);
	});

	it('skips a tombstone-only outcome when the tombstone is already present', () => {
		const outcome = makeOutcome({
			manifestEntry: undefined,
			tombstone: makeTombstone(),
		});
		const freshManifest = makeManifest({
			tombstones: {
				'test.md': makeTombstone({ deletedBy: 'device-b' }),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], freshManifest);

		expect(rebased.pending).toEqual([]);
		expect(rebased.converged).toEqual([outcome]);
	});

	it('keeps a tombstone-clearing outcome applicable when the fresh manifest still has the tombstone', () => {
		const outcome = makeOutcome({
			manifestEntry: undefined,
			tombstone: null,
		});
		const freshManifest = makeManifest({
			tombstones: {
				'test.md': makeTombstone(),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], freshManifest);

		expect(rebased.pending).toEqual([outcome]);
		expect(rebased.converged).toEqual([]);
	});

	it('passes through an outcome with no manifest or tombstone mutation', () => {
		const outcome = makeOutcome({
			manifestEntry: undefined,
			tombstone: undefined,
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], makeManifest());

		expect(rebased.pending).toEqual([outcome]);
		expect(rebased.converged).toEqual([]);
	});

	it('keeps a tombstone-only outcome applicable when the fresh manifest does not have the tombstone yet', () => {
		const outcome = makeOutcome({
			manifestEntry: undefined,
			tombstone: makeTombstone(),
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], makeManifest());

		expect(rebased.pending).toEqual([outcome]);
		expect(rebased.converged).toEqual([]);
	});

	it('silently skips a delete outcome when the fresh manifest has both a file entry and a tombstone', () => {
		const outcome = makeOutcome({
			action: 'delete-remote',
			manifestEntry: null,
			tombstone: makeTombstone(),
		});
		const freshManifest = makeManifest({
			files: {
				'test.md': makeFileEntry({ contentHash: 'xyz789' }),
			},
			tombstones: {
				'test.md': makeTombstone({ deletedBy: 'device-b' }),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], freshManifest);

		expect(rebased.pending).toEqual([]);
		expect(rebased.converged).toEqual([]);
	});

	it('uses content hashes instead of etags when deciding whether an upload already converged', () => {
		const outcome = makeOutcome({
			manifestEntry: makeFileEntry({ contentHash: 'same-hash', etag: 'etag-local' }),
		});
		const freshManifest = makeManifest({
			files: {
				'test.md': makeFileEntry({ contentHash: 'same-hash', etag: 'etag-remote' }),
			},
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], freshManifest);

		expect(rebased.pending).toEqual([]);
		expect(rebased.converged).toEqual([outcome]);
	});
});

describe('SyncEngine commitManifestChanges', () => {
	let engine: SyncEngine;

	beforeEach(() => {
		jest.clearAllMocks();
		engine = createEngine();
	});

	/**
	 * Regression test for bugs M1/M2.
	 *
	 * When saveManifest fails with RemoteSyncManifestChangedError on the first
	 * attempt, the engine must reload the manifest and rebase outstanding
	 * outcomes.  Outcomes whose content hash already matches the freshly-loaded
	 * manifest (i.e. another device committed the same change) must be returned
	 * in `convergedOutcomes` so the caller can still apply their journal entries.
	 * Outcomes not yet present in the fresh manifest must be committed and
	 * returned in `committedPaths`.
	 */
	it('returns converged outcomes separately from committed paths (M1/M2 fix)', async () => {
		// Arrange ----------------------------------------------------------------

		const sameOutcome = makeOutcome({
			path: 'same.md',
			action: 'upload',
			clearPendingPaths: ['same.md'],
			requiresManifestCommit: true,
			manifestEntry: makeFileEntry({ path: 'same.md', contentHash: 'hash-a' }),
		});

		const newOutcome = makeOutcome({
			path: 'new.md',
			action: 'upload',
			clearPendingPaths: ['new.md'],
			requiresManifestCommit: true,
			manifestEntry: makeFileEntry({ path: 'new.md', contentHash: 'hash-b' }),
		});

		// The first saveManifest call races with another device and fails.
		// The second call (after rebase) succeeds.
		const mockSaveManifest = jest.fn()
			.mockRejectedValueOnce(new RemoteSyncManifestChangedError())
			.mockResolvedValue('etag-new');

		// The fresh manifest that is loaded after the first failure already
		// contains same.md with the matching content hash — i.e. another device
		// committed the identical change.
		const freshManifest: RemoteSyncManifest = makeManifest({
			files: {
				'same.md': makeFileEntry({ path: 'same.md', contentHash: 'hash-a' }),
			},
		});

		const mockLoadManifest = jest.fn().mockResolvedValue({
			manifest: freshManifest,
			etag: 'etag-fresh',
			existed: true,
		} as LoadedRemoteSyncManifest);

		// Wire the mocks onto the engine's private remoteStore
		(engine as any).remoteStore.saveManifest = mockSaveManifest;
		(engine as any).remoteStore.loadManifest = mockLoadManifest;
		// touchRemoteDevice delegates to remoteStore.touchDevice
		(engine as any).remoteStore.touchDevice = jest.fn().mockResolvedValue(undefined);

		// The initial loaded manifest (before the first save attempt)
		const initialLoadedManifest: LoadedRemoteSyncManifest = {
			manifest: makeManifest(),
			etag: 'etag-old',
			existed: true,
		};

		const errors: never[] = [];

		// Act --------------------------------------------------------------------
		const result = await (engine as any).commitManifestChanges(
			initialLoadedManifest,
			[sameOutcome, newOutcome],
			errors,
		);

		// Assert -----------------------------------------------------------------

		// new.md was pending after rebase and successfully committed
		expect(result.committedPaths.has('new.md')).toBe(true);

		// same.md converged with the remote device and must NOT appear in
		// committedPaths (it was never re-saved)
		expect(result.committedPaths.has('same.md')).toBe(false);

		// same.md must be returned in convergedOutcomes so the caller can
		// apply its journal entry
		expect(result.convergedOutcomes).toContain(sameOutcome);

		// new.md was committed, not converged
		expect(result.convergedOutcomes).not.toContain(newOutcome);
	});
});

describe('SyncEngine buildFileStateMap', () => {
	let engine: SyncEngine;

	beforeEach(() => {
		jest.clearAllMocks();
		engine = createEngine();
	});

	/**
	 * Regression test for bug E4.
	 *
	 * buildFileStateMap must call changeTracker.markPathSyncing for every local
	 * file path in one synchronous pass BEFORE any await.  This prevents vault
	 * events emitted during the async state-build phase from racing with the
	 * path locks and causing stale change entries to survive the sync cycle.
	 */
	it('pre-locks all local file paths via markPathSyncing (E4 fix)', async () => {
		// Arrange ----------------------------------------------------------------

		// Build a small set of mock local files
		const mockFileA = { path: 'a.md', stat: { mtime: Date.now(), size: 10 } } as TFile;
		const mockFileB = { path: 'b.md', stat: { mtime: Date.now(), size: 20 } } as TFile;
		const mockFileC = { path: 'notes/c.md', stat: { mtime: Date.now(), size: 30 } } as TFile;

		// Override vault.getFiles to return our mock files
		(engine as any).app.vault.getFiles = jest.fn().mockReturnValue([
			mockFileA,
			mockFileB,
			mockFileC,
		]);

		// Spy on changeTracker.markPathSyncing
		const markPathSyncing = jest.fn();
		(engine as any).changeTracker.markPathSyncing = markPathSyncing;

		// Stub the remaining dependencies consumed inside buildFileStateMap

		// s3Provider.listObjects — no remote objects so we avoid the remote loop
		(engine as any).s3Provider.listObjects = jest.fn().mockResolvedValue([]);

		// journal.getAllEntries — no journal entries
		(engine as any).journal.getAllEntries = jest.fn().mockResolvedValue([]);

		// remoteStore.isMetadataKey — none of the (empty) keys are metadata
		(engine as any).remoteStore.isMetadataKey = jest.fn().mockReturnValue(false);

		// Act --------------------------------------------------------------------
		await (engine as any).buildFileStateMap(makeManifest());

		// Assert -----------------------------------------------------------------

		// markPathSyncing must have been called once for every local file path
		expect(markPathSyncing).toHaveBeenCalledWith('a.md');
		expect(markPathSyncing).toHaveBeenCalledWith('b.md');
		expect(markPathSyncing).toHaveBeenCalledWith('notes/c.md');
		expect(markPathSyncing).toHaveBeenCalledTimes(3);
	});
});
