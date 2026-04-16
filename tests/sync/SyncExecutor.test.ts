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

jest.mock('../../src/sync/SyncObjectMetadata', () => ({
	encodeMetadata: jest.fn(),
}));

jest.mock('../../src/utils/vaultFiles', () => ({
	getVaultFileKind: jest.fn(),
	readVaultFile: jest.fn(),
	toArrayBuffer: jest.fn(),
}));

jest.mock('../../src/utils/retry', () => ({
	sleep: jest.fn().mockResolvedValue(undefined),
}));

import { App, FileStats, TFile, TFolder, Vault } from 'obsidian';
import { SyncExecutor } from '../../src/sync/SyncExecutor';
import {
	ConflictRecord,
	S3DownloadResult,
	S3HeadResult,
	SyncAction,
	SyncError,
	SyncPlanItem,
	SyncResult,
	SyncStateRecord,
} from '../../src/types';
import { encodeMetadata } from '../../src/sync/SyncObjectMetadata';
import { getVaultFileKind, readVaultFile, toArrayBuffer } from '../../src/utils/vaultFiles';
import { sleep } from '../../src/utils/retry';

class TestTFile extends TFile {
	content: string | Uint8Array;

	constructor(path: string, content: string | Uint8Array = '', stats: Partial<FileStats> = {}) {
		super();
		this.path = path;
		this.content = content;

		const name = path.split('/').pop() ?? path;
		const dotIndex = name.lastIndexOf('.');
		this.name = name;
		this.basename = dotIndex > 0 ? name.slice(0, dotIndex) : name;
		this.extension = dotIndex > 0 ? name.slice(dotIndex + 1) : '';

		const size = typeof content === 'string' ? content.length : content.byteLength;
		this.stat = {
			ctime: stats.ctime ?? 100,
			mtime: stats.mtime ?? 200,
			size: stats.size ?? size,
		};
	}
}

class TestTFolder extends TFolder {
	constructor(path: string) {
		super();
		this.path = path;
		this.name = path.split('/').pop() ?? path;
	}
}

interface VaultWithMocks {
	getAbstractFileByPath: jest.Mock<TFile | TFolder | null, [string]>;
	rename: jest.Mock<Promise<void>, [TFile, string]>;
	createFolder: jest.Mock<Promise<TFolder>, [string]>;
	createBinary: jest.Mock<Promise<TFile>, [string, ArrayBuffer]>;
	modifyBinary: jest.Mock<Promise<void>, [TFile, ArrayBuffer]>;
	create: jest.Mock<Promise<TFile>, [string, string]>;
	modify: jest.Mock<Promise<void>, [TFile, string]>;
}

interface FileManagerWithMocks {
	trashFile: jest.Mock<Promise<void>, [TFile]>;
}

interface AppWithMocks {
	vault: VaultWithMocks;
	fileManager: FileManagerWithMocks;
}

interface MockS3Provider {
	headObject: jest.Mock<Promise<S3HeadResult | null | undefined>, [string]>;
	uploadFile: jest.Mock<Promise<string>, [string, Uint8Array, Record<string, unknown>]>;
	downloadFileWithMetadata: jest.Mock<Promise<S3DownloadResult | null>, [string]>;
	deleteFile: jest.Mock<Promise<void>, [string]>;
}

interface MockJournal {
	setStateRecord: jest.Mock<Promise<void>, [SyncStateRecord]>;
	deleteStateRecord: jest.Mock<Promise<void>, [string]>;
	setConflict: jest.Mock<Promise<void>, [ConflictRecord]>;
	deleteConflict: jest.Mock<Promise<void>, [string]>;
	getStateRecord: jest.Mock<Promise<SyncStateRecord | undefined>, [string]>;
	getAllConflicts: jest.Mock<Promise<ConflictRecord[]>, []>;
}

interface MockPathCodec {
	localToRemote: jest.Mock<string, [string]>;
}

interface MockPayloadCodec {
	fingerprint: jest.Mock<Promise<string>, [string | Uint8Array]>;
	encodeForUpload: jest.Mock<Uint8Array, [string | Uint8Array]>;
	decodeAfterDownload: jest.Mock<Uint8Array, [Uint8Array, undefined?]>;
	getActivePayloadFormat: jest.Mock<string, []>;
}

interface MockChangeTracker {
	markPathSyncing: jest.Mock<void, [string]>;
	clearPath: jest.Mock<void, [string]>;
}

type ItemMethodName =
	| 'executeAdopt'
	| 'executeUpload'
	| 'executeDownload'
	| 'executeDeleteLocal'
	| 'executeDeleteRemote'
	| 'executeConflict'
	| 'executeForget';

interface ExecutorInternals {
	executeItem(item: SyncPlanItem, result: SyncResult): Promise<void>;
	executeAdopt(item: SyncPlanItem): Promise<void>;
	executeUpload(item: SyncPlanItem): Promise<void>;
	executeDownload(item: SyncPlanItem): Promise<void>;
	executeDeleteLocal(item: SyncPlanItem): Promise<void>;
	executeDeleteRemote(item: SyncPlanItem): Promise<void>;
	executeConflict(item: SyncPlanItem): Promise<void>;
	executeForget(item: SyncPlanItem): Promise<void>;
	writeLocalFile(path: string, content: string | Uint8Array): Promise<void>;
	ensureParentFolders(path: string): Promise<void>;
	guessContentType(path: string): string;
	toSyncError(path: string, action: SyncAction, error: unknown): SyncError;
	log(message: string): void;
}

interface ExecutorContext {
	app: AppWithMocks;
	vaultEntries: Map<string, TFile | TFolder>;
	s3Provider: MockS3Provider;
	journal: MockJournal;
	pathCodec: MockPathCodec;
	payloadCodec: MockPayloadCodec;
	changeTracker: MockChangeTracker;
	executor: SyncExecutor;
	internals: ExecutorInternals;
	addFile(path: string, content?: string | Uint8Array, stats?: Partial<FileStats>): TFile;
	addFolder(path: string): TFolder;
	removeEntry(path: string): void;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

const mockedEncodeMetadata = jest.mocked(encodeMetadata);
const mockedGetVaultFileKind = jest.mocked(getVaultFileKind);
const mockedReadVaultFile = jest.mocked(readVaultFile);
const mockedToArrayBuffer = jest.mocked(toArrayBuffer);
const mockedSleep = jest.mocked(sleep);

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await Promise.resolve();
	await Promise.resolve();
}

function createPlanItem(action: SyncAction, overrides: Partial<SyncPlanItem> = {}): SyncPlanItem {
	return {
		path: 'notes/test.md',
		action,
		reason: `${action} reason`,
		...overrides,
	};
}

function createResult(): SyncResult {
	return {
		success: false,
		startedAt: 0,
		completedAt: 0,
		filesUploaded: 0,
		filesDownloaded: 0,
		filesDeleted: 0,
		filesAdopted: 0,
		filesForgotten: 0,
		conflicts: [],
		errors: [],
	};
}

function createConflictRecord(path: string): ConflictRecord {
	return {
		path,
		mode: 'both',
		detectedAt: 123,
	};
}

function createDownloadResult(overrides: Partial<S3DownloadResult> = {}): S3DownloadResult {
	return {
		content: new Uint8Array([1, 2, 3]),
		etag: 'remote-etag',
		size: 3,
		lastModified: 456,
		clientMtime: 789,
		deviceId: 'remote-device',
		...overrides,
	};
}

function createHeadResult(overrides: Partial<S3HeadResult> = {}): S3HeadResult {
	return {
		etag: 'remote-etag',
		size: 11,
		lastModified: 999,
		fingerprint: 'remote-fingerprint',
		clientMtime: 777,
		deviceId: 'remote-device',
		...overrides,
	};
}

function createExecutorContext(debugLogging = false): ExecutorContext {
	const vaultEntries = new Map<string, TFile | TFolder>();
	const vault = new Vault() as unknown as VaultWithMocks;
	vault.getAbstractFileByPath = jest.fn((path: string) => vaultEntries.get(path) ?? null);
	vault.create = jest.fn(async (path: string, data: string) => {
		const file = new TestTFile(path, data);
		vaultEntries.set(path, file);
		return file;
	});
	vault.modify = jest.fn(async (file: TFile, data: string) => {
		const mutableFile = file as TestTFile;
		mutableFile.content = data;
		mutableFile.stat = { ...mutableFile.stat, size: data.length };
	});
	vault.createBinary = jest.fn(async (path: string, data: ArrayBuffer) => {
		const content = new Uint8Array(data);
		const file = new TestTFile(path, content, { size: content.byteLength });
		vaultEntries.set(path, file);
		return file;
	});
	vault.modifyBinary = jest.fn(async (file: TFile, data: ArrayBuffer) => {
		const mutableFile = file as TestTFile;
		const content = new Uint8Array(data);
		mutableFile.content = content;
		mutableFile.stat = { ...mutableFile.stat, size: content.byteLength };
	});
	vault.rename = jest.fn(async (file: TFile, newPath: string) => {
		vaultEntries.delete(file.path);
		const mutableFile = file as TestTFile;
		mutableFile.path = newPath;
		mutableFile.name = newPath.split('/').pop() ?? newPath;
		vaultEntries.set(newPath, mutableFile);
	});
	vault.createFolder = jest.fn(async (path: string) => {
		const folder = new TestTFolder(path);
		vaultEntries.set(path, folder);
		return folder;
	});

	const app = new App() as unknown as AppWithMocks;
	app.vault = vault;
	app.fileManager = {
		trashFile: jest.fn(async (file: TFile) => {
			vaultEntries.delete(file.path);
		}),
	};

	const s3Provider: MockS3Provider = {
		headObject: jest.fn(),
		uploadFile: jest.fn(),
		downloadFileWithMetadata: jest.fn(),
		deleteFile: jest.fn(),
	};

	const journal: MockJournal = {
		setStateRecord: jest.fn().mockResolvedValue(undefined),
		deleteStateRecord: jest.fn().mockResolvedValue(undefined),
		setConflict: jest.fn().mockResolvedValue(undefined),
		deleteConflict: jest.fn().mockResolvedValue(undefined),
		getStateRecord: jest.fn().mockResolvedValue(undefined),
		getAllConflicts: jest.fn().mockResolvedValue([]),
	};

	const pathCodec: MockPathCodec = {
		localToRemote: jest.fn((path: string) => `remote/${path}`),
	};

	const payloadCodec: MockPayloadCodec = {
		fingerprint: jest.fn().mockResolvedValue('fingerprint-1'),
		encodeForUpload: jest.fn<Uint8Array, [string | Uint8Array]>((_content) => new Uint8Array([9, 8, 7])),
		decodeAfterDownload: jest.fn((content: Uint8Array) => content),
		getActivePayloadFormat: jest.fn().mockReturnValue('plaintext-v1'),
	};

	const changeTracker: MockChangeTracker = {
		markPathSyncing: jest.fn(),
		clearPath: jest.fn(),
	};

	const executor = new SyncExecutor(
		app as unknown as App,
		s3Provider as never,
		journal as never,
		pathCodec as never,
		payloadCodec as never,
		changeTracker as never,
		'device-123',
		debugLogging,
	);

	const internals = executor as unknown as ExecutorInternals;

	return {
		app,
		vaultEntries,
		s3Provider,
		journal,
		pathCodec,
		payloadCodec,
		changeTracker,
		executor,
		internals,
		addFile(path: string, content: string | Uint8Array = '', stats: Partial<FileStats> = {}): TFile {
			const file = new TestTFile(path, content, stats);
			vaultEntries.set(path, file);
			return file;
		},
		addFolder(path: string): TFolder {
			const folder = new TestTFolder(path);
			vaultEntries.set(path, folder);
			return folder;
		},
		removeEntry(path: string): void {
			vaultEntries.delete(path);
		},
	};
}

describe('SyncExecutor', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockedEncodeMetadata.mockReturnValue({ encoded: 'true' });
		mockedGetVaultFileKind.mockImplementation((path: string) => path.endsWith('.md') ? 'text' : 'binary');
		mockedReadVaultFile.mockResolvedValue('vault-content');
		mockedToArrayBuffer.mockImplementation((content: Uint8Array) => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
		mockedSleep.mockResolvedValue(undefined);
	});

	describe('execute', () => {
		it('returns a successful empty result for an empty plan', async () => {
			const { executor, journal } = createExecutorContext();

			const result = await executor.execute([]);

			expect(result.success).toBe(true);
			expect(result.filesUploaded).toBe(0);
			expect(result.filesDownloaded).toBe(0);
			expect(result.filesDeleted).toBe(0);
			expect(result.filesAdopted).toBe(0);
			expect(result.filesForgotten).toBe(0);
			expect(result.errors).toEqual([]);
			expect(result.conflicts).toEqual([]);
			expect(result.startedAt).toBeGreaterThan(0);
			expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
			expect(journal.getAllConflicts).toHaveBeenCalledTimes(1);
		});

		it('dispatches multiple items and increments result counters correctly', async () => {
			const { executor, internals, journal } = createExecutorContext();
			jest.spyOn(internals, 'executeAdopt').mockResolvedValue(undefined);
			jest.spyOn(internals, 'executeUpload').mockResolvedValue(undefined);
			jest.spyOn(internals, 'executeDownload').mockResolvedValue(undefined);
			jest.spyOn(internals, 'executeDeleteLocal').mockResolvedValue(undefined);
			jest.spyOn(internals, 'executeDeleteRemote').mockResolvedValue(undefined);
			jest.spyOn(internals, 'executeConflict').mockResolvedValue(undefined);
			jest.spyOn(internals, 'executeForget').mockResolvedValue(undefined);
			journal.getAllConflicts.mockResolvedValue([createConflictRecord('from-journal.md')]);

			const result = await executor.execute([
				createPlanItem('adopt', { path: 'adopt.md' }),
				createPlanItem('upload', { path: 'upload.md' }),
				createPlanItem('download', { path: 'download.md' }),
				createPlanItem('delete-local', { path: 'delete-local.md' }),
				createPlanItem('delete-remote', { path: 'delete-remote.md' }),
				createPlanItem('conflict', { path: 'conflict.md', conflictMode: 'both' }),
				createPlanItem('forget', { path: 'forget.md' }),
				createPlanItem('skip', { path: 'skip.md' }),
			]);

			expect(result.success).toBe(true);
			expect(result.filesAdopted).toBe(1);
			expect(result.filesUploaded).toBe(1);
			expect(result.filesDownloaded).toBe(1);
			expect(result.filesDeleted).toBe(2);
			expect(result.filesForgotten).toBe(1);
			expect(result.conflicts).toEqual(['from-journal.md']);
			expect(result.errors).toEqual([]);
		});

		it('runs with bounded concurrency and schedules more work as slots free up', async () => {
			const { executor, internals } = createExecutorContext();
			const deferreds: Deferred<void>[] = [];
			let active = 0;
			let maxActive = 0;

			jest.spyOn(internals, 'executeItem').mockImplementation(async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				const deferred = createDeferred<void>();
				deferreds.push(deferred);
				await deferred.promise;
				active--;
			});

			const plan = [1, 2, 3, 4, 5].map((index) => createPlanItem('skip', { path: `file-${index}.md` }));
			const execution = executor.execute(plan);

			await flushPromises();
			expect(internals.executeItem).toHaveBeenCalledTimes(4);
			expect(maxActive).toBe(4);

			deferreds[0]?.resolve(undefined);
			await flushPromises();

			expect(internals.executeItem).toHaveBeenCalledTimes(5);

			for (const deferred of deferreds.slice(1)) {
				deferred.resolve(undefined);
			}

			await execution;
		});

		it('stops scheduling new items after three errors but lets in-flight work finish', async () => {
			const { executor, internals } = createExecutorContext();
			const deferreds: Deferred<void>[] = [];

			jest.spyOn(internals, 'executeItem').mockImplementation(async () => {
				const deferred = createDeferred<void>();
				deferreds.push(deferred);
				await deferred.promise;
			});

			const plan = Array.from({ length: 8 }, (_, index) => createPlanItem('skip', { path: `file-${index}.md` }));
			const execution = executor.execute(plan);

			await flushPromises();
			expect(internals.executeItem).toHaveBeenCalledTimes(4);

			deferreds[0]?.reject(new Error('fail-1'));
			await flushPromises();
			expect(internals.executeItem).toHaveBeenCalledTimes(5);

			deferreds[1]?.reject(new Error('fail-2'));
			await flushPromises();
			expect(internals.executeItem).toHaveBeenCalledTimes(6);

			deferreds[2]?.reject(new Error('fail-3'));
			await flushPromises();
			expect(internals.executeItem).toHaveBeenCalledTimes(6);

			for (const deferred of deferreds.slice(3)) {
				deferred.resolve(undefined);
			}

			const result = await execution;

			expect(result.success).toBe(false);
			expect(result.errors).toHaveLength(3);
			expect(result.errors.map((error) => error.message)).toEqual(['fail-1', 'fail-2', 'fail-3']);
		});

		it('captures item failures as SyncError objects and marks success only when there are no errors', async () => {
			const { executor, internals } = createExecutorContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			jest.spyOn(internals, 'executeItem')
				.mockRejectedValueOnce(new Error('boom'))
				.mockRejectedValueOnce('bad payload');

			const result = await executor.execute([
				createPlanItem('upload', { path: 'error-a.md' }),
				createPlanItem('download', { path: 'error-b.md' }),
			]);

			expect(result.success).toBe(false);
			expect(result.errors).toEqual([
				{ path: 'error-a.md', action: 'upload', message: 'boom', recoverable: true },
				{ path: 'error-b.md', action: 'download', message: 'Unknown error', recoverable: true },
			]);
			expect(consoleErrorSpy).toHaveBeenCalledTimes(2);

			consoleErrorSpy.mockRestore();
		});

		it('marks each plan item as syncing before execution and clears it afterward', async () => {
			const actionMethodEntries: Array<[SyncAction, ItemMethodName | null]> = [
				['adopt', 'executeAdopt'],
				['upload', 'executeUpload'],
				['download', 'executeDownload'],
				['delete-local', 'executeDeleteLocal'],
				['delete-remote', 'executeDeleteRemote'],
				['conflict', 'executeConflict'],
				['forget', 'executeForget'],
				['skip', null],
			];

			for (const [action, methodName] of actionMethodEntries) {
				const context = createExecutorContext();
				const item = createPlanItem(action, { path: `${action}.md`, conflictMode: action === 'conflict' ? 'both' : undefined });

				if (methodName) {
					jest.spyOn(context.internals, methodName).mockImplementation(async (planItem: SyncPlanItem) => {
						expect(context.changeTracker.markPathSyncing).toHaveBeenCalledWith(planItem.path);
						expect(context.changeTracker.clearPath).not.toHaveBeenCalled();
					});
				}

				await context.executor.execute([item]);

				expect(context.changeTracker.markPathSyncing).toHaveBeenCalledWith(item.path);
				expect(context.changeTracker.clearPath).toHaveBeenCalledWith(item.path);
			}
		});

		it('replaces in-memory conflict paths with journal conflicts at the end', async () => {
			const { executor, internals, journal } = createExecutorContext();
			jest.spyOn(internals, 'executeConflict').mockResolvedValue(undefined);
			journal.getAllConflicts.mockResolvedValue([
				createConflictRecord('journal-a.md'),
				createConflictRecord('journal-b.md'),
			]);

			const result = await executor.execute([
				createPlanItem('conflict', { path: 'local-conflict.md', conflictMode: 'both' }),
			]);

			expect(result.conflicts).toEqual(['journal-a.md', 'journal-b.md']);
		});
	});

	describe('executeItem', () => {
		const actionCases: Array<{
			action: SyncAction;
			method: keyof ExecutorInternals | null;
			counter?: keyof Pick<SyncResult, 'filesAdopted' | 'filesUploaded' | 'filesDownloaded' | 'filesDeleted' | 'filesForgotten'>;
		}> = [
			{ action: 'adopt', method: 'executeAdopt', counter: 'filesAdopted' },
			{ action: 'upload', method: 'executeUpload', counter: 'filesUploaded' },
			{ action: 'download', method: 'executeDownload', counter: 'filesDownloaded' },
			{ action: 'delete-local', method: 'executeDeleteLocal', counter: 'filesDeleted' },
			{ action: 'delete-remote', method: 'executeDeleteRemote', counter: 'filesDeleted' },
			{ action: 'forget', method: 'executeForget', counter: 'filesForgotten' },
			{ action: 'skip', method: null },
		];

		it.each(actionCases)('dispatches $action and updates counters', async ({ action, method, counter }) => {
			const { internals, changeTracker } = createExecutorContext();
			const result = createResult();
			const item = createPlanItem(action, { path: `${action}.md` });

			if (method) {
				const spy = jest.spyOn(internals, method).mockResolvedValue(undefined);
				await internals.executeItem(item, result);

				expect(spy).toHaveBeenCalledWith(item);
				if (counter) {
					expect(result[counter]).toBe(1);
				}
			} else {
				await internals.executeItem(item, result);
				expect(result.filesAdopted).toBe(0);
				expect(result.filesUploaded).toBe(0);
				expect(result.filesDownloaded).toBe(0);
				expect(result.filesDeleted).toBe(0);
				expect(result.filesForgotten).toBe(0);
			}

			expect(changeTracker.clearPath).toHaveBeenCalledWith(item.path);
		});

		it('dispatches conflict items and appends the path to result.conflicts', async () => {
			const { internals, changeTracker } = createExecutorContext();
			const result = createResult();
			const item = createPlanItem('conflict', { path: 'conflict.md', conflictMode: 'both' });
			const conflictSpy = jest.spyOn(internals, 'executeConflict').mockResolvedValue(undefined);

			await internals.executeItem(item, result);

			expect(conflictSpy).toHaveBeenCalledWith(item);
			expect(result.conflicts).toEqual(['conflict.md']);
			expect(changeTracker.clearPath).toHaveBeenCalledWith(item.path);
		});
	});

	describe('executeAdopt', () => {
		it('adopts the current local and remote baseline and clears conflicts', async () => {
			const { internals, app, addFile, s3Provider, journal, payloadCodec } = createExecutorContext();
			const file = addFile('notes/test.md', 'local body', { mtime: 321, size: 10 });
			s3Provider.headObject.mockResolvedValue(createHeadResult());
			app.vault.getAbstractFileByPath.mockReturnValue(file);
			mockedReadVaultFile.mockResolvedValue('local body');
			payloadCodec.fingerprint.mockResolvedValue('local-fingerprint');

			await internals.executeAdopt(createPlanItem('adopt'));

			expect(s3Provider.headObject).toHaveBeenCalledWith('remote/notes/test.md');
			expect(mockedReadVaultFile).toHaveBeenCalledWith(app.vault, file);
			expect(payloadCodec.fingerprint).toHaveBeenCalledWith('local body');
			expect(journal.setStateRecord).toHaveBeenCalledWith(expect.objectContaining({
				path: 'notes/test.md',
				remoteKey: 'remote/notes/test.md',
				contentFingerprint: 'local-fingerprint',
				localMtime: 321,
				localSize: 10,
				remoteClientMtime: 777,
				remoteObjectSize: 11,
				remoteEtag: 'remote-etag',
				remoteLastModified: 999,
				lastWriterDeviceId: 'remote-device',
				lastSyncedAt: expect.any(Number),
			}));
			expect(journal.deleteConflict).toHaveBeenCalledWith('notes/test.md');
		});

		it('falls back to an empty fingerprint when the local file and remote metadata are missing', async () => {
			const { internals, app, s3Provider, journal, payloadCodec } = createExecutorContext();
			app.vault.getAbstractFileByPath.mockReturnValue(null);
			s3Provider.headObject.mockResolvedValue(null);

			await internals.executeAdopt(createPlanItem('adopt'));

			expect(payloadCodec.fingerprint).not.toHaveBeenCalled();
			expect(journal.setStateRecord).toHaveBeenCalledWith(expect.objectContaining({
				contentFingerprint: '',
				localMtime: 0,
				localSize: 0,
				remoteClientMtime: null,
				remoteObjectSize: 0,
				remoteLastModified: null,
			}));
		});
	});

	describe('executeUpload', () => {
		it('uploads a local file with If-None-Match when the remote must be absent', async () => {
			const { internals, app, addFile, s3Provider, payloadCodec, journal } = createExecutorContext();
			const file = addFile('notes/test.md', 'upload me', { mtime: 444, size: 9 });
			app.vault.getAbstractFileByPath.mockReturnValue(file);
			mockedReadVaultFile.mockResolvedValue('upload me');
			payloadCodec.fingerprint.mockResolvedValue('upload-fingerprint');
			payloadCodec.encodeForUpload.mockReturnValue(new Uint8Array([4, 5, 6]));
			s3Provider.uploadFile.mockResolvedValue('etag-uploaded');

			await internals.executeUpload(createPlanItem('upload', { expectRemoteAbsent: true }));

			expect(mockedReadVaultFile).toHaveBeenCalledWith(app.vault, file);
			expect(payloadCodec.fingerprint).toHaveBeenCalledWith('upload me');
			expect(payloadCodec.encodeForUpload).toHaveBeenCalledWith('upload me');
			expect(mockedEncodeMetadata).toHaveBeenCalledWith({
				fingerprint: 'upload-fingerprint',
				clientMtime: 444,
				deviceId: 'device-123',
				payloadFormat: 'plaintext-v1',
			});
			expect(s3Provider.uploadFile).toHaveBeenCalledWith('remote/notes/test.md', new Uint8Array([4, 5, 6]), {
				contentType: 'text/plain; charset=utf-8',
				ifMatch: undefined,
				ifNoneMatch: '*',
				metadata: { encoded: 'true' },
			});
			expect(journal.setStateRecord).toHaveBeenCalledWith(expect.objectContaining({
				path: 'notes/test.md',
				remoteKey: 'remote/notes/test.md',
				contentFingerprint: 'upload-fingerprint',
				localMtime: 444,
				localSize: 9,
				remoteClientMtime: 444,
				remoteObjectSize: 3,
				remoteEtag: 'etag-uploaded',
				remoteLastModified: null,
				lastWriterDeviceId: 'device-123',
			}));
			expect(journal.deleteConflict).toHaveBeenCalledWith('notes/test.md');
		});

		it('uploads with If-Match when an expected remote ETag is provided', async () => {
			const { internals, app, addFile, s3Provider, payloadCodec } = createExecutorContext();
			const file = addFile('notes/test.md', 'upload me', { mtime: 444, size: 9 });
			app.vault.getAbstractFileByPath.mockReturnValue(file);
			mockedReadVaultFile.mockResolvedValue('upload me');
			payloadCodec.encodeForUpload.mockReturnValue(new Uint8Array([1]));
			s3Provider.uploadFile.mockResolvedValue('etag-uploaded');

			await internals.executeUpload(createPlanItem('upload', { expectedRemoteEtag: 'expected-etag' }));

			expect(s3Provider.uploadFile).toHaveBeenCalledWith('remote/notes/test.md', new Uint8Array([1]), expect.objectContaining({
				ifMatch: 'expected-etag',
				ifNoneMatch: undefined,
			}));
		});

		it('throws when the local file is not present in the vault', async () => {
			const { internals, app } = createExecutorContext();
			app.vault.getAbstractFileByPath.mockReturnValue(null);

			await expect(internals.executeUpload(createPlanItem('upload'))).rejects.toThrow('File not found for upload: notes/test.md');
		});
	});

	describe('executeDownload', () => {
		it('downloads text content, writes it locally, sleeps, and records new state', async () => {
			const { internals, addFile, s3Provider, payloadCodec, journal, app } = createExecutorContext();
			const plaintext = new TextEncoder().encode('hello world');
			const localFile = addFile('notes/test.md', 'hello world', { mtime: 654, size: 11 });
			const writeSpy = jest.spyOn(internals, 'writeLocalFile').mockResolvedValue(undefined);
			s3Provider.downloadFileWithMetadata.mockResolvedValue(createDownloadResult({ content: new Uint8Array([9, 9]) }));
			payloadCodec.decodeAfterDownload.mockReturnValue(plaintext);
			app.vault.getAbstractFileByPath.mockReturnValue(localFile);

			await internals.executeDownload(createPlanItem('download'));

			expect(s3Provider.downloadFileWithMetadata).toHaveBeenCalledWith('remote/notes/test.md');
			expect(payloadCodec.decodeAfterDownload).toHaveBeenCalledWith(new Uint8Array([9, 9]), undefined);
			expect(writeSpy).toHaveBeenCalledWith('notes/test.md', 'hello world');
			expect(mockedSleep).toHaveBeenCalledWith(0);
			expect(payloadCodec.fingerprint).toHaveBeenCalledWith('hello world');
			expect(journal.setStateRecord).toHaveBeenCalledWith(expect.objectContaining({
				path: 'notes/test.md',
				remoteKey: 'remote/notes/test.md',
				contentFingerprint: 'fingerprint-1',
				localMtime: 654,
				localSize: 11,
				remoteClientMtime: 789,
				remoteObjectSize: 3,
				remoteEtag: 'remote-etag',
				remoteLastModified: 456,
				lastWriterDeviceId: 'remote-device',
			}));
			expect(journal.deleteConflict).toHaveBeenCalledWith('notes/test.md');
		});

		it('downloads binary content and writes bytes to the vault', async () => {
			const { internals, addFile, s3Provider, payloadCodec, app } = createExecutorContext();
			const plaintext = new Uint8Array([7, 8, 9]);
			const localFile = addFile('notes/test.png', plaintext, { mtime: 777, size: 3 });
			const writeSpy = jest.spyOn(internals, 'writeLocalFile').mockResolvedValue(undefined);
			mockedGetVaultFileKind.mockImplementation((path: string) => path.endsWith('.png') ? 'binary' : 'text');
			s3Provider.downloadFileWithMetadata.mockResolvedValue(createDownloadResult({ content: new Uint8Array([5, 5]) }));
			payloadCodec.decodeAfterDownload.mockReturnValue(plaintext);
			app.vault.getAbstractFileByPath.mockReturnValue(localFile);

			await internals.executeDownload(createPlanItem('download', { path: 'notes/test.png' }));

			expect(writeSpy).toHaveBeenCalledWith('notes/test.png', plaintext);
			expect(payloadCodec.fingerprint).toHaveBeenCalledWith(plaintext);
		});

		it('throws when the remote file disappears during download', async () => {
			const { internals, s3Provider } = createExecutorContext();
			s3Provider.downloadFileWithMetadata.mockResolvedValue(null);

			await expect(internals.executeDownload(createPlanItem('download'))).rejects.toThrow('Remote file disappeared during sync: notes/test.md');
		});

		it('throws when the downloaded file is not found after writing', async () => {
			const { internals, s3Provider, payloadCodec, app } = createExecutorContext();
			jest.spyOn(internals, 'writeLocalFile').mockResolvedValue(undefined);
			s3Provider.downloadFileWithMetadata.mockResolvedValue(createDownloadResult());
			payloadCodec.decodeAfterDownload.mockReturnValue(new TextEncoder().encode('missing'));
			app.vault.getAbstractFileByPath.mockReturnValue(null);

			await expect(internals.executeDownload(createPlanItem('download'))).rejects.toThrow('Downloaded file not found in vault: notes/test.md');
		});
	});

	describe('executeDeleteLocal', () => {
		it('trashes an existing local file and clears journal entries', async () => {
			const { internals, app, addFile, journal } = createExecutorContext();
			const file = addFile('notes/test.md', 'delete me');
			app.vault.getAbstractFileByPath.mockReturnValue(file);

			await internals.executeDeleteLocal(createPlanItem('delete-local'));

			expect(app.fileManager.trashFile).toHaveBeenCalledWith(file);
			expect(journal.deleteStateRecord).toHaveBeenCalledWith('notes/test.md');
			expect(journal.deleteConflict).toHaveBeenCalledWith('notes/test.md');
		});

		it('does not throw when the local file is already absent', async () => {
			const { internals, app, journal } = createExecutorContext();
			app.vault.getAbstractFileByPath.mockReturnValue(null);

			await expect(internals.executeDeleteLocal(createPlanItem('delete-local'))).resolves.toBeUndefined();
			expect(app.fileManager.trashFile).not.toHaveBeenCalled();
			expect(journal.deleteStateRecord).toHaveBeenCalledWith('notes/test.md');
			expect(journal.deleteConflict).toHaveBeenCalledWith('notes/test.md');
		});
	});

	describe('executeDeleteRemote', () => {
		it('checks the remote ETag before deleting and throws on mismatch', async () => {
			const { internals, s3Provider } = createExecutorContext();
			s3Provider.headObject.mockResolvedValue(createHeadResult({ etag: 'different-etag' }));

			await expect(internals.executeDeleteRemote(createPlanItem('delete-remote', { expectedRemoteEtag: 'expected-etag' }))).rejects.toThrow(
				'Remote file notes/test.md changed since planning (expected ETag expected-etag, got different-etag). Skipping delete.',
			);
			expect(s3Provider.deleteFile).not.toHaveBeenCalled();
		});

		it('deletes the remote file when the expected ETag matches', async () => {
			const { internals, s3Provider, journal } = createExecutorContext();
			s3Provider.headObject.mockResolvedValue(createHeadResult({ etag: 'expected-etag' }));

			await internals.executeDeleteRemote(createPlanItem('delete-remote', { expectedRemoteEtag: 'expected-etag' }));

			expect(s3Provider.headObject).toHaveBeenCalledWith('remote/notes/test.md');
			expect(s3Provider.deleteFile).toHaveBeenCalledWith('remote/notes/test.md');
			expect(journal.deleteStateRecord).toHaveBeenCalledWith('notes/test.md');
			expect(journal.deleteConflict).toHaveBeenCalledWith('notes/test.md');
		});

		it('deletes directly when there is no expected remote ETag', async () => {
			const { internals, s3Provider } = createExecutorContext();

			await internals.executeDeleteRemote(createPlanItem('delete-remote'));

			expect(s3Provider.headObject).not.toHaveBeenCalled();
			expect(s3Provider.deleteFile).toHaveBeenCalledWith('remote/notes/test.md');
		});
	});

	describe('executeConflict', () => {
		it('creates both LOCAL_ and REMOTE_ artifacts for subdirectory conflicts', async () => {
			const { internals, addFile, app, s3Provider, payloadCodec, journal } = createExecutorContext();
			const file = addFile('notes/test.md', 'local body');
			const writeSpy = jest.spyOn(internals, 'writeLocalFile').mockResolvedValue(undefined);
			app.vault.getAbstractFileByPath.mockReturnValue(file);
			journal.getStateRecord.mockResolvedValue({
				path: 'notes/test.md',
				remoteKey: 'remote/notes/test.md',
				contentFingerprint: 'baseline-fingerprint',
				localMtime: 1,
				localSize: 1,
				remoteClientMtime: 1,
				remoteObjectSize: 1,
				remoteLastModified: 1,
				lastSyncedAt: 1,
			});
			s3Provider.downloadFileWithMetadata.mockResolvedValue(createDownloadResult({ content: new Uint8Array([1, 1]) }));
			payloadCodec.decodeAfterDownload.mockReturnValue(new TextEncoder().encode('remote body'));

			await internals.executeConflict(createPlanItem('conflict', { conflictMode: 'both' }));

			expect(payloadCodec.decodeAfterDownload).toHaveBeenCalledWith(new Uint8Array([1, 1]), undefined);
			expect(app.vault.rename).toHaveBeenCalledWith(file, 'notes/LOCAL_test.md');
			expect(writeSpy).toHaveBeenCalledWith('notes/REMOTE_test.md', 'remote body');
			expect(journal.setConflict).toHaveBeenCalledWith(expect.objectContaining({
				path: 'notes/test.md',
				mode: 'both',
				localArtifactPath: 'notes/LOCAL_test.md',
				remoteArtifactPath: 'notes/REMOTE_test.md',
				baselineFingerprint: 'baseline-fingerprint',
				detectedAt: expect.any(Number),
			}));
		});

		it('creates only a LOCAL_ artifact for root-level local-only conflicts', async () => {
			const { internals, addFile, app, s3Provider, journal } = createExecutorContext();
			const file = addFile('test.md', 'local body');
			app.vault.getAbstractFileByPath.mockReturnValue(file);

			await internals.executeConflict(createPlanItem('conflict', {
				path: 'test.md',
				conflictMode: 'local-only',
			}));

			expect(app.vault.rename).toHaveBeenCalledWith(file, 'LOCAL_test.md');
			expect(s3Provider.downloadFileWithMetadata).not.toHaveBeenCalled();
			expect(journal.setConflict).toHaveBeenCalledWith(expect.objectContaining({
				path: 'test.md',
				mode: 'local-only',
				localArtifactPath: 'LOCAL_test.md',
				remoteArtifactPath: undefined,
			}));
		});

		it('creates only a REMOTE_ artifact for remote-only conflicts', async () => {
			const { internals, app, s3Provider, payloadCodec, journal } = createExecutorContext();
			const writeSpy = jest.spyOn(internals, 'writeLocalFile').mockResolvedValue(undefined);
			app.vault.getAbstractFileByPath.mockReturnValue(null);
			mockedGetVaultFileKind.mockImplementation((path: string) => path.endsWith('.png') ? 'binary' : 'text');
			s3Provider.downloadFileWithMetadata.mockResolvedValue(createDownloadResult({ content: new Uint8Array([2, 2]) }));
			payloadCodec.decodeAfterDownload.mockReturnValue(new Uint8Array([7, 8, 9]));

			await internals.executeConflict(createPlanItem('conflict', {
				path: 'images/test.png',
				conflictMode: 'remote-only',
			}));

			expect(app.vault.rename).not.toHaveBeenCalled();
			expect(writeSpy).toHaveBeenCalledWith('images/REMOTE_test.png', new Uint8Array([7, 8, 9]));
			expect(journal.setConflict).toHaveBeenCalledWith(expect.objectContaining({
				path: 'images/test.png',
				mode: 'remote-only',
				localArtifactPath: undefined,
				remoteArtifactPath: 'images/REMOTE_test.png',
			}));
		});
	});

	describe('executeForget', () => {
		it('removes state and conflict records for forgotten paths', async () => {
			const { internals, journal } = createExecutorContext();

			await internals.executeForget(createPlanItem('forget'));

			expect(journal.deleteStateRecord).toHaveBeenCalledWith('notes/test.md');
			expect(journal.deleteConflict).toHaveBeenCalledWith('notes/test.md');
		});
	});

	describe('writeLocalFile', () => {
		it('modifies an existing text file with string content', async () => {
			const { internals, app, addFile } = createExecutorContext();
			const file = addFile('notes/test.md', 'old text');
			app.vault.getAbstractFileByPath.mockReturnValue(file);

			await internals.writeLocalFile('notes/test.md', 'new text');

			expect(app.vault.modify).toHaveBeenCalledWith(file, 'new text');
			expect(app.vault.modifyBinary).not.toHaveBeenCalled();
		});

		it('modifies an existing binary file with Uint8Array content', async () => {
			const { internals, app, addFile } = createExecutorContext();
			const file = addFile('notes/test.png', new Uint8Array([1]));
			const buffer = new ArrayBuffer(3);
			app.vault.getAbstractFileByPath.mockReturnValue(file);
			mockedToArrayBuffer.mockReturnValue(buffer);

			await internals.writeLocalFile('notes/test.png', new Uint8Array([1, 2, 3]));

			expect(mockedToArrayBuffer).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
			expect(app.vault.modifyBinary).toHaveBeenCalledWith(file, buffer);
		});

		it('creates a new text file after ensuring parent folders', async () => {
			const { internals, app } = createExecutorContext();
			const ensureSpy = jest.spyOn(internals, 'ensureParentFolders').mockResolvedValue(undefined);
			app.vault.getAbstractFileByPath.mockReturnValue(null);

			await internals.writeLocalFile('notes/new.md', 'created text');

			expect(ensureSpy).toHaveBeenCalledWith('notes/new.md');
			expect(app.vault.create).toHaveBeenCalledWith('notes/new.md', 'created text');
		});

		it('creates a new binary file after ensuring parent folders', async () => {
			const { internals, app } = createExecutorContext();
			const ensureSpy = jest.spyOn(internals, 'ensureParentFolders').mockResolvedValue(undefined);
			const buffer = new ArrayBuffer(2);
			app.vault.getAbstractFileByPath.mockReturnValue(null);
			mockedToArrayBuffer.mockReturnValue(buffer);

			await internals.writeLocalFile('images/new.png', new Uint8Array([4, 5]));

			expect(ensureSpy).toHaveBeenCalledWith('images/new.png');
			expect(app.vault.createBinary).toHaveBeenCalledWith('images/new.png', buffer);
		});
	});

	describe('ensureParentFolders', () => {
		it('creates a nested folder structure when parent folders are missing', async () => {
			const { internals, app, vaultEntries } = createExecutorContext();
			app.vault.getAbstractFileByPath.mockImplementation((path: string) => vaultEntries.get(path) ?? null);

			await internals.ensureParentFolders('a/b/c.md');

			expect(app.vault.createFolder).toHaveBeenNthCalledWith(1, 'a');
			expect(app.vault.createFolder).toHaveBeenNthCalledWith(2, 'a/b');
		});

		it('skips folders that already exist', async () => {
			const { internals, addFolder, app, vaultEntries } = createExecutorContext();
			addFolder('a');
			app.vault.getAbstractFileByPath.mockImplementation((path: string) => vaultEntries.get(path) ?? null);

			await internals.ensureParentFolders('a/b/c.md');

			expect(app.vault.createFolder).toHaveBeenCalledTimes(1);
			expect(app.vault.createFolder).toHaveBeenCalledWith('a/b');
		});

		it('does nothing for root-level files', async () => {
			const { internals, app } = createExecutorContext();

			await internals.ensureParentFolders('root.md');

			expect(app.vault.createFolder).not.toHaveBeenCalled();
		});
	});

	describe('guessContentType', () => {
		it('returns a text content type for markdown files', () => {
			const { internals } = createExecutorContext();

			expect(internals.guessContentType('notes/test.md')).toBe('text/plain; charset=utf-8');
		});

		it('returns an octet-stream content type for binary files', () => {
			const { internals } = createExecutorContext();

			expect(internals.guessContentType('images/test.png')).toBe('application/octet-stream');
		});
	});

	describe('toSyncError', () => {
		it('converts Error objects into recoverable SyncError values', () => {
			const { internals } = createExecutorContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const error = internals.toSyncError('notes/test.md', 'upload', new Error('broken'));

			expect(error).toEqual({
				path: 'notes/test.md',
				action: 'upload',
				message: 'broken',
				recoverable: true,
			});
			expect(consoleErrorSpy).toHaveBeenCalledWith('[S3 Sync] upload failed for notes/test.md: broken');

			consoleErrorSpy.mockRestore();
		});

		it('uses a generic message for non-Error throwables', () => {
			const { internals } = createExecutorContext();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const error = internals.toSyncError('notes/test.md', 'download', 'unexpected');

			expect(error.message).toBe('Unknown error');
			expect(consoleErrorSpy).toHaveBeenCalledWith('[S3 Sync] download failed for notes/test.md: Unknown error');

			consoleErrorSpy.mockRestore();
		});
	});

	describe('log', () => {
		it('writes debug logs when debug logging is enabled', () => {
			const { internals } = createExecutorContext(true);
			const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

			internals.log('hello');

			expect(debugSpy).toHaveBeenCalledWith('[S3 Sync] hello');
			debugSpy.mockRestore();
		});

		it('does not write debug logs when debug logging is disabled', () => {
			const { internals } = createExecutorContext(false);
			const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

			internals.log('hello');

			expect(debugSpy).not.toHaveBeenCalled();
			debugSpy.mockRestore();
		});
	});
});
