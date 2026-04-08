import { App } from 'obsidian';
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

		expect(rebased).toEqual([]);
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

		expect(rebased).toEqual([]);
	});

	it('keeps an upload outcome pending when the path is not present in the fresh manifest', () => {
		const outcome = makeOutcome({
			manifestEntry: makeFileEntry({ contentHash: 'abc123' }),
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], makeManifest());

		expect(rebased).toEqual([outcome]);
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

		expect(rebased).toEqual([]);
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

		expect(rebased).toEqual([]);
	});

	it('keeps a delete outcome pending when the path is absent from both files and tombstones', () => {
		const outcome = makeOutcome({
			action: 'delete-remote',
			manifestEntry: null,
			tombstone: makeTombstone(),
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], makeManifest());

		expect(rebased).toEqual([outcome]);
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

		expect(rebased).toEqual([pending]);
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

		expect(rebased).toEqual([]);
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

		expect(rebased).toEqual([outcome]);
	});

	it('passes through an outcome with no manifest or tombstone mutation', () => {
		const outcome = makeOutcome({
			manifestEntry: undefined,
			tombstone: undefined,
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], makeManifest());

		expect(rebased).toEqual([outcome]);
	});

	it('keeps a tombstone-only outcome applicable when the fresh manifest does not have the tombstone yet', () => {
		const outcome = makeOutcome({
			manifestEntry: undefined,
			tombstone: makeTombstone(),
		});

		const rebased = (engine as any).rebasePendingOutcomes([outcome], makeManifest());

		expect(rebased).toEqual([outcome]);
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

		expect(rebased).toEqual([]);
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

		expect(rebased).toEqual([]);
	});
});
