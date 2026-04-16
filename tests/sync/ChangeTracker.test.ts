/**
 * Unit tests for the v2 ChangeTracker dirty-path tracker.
 *
 * These tests verify public behaviour only: event registration, path filtering,
 * dirty path bookkeeping, and deferred changes while sync is in progress.
 */

import { App, TFile, TFolder } from 'obsidian';
import { ChangeTracker } from '../../src/sync/ChangeTracker';

type VaultEventName = 'create' | 'modify' | 'delete' | 'rename';
type VaultEventCallback = (...args: unknown[]) => void;

interface MockVault {
	on: jest.Mock<void, [VaultEventName, VaultEventCallback]>;
	off: jest.Mock<void, [VaultEventName, VaultEventCallback]>;
}

type MockApp = App & {
	vault: MockVault;
};

/**
 * Creates the minimal App shape that ChangeTracker needs.
 */
const createMockApp = (): MockApp => ({
	vault: {
		on: jest.fn<void, [VaultEventName, VaultEventCallback]>(),
		off: jest.fn<void, [VaultEventName, VaultEventCallback]>(),
	},
}) as unknown as MockApp;

/**
 * Mock TFile implementation used for vault event payloads.
 */
class MockTFile extends TFile {
	constructor(path: string, mtime = Date.now()) {
		super();
		this.path = path;
		this.name = path.split('/').pop() || path;

		const dotIndex = this.name.lastIndexOf('.');
		this.basename = dotIndex > 0 ? this.name.slice(0, dotIndex) : this.name;
		this.extension = dotIndex > 0 ? this.name.slice(dotIndex + 1) : '';
		this.stat = {
			ctime: mtime,
			mtime,
			size: 0,
		};
	}
}

/**
 * Mock TFolder implementation to verify non-file events are ignored.
 */
class MockTFolder extends TFolder {
	constructor(path: string) {
		super();
		this.path = path;
		this.name = path.split('/').pop() || path;
	}
}

/**
 * Returns a registered vault event callback by name.
 */
function getRegisteredHandler(app: MockApp, eventName: VaultEventName): VaultEventCallback {
	const call = app.vault.on.mock.calls.find(([name]) => name === eventName);
	if (!call) {
		throw new Error(`No handler registered for ${eventName}`);
	}

	return call[1];
}

function emitCreate(app: MockApp, file: TFile | TFolder): void {
	getRegisteredHandler(app, 'create')(file);
}

function emitModify(app: MockApp, file: TFile | TFolder): void {
	getRegisteredHandler(app, 'modify')(file);
}

function emitDelete(app: MockApp, file: TFile | TFolder): void {
	getRegisteredHandler(app, 'delete')(file);
}

function emitRename(app: MockApp, file: TFile | TFolder, oldPath: string): void {
	getRegisteredHandler(app, 'rename')(file, oldPath);
}

function dirtyPaths(tracker: ChangeTracker): string[] {
	return Array.from(tracker.getDirtyPaths()).sort();
}

describe('ChangeTracker', () => {
	let app: MockApp;
	let tracker: ChangeTracker;

	beforeEach(() => {
		app = createMockApp();
		tracker = new ChangeTracker(app);
	});

	it('startTracking registers all vault handlers once and applies initial exclusions', () => {
		tracker.startTracking(['ignored/**']);
		tracker.startTracking(['other/**']);

		expect(app.vault.on).toHaveBeenCalledTimes(4);
		expect(app.vault.on).toHaveBeenNthCalledWith(1, 'create', expect.any(Function));
		expect(app.vault.on).toHaveBeenNthCalledWith(2, 'modify', expect.any(Function));
		expect(app.vault.on).toHaveBeenNthCalledWith(3, 'delete', expect.any(Function));
		expect(app.vault.on).toHaveBeenNthCalledWith(4, 'rename', expect.any(Function));

		emitCreate(app, new MockTFile('ignored/file.md'));
		emitCreate(app, new MockTFile('other/file.md'));

		expect(dirtyPaths(tracker)).toEqual(['other/file.md']);
	});

	it('stopTracking unregisters all vault handlers once', () => {
		tracker.startTracking();

		const handlers = new Map<VaultEventName, VaultEventCallback>(app.vault.on.mock.calls);

		tracker.stopTracking();
		tracker.stopTracking();

		expect(app.vault.off).toHaveBeenCalledTimes(4);
		expect(app.vault.off).toHaveBeenNthCalledWith(1, 'create', handlers.get('create'));
		expect(app.vault.off).toHaveBeenNthCalledWith(2, 'modify', handlers.get('modify'));
		expect(app.vault.off).toHaveBeenNthCalledWith(3, 'delete', handlers.get('delete'));
		expect(app.vault.off).toHaveBeenNthCalledWith(4, 'rename', handlers.get('rename'));
	});

	it('tracks create, modify, and delete events for files only', () => {
		tracker.startTracking();

		emitCreate(app, new MockTFile('notes/create.md'));
		emitModify(app, new MockTFile('notes/modify.md'));
		emitDelete(app, new MockTFile('notes/delete.md'));
		emitCreate(app, new MockTFolder('notes/folder'));
		emitModify(app, new MockTFile('notes/LOCAL_conflict.md'));

		expect(dirtyPaths(tracker)).toEqual([
			'notes/create.md',
			'notes/delete.md',
			'notes/modify.md',
		]);
	});

	it('tracks rename events for both old and new paths when neither is excluded', () => {
		tracker.startTracking();

		emitRename(app, new MockTFile('notes/new-name.md'), 'notes/old-name.md');

		expect(dirtyPaths(tracker)).toEqual(['notes/new-name.md', 'notes/old-name.md']);
	});

	it('ignores rename events for folders and respects old and new path exclusions', () => {
		tracker.startTracking(['ignored/**']);

		emitRename(app, new MockTFolder('notes/folder'), 'notes/old-folder');
		emitRename(app, new MockTFile('ignored/new.md'), 'notes/old.md');
		emitRename(app, new MockTFile('notes/new.md'), 'ignored/old.md');
		emitRename(app, new MockTFile('notes/REMOTE_conflict.md'), 'notes/original.md');
		emitRename(app, new MockTFile('notes/renamed.md'), 'notes/LOCAL_conflict.md');

		expect(dirtyPaths(tracker)).toEqual([
			'notes/new.md',
			'notes/old.md',
			'notes/original.md',
			'notes/renamed.md',
		]);
	});

	it('defers create and rename events for syncing paths until sync completes', () => {
		tracker.startTracking();
		tracker.setSyncInProgress(true);
		tracker.markPathSyncing('notes/syncing.md');
		tracker.markPathSyncing('notes/renamed-syncing.md');

		emitCreate(app, new MockTFile('notes/syncing.md'));
		emitRename(app, new MockTFile('notes/renamed-syncing.md'), 'notes/old-syncing.md');

		expect(tracker.hasDirtyPaths()).toBe(true);
		expect(dirtyPaths(tracker)).toEqual(['notes/old-syncing.md']);

		tracker.setSyncInProgress(false);

		expect(dirtyPaths(tracker)).toEqual([
			'notes/old-syncing.md',
			'notes/renamed-syncing.md',
			'notes/syncing.md',
		]);

		tracker.clearAll();
		emitModify(app, new MockTFile('notes/syncing.md'));

		expect(dirtyPaths(tracker)).toEqual(['notes/syncing.md']);
	});

	it('exposes and clears dirty path state through public helpers', () => {
		tracker.startTracking();
		emitDelete(app, new MockTFile('notes/one.md'));
		emitDelete(app, new MockTFile('notes/two.md'));

		expect(tracker.hasDirtyPaths()).toBe(true);
		expect(dirtyPaths(tracker)).toEqual(['notes/one.md', 'notes/two.md']);

		tracker.clearPath('notes/one.md');
		expect(dirtyPaths(tracker)).toEqual(['notes/two.md']);

		tracker.clearAll();
		expect(tracker.hasDirtyPaths()).toBe(false);
		expect(dirtyPaths(tracker)).toEqual([]);
	});

	it('updateExcludePatterns changes which subsequent events are ignored', () => {
		tracker.startTracking();
		tracker.updateExcludePatterns(['private/**']);

		emitModify(app, new MockTFile('private/secret.md'));
		emitModify(app, new MockTFile('public/note.md'));

		expect(dirtyPaths(tracker)).toEqual(['public/note.md']);
	});
});
