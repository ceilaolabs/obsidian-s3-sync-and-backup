import { App, TFile, Vault } from 'obsidian';
import { SyncPlanner } from '../../src/sync/SyncPlanner';
import {
	ConflictRecord,
	DEFAULT_SETTINGS,
	LocalClassification,
	RemoteClassification,
	S3DownloadResult,
	S3HeadResult,
	S3ObjectInfo,
	S3SyncBackupSettings,
	SyncPlanItem,
	SyncStateRecord,
} from '../../src/types';
import { decide } from '../../src/sync/SyncDecisionTable';
import { readVaultFile } from '../../src/utils/vaultFiles';
import { S3Provider } from '../../src/storage/S3Provider';
import { SyncJournal } from '../../src/sync/SyncJournal';
import { SyncPathCodec } from '../../src/sync/SyncPathCodec';
import { SyncPayloadCodec } from '../../src/sync/SyncPayloadCodec';

jest.mock('../../src/storage/S3Provider', () => ({
	S3Provider: jest.fn().mockImplementation(() => ({
		listObjects: jest.fn(),
		headObject: jest.fn(),
		downloadFileWithMetadata: jest.fn(),
	})),
}));

jest.mock('../../src/sync/SyncJournal', () => ({
	SyncJournal: jest.fn().mockImplementation(() => ({
		getAllStateRecords: jest.fn(),
		getAllConflicts: jest.fn(),
	})),
}));

jest.mock('../../src/sync/SyncPathCodec', () => ({
	SyncPathCodec: jest.fn().mockImplementation(() => ({
		getListPrefix: jest.fn(),
		isMetadataKey: jest.fn(),
		remoteToLocal: jest.fn(),
		localToRemote: jest.fn(),
	})),
}));

jest.mock('../../src/sync/SyncPayloadCodec', () => ({
	SyncPayloadCodec: jest.fn().mockImplementation(() => ({
		fingerprint: jest.fn(),
		decodeAfterDownload: jest.fn(),
	})),
}));

jest.mock('../../src/sync/SyncDecisionTable', () => ({
	decide: jest.fn(),
}));

jest.mock('../../src/utils/vaultFiles', () => ({
	readVaultFile: jest.fn(),
}));

interface LocalSnapshotLike {
	file: TFile;
	mtime: number;
	size: number;
}

interface RemoteSnapshotLike {
	objectInfo: S3ObjectInfo;
	head?: S3HeadResult;
}

interface PathContextLike {
	path: string;
	local?: LocalSnapshotLike;
	remote?: RemoteSnapshotLike;
	baseline?: SyncStateRecord;
	conflict?: ConflictRecord;
	hasConflictArtifacts: boolean;
	localFingerprint?: string;
	remoteFingerprint?: string;
}

interface SyncPlannerPrivate {
	discoverState(): Promise<Map<string, PathContextLike>>;
	classifyLocal(ctx: PathContextLike): Promise<LocalClassification>;
	classifyRemote(ctx: PathContextLike): Promise<RemoteClassification>;
	sortPlan(plan: SyncPlanItem[]): SyncPlanItem[];
	shouldExclude(path: string): boolean;
	getOriginalFromConflictFilename(conflictPath: string): string | null;
}

interface MockS3Provider {
	listObjects: jest.Mock<Promise<S3ObjectInfo[]>, [string]>;
	headObject: jest.Mock<Promise<S3HeadResult | null>, [string]>;
	downloadFileWithMetadata: jest.Mock<Promise<S3DownloadResult | null>, [string]>;
}

interface MockSyncJournal {
	getAllStateRecords: jest.Mock<Promise<SyncStateRecord[]>, []>;
	getAllConflicts: jest.Mock<Promise<ConflictRecord[]>, []>;
}

interface MockSyncPathCodec {
	getListPrefix: jest.Mock<string, []>;
	isMetadataKey: jest.Mock<boolean, [string]>;
	remoteToLocal: jest.Mock<string | null, [string]>;
	localToRemote: jest.Mock<string, [string]>;
}

interface MockSyncPayloadCodec {
	fingerprint: jest.Mock<Promise<string>, [string | Uint8Array]>;
	decodeAfterDownload: jest.Mock<Uint8Array, [Uint8Array, undefined?]>;
}

interface VaultWithAddFile extends Vault {
	_addFile(path: string, content: string): TFile;
}

function createSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		...DEFAULT_SETTINGS,
		...overrides,
	};
}

function createStateRecord(overrides: Partial<SyncStateRecord> = {}): SyncStateRecord {
	return {
		path: 'note.md',
		remoteKey: 'vault/note.md',
		contentFingerprint: 'sha256:baseline',
		localMtime: 100,
		localSize: 10,
		remoteClientMtime: 100,
		remoteObjectSize: 10,
		remoteEtag: 'etag-baseline',
		remoteLastModified: 100,
		lastWriterDeviceId: 'device-1',
		lastSyncedAt: 100,
		...overrides,
	};
}

function createConflictRecord(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
	return {
		path: 'note.md',
		mode: 'both',
		localArtifactPath: 'LOCAL_note.md',
		remoteArtifactPath: 'REMOTE_note.md',
		baselineFingerprint: 'sha256:baseline',
		detectedAt: 100,
		...overrides,
	};
}

function createRemoteObject(overrides: Partial<S3ObjectInfo> = {}): S3ObjectInfo {
	return {
		key: 'vault/note.md',
		size: 10,
		lastModified: new Date('2026-01-01T00:00:00.000Z'),
		etag: 'etag-remote',
		...overrides,
	};
}

function createDownloadResult(overrides: Partial<S3DownloadResult> = {}): S3DownloadResult {
	return {
		content: new Uint8Array([1, 2, 3]),
		etag: 'etag-download',
		size: 3,
		lastModified: 100,
		...overrides,
	};
}

function createPlanItem(path: string, action: SyncPlanItem['action']): SyncPlanItem {
	return {
		path,
		action,
		reason: `${action} ${path}`,
	};
}

function getPlannerPrivate(planner: SyncPlanner): SyncPlannerPrivate {
	return planner as unknown as SyncPlannerPrivate;
}

describe('SyncPlanner', () => {
	let app: App;
	let vault: VaultWithAddFile;
	let settings: S3SyncBackupSettings;
	let s3Provider: MockS3Provider;
	let journal: MockSyncJournal;
	let pathCodec: MockSyncPathCodec;
	let payloadCodec: MockSyncPayloadCodec;
	let planner: SyncPlanner;

	const mockedDecide = jest.mocked(decide);
	const mockedReadVaultFile = jest.mocked(readVaultFile);

	function createPlanner(overrides: Partial<S3SyncBackupSettings> = {}): SyncPlanner {
		settings = createSettings(overrides);
		return new SyncPlanner(
			app,
			s3Provider as unknown as S3Provider,
			journal as unknown as SyncJournal,
			pathCodec as unknown as SyncPathCodec,
			payloadCodec as unknown as SyncPayloadCodec,
			settings,
		);
	}

	function addVaultFile(path: string, content = 'content', mtime = 100, size = content.length): TFile {
		const file = vault._addFile(path, content);
		file.stat.mtime = mtime;
		file.stat.ctime = mtime - 1;
		file.stat.size = size;
		return file;
	}

	beforeEach(() => {
		jest.clearAllMocks();

		app = new App();
		vault = new Vault() as VaultWithAddFile;
		app.vault = vault;

		s3Provider = {
			listObjects: jest.fn(),
			headObject: jest.fn(),
			downloadFileWithMetadata: jest.fn(),
		};

		journal = {
			getAllStateRecords: jest.fn(),
			getAllConflicts: jest.fn(),
		};

		pathCodec = {
			getListPrefix: jest.fn(),
			isMetadataKey: jest.fn(),
			remoteToLocal: jest.fn(),
			localToRemote: jest.fn(),
		};

		payloadCodec = {
			fingerprint: jest.fn(),
			decodeAfterDownload: jest.fn(),
		};

		s3Provider.listObjects.mockResolvedValue([]);
		s3Provider.headObject.mockResolvedValue(null);
		s3Provider.downloadFileWithMetadata.mockResolvedValue(null);
		journal.getAllStateRecords.mockResolvedValue([]);
		journal.getAllConflicts.mockResolvedValue([]);
		pathCodec.getListPrefix.mockReturnValue('vault/');
		pathCodec.isMetadataKey.mockReturnValue(false);
		pathCodec.remoteToLocal.mockImplementation((key) => key.replace(/^vault\//u, ''));
		pathCodec.localToRemote.mockImplementation((path) => `vault/${path}`);
		payloadCodec.fingerprint.mockResolvedValue('sha256:fingerprint');
		payloadCodec.decodeAfterDownload.mockImplementation((content) => content);
		mockedReadVaultFile.mockResolvedValue('local-content');
		mockedDecide.mockImplementation((input) => ({
			path: input.path,
			action: 'skip',
			reason: `skip ${input.path}`,
		}));

		planner = createPlanner();
	});

	describe('buildPlan', () => {
		it('returns an empty plan for an empty vault, empty remote, and no baselines', async () => {
			const plan = await planner.buildPlan();

			expect(plan).toEqual([]);
			expect(pathCodec.getListPrefix).toHaveBeenCalledWith();
			expect(s3Provider.listObjects).toHaveBeenCalledWith('vault/');
			expect(mockedDecide).not.toHaveBeenCalled();
		});

		it('plans an upload for a local-only file with no baseline', async () => {
			addVaultFile('local-only.md');
			mockedDecide.mockImplementation((input) => {
				expect(input.local).toBe('L+');
				expect(input.remote).toBe('R0');
				return createPlanItem(input.path, 'upload');
			});

			const plan = await planner.buildPlan();

			expect(plan).toEqual([
				expect.objectContaining({
					path: 'local-only.md',
					action: 'upload',
					expectRemoteAbsent: true,
				}),
			]);
		});

		it('plans a download for a remote-only file with no baseline', async () => {
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'vault/remote-only.md', etag: 'remote-etag' }),
			]);
			mockedDecide.mockImplementation((input) => {
				expect(input.local).toBe('L0');
				expect(input.remote).toBe('R+');
				return createPlanItem(input.path, 'download');
			});

			const plan = await planner.buildPlan();

			expect(plan).toEqual([
				expect.objectContaining({
					path: 'remote-only.md',
					action: 'download',
					expectedRemoteEtag: 'remote-etag',
				}),
			]);
		});

		it('filters skip items when local and remote both match the baseline', async () => {
			addVaultFile('stable.md', '1234567890', 500, 10);
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'vault/stable.md', size: 10, etag: '"etag-stable"' }),
			]);
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({
					path: 'stable.md',
					contentFingerprint: 'sha256:stable',
					localMtime: 500,
					localSize: 10,
					remoteObjectSize: 10,
					remoteEtag: 'etag-stable',
				}),
			]);
			mockedDecide.mockImplementation((input) => {
				expect(input.local).toBe('L=');
				expect(input.remote).toBe('R=');
				return createPlanItem(input.path, 'skip');
			});

			const plan = await planner.buildPlan();

			expect(plan).toEqual([]);
		});

		it('passes conflict state into decide and returns the decided plan item', async () => {
			addVaultFile('conflicted.md');
			journal.getAllConflicts.mockResolvedValue([
				createConflictRecord({ path: 'conflicted.md', mode: 'local-only' }),
			]);
			mockedDecide.mockImplementation((input) => {
				expect(input.hasUnresolvedConflict).toBe(true);
				return {
					path: input.path,
					action: 'conflict',
					conflictMode: 'local-only',
					reason: 'conflict from decision table',
				};
			});

			const plan = await planner.buildPlan();

			expect(plan).toEqual([
				expect.objectContaining({
					path: 'conflicted.md',
					action: 'conflict',
					conflictMode: 'local-only',
					expectRemoteAbsent: true,
				}),
			]);
		});

		it('strips quotes from remote ETags before attaching them to plan items', async () => {
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'vault/quoted.md', etag: '"abc"' }),
			]);
			mockedDecide.mockReturnValue(createPlanItem('quoted.md', 'download'));

			const plan = await planner.buildPlan();

			expect(plan).toEqual([
				expect.objectContaining({
					path: 'quoted.md',
					expectedRemoteEtag: 'abc',
				}),
			]);
		});

		it('marks plan items as expecting the remote object to be absent when no remote exists', async () => {
			addVaultFile('missing-remote.md');
			mockedDecide.mockReturnValue(createPlanItem('missing-remote.md', 'upload'));

			const plan = await planner.buildPlan();

			expect(plan).toEqual([
				expect.objectContaining({
					path: 'missing-remote.md',
					expectRemoteAbsent: true,
				}),
			]);
		});

		it('sorts non-skip actions by priority order', async () => {
			addVaultFile('upload-f.md');
			addVaultFile('delete-remote-d.md');
			addVaultFile('adopt-a.md');
			addVaultFile('conflict-g.md');
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'vault/delete-local-c.md' }),
				createRemoteObject({ key: 'vault/download-e.md' }),
				createRemoteObject({ key: 'vault/adopt-a.md' }),
			]);
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({ path: 'forget-b.md' }),
			]);
			mockedDecide.mockImplementation((input) => {
				const actions: Record<string, SyncPlanItem['action']> = {
					'adopt-a.md': 'adopt',
					'forget-b.md': 'forget',
					'delete-local-c.md': 'delete-local',
					'delete-remote-d.md': 'delete-remote',
					'download-e.md': 'download',
					'upload-f.md': 'upload',
					'conflict-g.md': 'conflict',
				};

				return createPlanItem(input.path, actions[input.path]);
			});

			const plan = await planner.buildPlan();

			expect(plan.map((item) => item.action)).toEqual([
				'adopt',
				'forget',
				'delete-local',
				'delete-remote',
				'download',
				'upload',
				'conflict',
			]);
			expect(plan.map((item) => item.path)).toEqual([
				'adopt-a.md',
				'forget-b.md',
				'delete-local-c.md',
				'delete-remote-d.md',
				'download-e.md',
				'upload-f.md',
				'conflict-g.md',
			]);
		});
	});

	describe('discoverState', () => {
		it('excludes conflict artifacts from locals, excludes metadata remotes, and attaches journal state', async () => {
			addVaultFile('dir/note.md');
			addVaultFile('dir/LOCAL_note.md');
			addVaultFile('dir/REMOTE_note.md');
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'vault/dir/note.md', etag: '"remote-etag"' }),
				createRemoteObject({ key: 'vault/.obsidian-s3-sync/engine.json' }),
			]);
			pathCodec.isMetadataKey.mockImplementation((key) => key.includes('.obsidian-s3-sync/engine.json'));
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({ path: 'dir/note.md' }),
			]);
			journal.getAllConflicts.mockResolvedValue([
				createConflictRecord({ path: 'dir/note.md' }),
			]);

			const contexts = await getPlannerPrivate(planner).discoverState();
			const context = contexts.get('dir/note.md');

			expect(context).toEqual(expect.objectContaining({
				path: 'dir/note.md',
				hasConflictArtifacts: true,
				baseline: expect.objectContaining({ path: 'dir/note.md' }),
				conflict: expect.objectContaining({ path: 'dir/note.md' }),
			}));
			expect(context?.local?.file.path).toBe('dir/note.md');
			expect(context?.remote?.objectInfo.etag).toBe('remote-etag');
			expect(contexts.has('dir/LOCAL_note.md')).toBe(false);
			expect(contexts.has('dir/REMOTE_note.md')).toBe(false);
			expect(contexts.has('.obsidian-s3-sync/engine.json')).toBe(false);
		});

		it('excludes local, remote, baseline, and conflict entries that match exclusion rules', async () => {
			planner = createPlanner();
			addVaultFile('.trash/local.md');
			addVaultFile('folder/.obsidian-s3-sync-hidden.md');
			s3Provider.listObjects.mockResolvedValue([
				createRemoteObject({ key: 'vault/.trash/remote.md' }),
				createRemoteObject({ key: 'vault/folder/.obsidian-s3-sync-remote.md' }),
			]);
			journal.getAllStateRecords.mockResolvedValue([
				createStateRecord({ path: '.trash/baseline.md' }),
			]);
			journal.getAllConflicts.mockResolvedValue([
				createConflictRecord({ path: '.trash/conflict.md' }),
			]);

			const contexts = await getPlannerPrivate(planner).discoverState();

			expect(contexts.size).toBe(0);
			expect(contexts.has('.trash/local.md')).toBe(false);
			expect(contexts.has('folder/.obsidian-s3-sync-hidden.md')).toBe(false);
			expect(contexts.has('.trash/baseline.md')).toBe(false);
			expect(contexts.has('.trash/conflict.md')).toBe(false);
		});
	});

	describe('classifyLocal', () => {
		it('returns L0 when no local file exists', async () => {
			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'missing.md',
				hasConflictArtifacts: false,
			});

			expect(result).toBe('L0');
		});

		it('returns L+ when a local file exists without a baseline', async () => {
			const file = addVaultFile('new.md');

			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'new.md',
				local: { file, mtime: file.stat.mtime, size: file.stat.size },
				hasConflictArtifacts: false,
			});

			expect(result).toBe('L+');
		});

		it('returns L= by fast path when local mtime and size match the baseline', async () => {
			const file = addVaultFile('stable.md', 'abcdefghij', 321, 10);

			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'stable.md',
				local: { file, mtime: 321, size: 10 },
				baseline: createStateRecord({ path: 'stable.md', localMtime: 321, localSize: 10 }),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('L=');
			expect(mockedReadVaultFile).not.toHaveBeenCalled();
			expect(payloadCodec.fingerprint).not.toHaveBeenCalled();
		});

		it('returns L= when local metadata changed but the fingerprint matches the baseline', async () => {
			const file = addVaultFile('same-content.md', 'hello world', 400, 11);
			mockedReadVaultFile.mockResolvedValue('hello world');
			payloadCodec.fingerprint.mockResolvedValue('sha256:same');

			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'same-content.md',
				local: { file, mtime: 401, size: 11 },
				baseline: createStateRecord({
					path: 'same-content.md',
					contentFingerprint: 'sha256:same',
					localMtime: 400,
					localSize: 11,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('L=');
			expect(mockedReadVaultFile).toHaveBeenCalledWith(vault, file);
			expect(payloadCodec.fingerprint).toHaveBeenCalledWith('hello world');
		});

		it('returns LΔ when local fingerprint differs from the baseline', async () => {
			const file = addVaultFile('changed.md', 'new content', 200, 11);
			mockedReadVaultFile.mockResolvedValue('new content');
			payloadCodec.fingerprint.mockResolvedValue('sha256:new');

			const result = await getPlannerPrivate(planner).classifyLocal({
				path: 'changed.md',
				local: { file, mtime: 200, size: 11 },
				baseline: createStateRecord({
					path: 'changed.md',
					contentFingerprint: 'sha256:old',
					localMtime: 199,
					localSize: 10,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('LΔ');
		});
	});

	describe('classifyRemote', () => {
		it('returns R0 when no remote object exists', async () => {
			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'missing.md',
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R0');
		});

		it('returns R+ when a remote object exists without a baseline', async () => {
			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'remote.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'vault/remote.md' }),
				},
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R+');
		});

		it('returns R= by fast path when the remote ETag matches the baseline', async () => {
			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'etag.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'vault/etag.md', etag: 'etag-1', size: 10 }),
				},
				baseline: createStateRecord({ path: 'etag.md', remoteEtag: 'etag-1', remoteObjectSize: 10 }),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R=');
			expect(s3Provider.headObject).not.toHaveBeenCalled();
			expect(s3Provider.downloadFileWithMetadata).not.toHaveBeenCalled();
		});

		it('returns R= when the remote size differs but the fingerprint matches the baseline', async () => {
			s3Provider.headObject.mockResolvedValue({
				etag: 'etag-2',
				size: 30,
				lastModified: 10,
				fingerprint: 'sha256:match',
			});

			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'size-match.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'vault/size-match.md', etag: 'etag-2', size: 30 }),
				},
				baseline: createStateRecord({
					path: 'size-match.md',
					contentFingerprint: 'sha256:match',
					remoteEtag: 'etag-1',
					remoteObjectSize: 10,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R=');
			expect(s3Provider.headObject).toHaveBeenCalledWith('vault/size-match.md');
		});

		it('returns RΔ when the remote size differs and the fingerprint differs from the baseline', async () => {
			s3Provider.headObject.mockResolvedValue({
				etag: 'etag-2',
				size: 30,
				lastModified: 10,
				fingerprint: 'sha256:remote',
			});

			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'size-diff.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'vault/size-diff.md', etag: 'etag-2', size: 30 }),
				},
				baseline: createStateRecord({
					path: 'size-diff.md',
					contentFingerprint: 'sha256:baseline',
					remoteEtag: 'etag-1',
					remoteObjectSize: 10,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('RΔ');
		});

		it('returns R= when the remote size matches and the fingerprint matches the baseline', async () => {
			s3Provider.headObject.mockResolvedValue({
				etag: 'etag-2',
				size: 10,
				lastModified: 10,
				fingerprint: 'sha256:match',
			});

			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'same-size-match.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'vault/same-size-match.md', etag: 'etag-2', size: 10 }),
				},
				baseline: createStateRecord({
					path: 'same-size-match.md',
					contentFingerprint: 'sha256:match',
					remoteEtag: 'etag-1',
					remoteObjectSize: 10,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R=');
		});

		it('returns RΔ when the remote size matches and the fingerprint differs from the baseline', async () => {
			s3Provider.headObject.mockResolvedValue({
				etag: 'etag-2',
				size: 10,
				lastModified: 10,
				fingerprint: 'sha256:other',
			});

			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'same-size-diff.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'vault/same-size-diff.md', etag: 'etag-2', size: 10 }),
				},
				baseline: createStateRecord({
					path: 'same-size-diff.md',
					contentFingerprint: 'sha256:baseline',
					remoteEtag: 'etag-1',
					remoteObjectSize: 10,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('RΔ');
		});

		it('falls back to download and hashing when headObject returns null', async () => {
			const downloaded = createDownloadResult({ content: new Uint8Array([7, 8, 9]) });
			const decoded = new Uint8Array([9, 8, 7]);
			s3Provider.headObject.mockResolvedValue(null);
			s3Provider.downloadFileWithMetadata.mockResolvedValue(downloaded);
			payloadCodec.decodeAfterDownload.mockReturnValue(decoded);
			payloadCodec.fingerprint.mockResolvedValue('sha256:match');

			const result = await getPlannerPrivate(planner).classifyRemote({
				path: 'fallback.md',
				remote: {
					objectInfo: createRemoteObject({ key: 'vault/fallback.md', etag: 'etag-2', size: 20 }),
				},
				baseline: createStateRecord({
					path: 'fallback.md',
					contentFingerprint: 'sha256:match',
					remoteEtag: 'etag-1',
					remoteObjectSize: 10,
				}),
				hasConflictArtifacts: false,
			});

			expect(result).toBe('R=');
			expect(s3Provider.headObject).toHaveBeenCalledWith('vault/fallback.md');
			expect(s3Provider.downloadFileWithMetadata).toHaveBeenCalledWith('vault/fallback.md');
			expect(payloadCodec.decodeAfterDownload).toHaveBeenCalledWith(downloaded.content, undefined);
			expect(payloadCodec.fingerprint).toHaveBeenCalledWith(decoded);
		});
	});

	describe('sortPlan', () => {
		it('sorts actions by planner priority order', () => {
			const plan = [
				createPlanItem('upload.md', 'upload'),
				createPlanItem('conflict.md', 'conflict'),
				createPlanItem('download.md', 'download'),
				createPlanItem('delete-remote.md', 'delete-remote'),
				createPlanItem('forget.md', 'forget'),
				createPlanItem('adopt.md', 'adopt'),
				createPlanItem('delete-local.md', 'delete-local'),
			];

			const sorted = getPlannerPrivate(planner).sortPlan(plan);

			expect(sorted.map((item) => item.action)).toEqual([
				'adopt',
				'forget',
				'delete-local',
				'delete-remote',
				'download',
				'upload',
				'conflict',
			]);
		});

		it('sorts items with the same action alphabetically by path', () => {
			const plan = [
				createPlanItem('zeta.md', 'upload'),
				createPlanItem('alpha.md', 'upload'),
				createPlanItem('middle.md', 'upload'),
			];

			const sorted = getPlannerPrivate(planner).sortPlan(plan);

			expect(sorted.map((item) => item.path)).toEqual([
				'alpha.md',
				'middle.md',
				'zeta.md',
			]);
		});
	});

	describe('shouldExclude', () => {
		it('excludes conflict artifact files', () => {
			expect(getPlannerPrivate(planner).shouldExclude('folder/LOCAL_note.md')).toBe(true);
		});

		it('excludes files whose filename starts with .obsidian-s3-sync', () => {
			expect(getPlannerPrivate(planner).shouldExclude('folder/.obsidian-s3-sync-log.json')).toBe(true);
		});

		it('excludes files that match the configured glob patterns', () => {
			expect(getPlannerPrivate(planner).shouldExclude('.trash/file.md')).toBe(true);
		});

		it('does not exclude ordinary files', () => {
			expect(getPlannerPrivate(planner).shouldExclude('notes/regular.md')).toBe(false);
		});
	});

	describe('getOriginalFromConflictFilename', () => {
		it('returns the original root path for LOCAL_ files', () => {
			expect(getPlannerPrivate(planner).getOriginalFromConflictFilename('LOCAL_foo.md')).toBe('foo.md');
		});

		it('returns the original root path for REMOTE_ files', () => {
			expect(getPlannerPrivate(planner).getOriginalFromConflictFilename('REMOTE_foo.md')).toBe('foo.md');
		});

		it('returns the original nested path for conflict artifacts in a directory', () => {
			expect(getPlannerPrivate(planner).getOriginalFromConflictFilename('dir/LOCAL_foo.md')).toBe('dir/foo.md');
		});

		it('returns null for non-conflict filenames', () => {
			expect(getPlannerPrivate(planner).getOriginalFromConflictFilename('dir/foo.md')).toBeNull();
		});
	});
});
