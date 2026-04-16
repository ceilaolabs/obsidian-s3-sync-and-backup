/**
 * Tracks local vault file events and maintains a set of "dirty" paths
 * that have changed since the last sync.
 *
 * In the v2 architecture the ChangeTracker no longer writes to the journal
 * or hashes file content.  It simply records which paths were created,
 * modified, deleted, or renamed so the SyncPlanner can prioritise them
 * during the next sync cycle.
 *
 * ## Dirty-path tracking pattern
 * Vault events (create/modify/delete/rename) are forwarded to `dirtyPaths`.
 * The SyncPlanner reads this set at the start of each sync cycle; the
 * SyncExecutor calls `clearPath()` once a file has been successfully synced.
 *
 * ## Deferred-dirty mechanism during sync
 * While a sync is running (`isSyncRunning === true`) files that are actively
 * being written by the executor are registered via `markPathSyncing()`.
 * Any vault event that fires for a path currently in `syncingPaths` is
 * placed in `deferredDirty` instead of `dirtyPaths`.  When the sync
 * completes (`setSyncInProgress(false)`) the deferred set is flushed into
 * `dirtyPaths`, ensuring those files are re-evaluated on the next cycle
 * without triggering a spurious immediate re-sync.
 *
 * ## Sync-aware event filtering
 * Files matching user-configured exclude patterns or recognised as conflict
 * artefacts (`LOCAL_` / `REMOTE_` prefixes) are silently dropped by
 * `shouldExclude()`.  Only `TFile` events are processed — folder events
 * (`TFolder`) are ignored because S3 has no real folder concept.
 */

import { App, TFile, TAbstractFile } from 'obsidian';
import { isConflictFile, matchesAnyGlob, isPluginOwnPath } from '../utils/paths';

/**
 * Listens to Obsidian vault events and maintains a live set of file paths
 * that are "dirty" (created, modified, deleted, or renamed) since the last
 * sync cycle.
 *
 * Consumers interact with this class as follows:
 * 1. Call `startTracking()` after the plugin loads to begin listening.
 * 2. Before each sync, check `hasDirtyPaths()` / `getDirtyPaths()`.
 * 3. Call `setSyncInProgress(true)` at sync start and `(false)` at end.
 * 4. Call `markPathSyncing(path)` for each file the executor writes so that
 *    write-echo events are deferred rather than queued as new dirty paths.
 * 5. Call `clearPath(path)` after each file is successfully synced.
 * 6. Call `stopTracking()` during plugin unload.
 */
export class ChangeTracker {
	private app: App;
	private dirtyPaths: Set<string> = new Set();
	private excludePatterns: string[] = [];
	private isTracking = false;

	private syncingPaths: Set<string> = new Set();
	private isSyncRunning = false;
	private deferredDirty: Set<string> = new Set();

	private onCreateHandler: (file: TAbstractFile) => void;
	private onModifyHandler: (file: TAbstractFile) => void;
	private onDeleteHandler: (file: TAbstractFile) => void;
	private onRenameHandler: (file: TAbstractFile, oldPath: string) => void;

	/**
	 * Creates a new ChangeTracker bound to the given Obsidian application.
	 *
	 * Event handler functions are bound here (rather than inline in
	 * `startTracking`) so the same references can be passed to both
	 * `vault.on()` and `vault.off()` — Obsidian requires identical function
	 * references to successfully deregister a listener.
	 *
	 * @param app - The Obsidian `App` instance used to subscribe to vault events.
	 */
	constructor(app: App) {
		this.app = app;
		this.onCreateHandler = (file) => this.onEvent(file);
		this.onModifyHandler = (file) => this.onEvent(file);
		this.onDeleteHandler = (file) => this.onEvent(file);
		this.onRenameHandler = (file, oldPath) => this.onRenameEvent(file, oldPath);
	}

	/**
	 * Begins listening to vault events and populating the dirty-paths set.
	 *
	 * Calling this method more than once without an intervening `stopTracking`
	 * is a no-op — duplicate listeners are not registered.
	 *
	 * @param excludePatterns - Glob patterns for paths that should never be
	 *   considered dirty (e.g. globs matching `.DS_Store` or `.obsidian` files).
	 */
	startTracking(excludePatterns: string[] = []): void {
		if (this.isTracking) return;
		this.excludePatterns = excludePatterns;
		this.isTracking = true;

		this.app.vault.on('create', this.onCreateHandler);
		this.app.vault.on('modify', this.onModifyHandler);
		this.app.vault.on('delete', this.onDeleteHandler);
		this.app.vault.on('rename', this.onRenameHandler);
	}

	/**
	 * Detaches all vault event listeners and stops populating dirty paths.
	 *
	 * Safe to call when tracking is already stopped.
	 */
	stopTracking(): void {
		if (!this.isTracking) return;
		this.isTracking = false;

		this.app.vault.off('create', this.onCreateHandler);
		this.app.vault.off('modify', this.onModifyHandler);
		this.app.vault.off('delete', this.onDeleteHandler);
		this.app.vault.off('rename', this.onRenameHandler);
	}

	/**
	 * Notifies the tracker whether a sync operation is currently running.
	 *
	 * When `inProgress` transitions to `false` (sync finished):
	 * - `syncingPaths` is cleared (the executor is no longer writing).
	 * - All paths in `deferredDirty` are promoted to `dirtyPaths` so they
	 *   are re-evaluated in the next sync cycle.
	 *
	 * @param inProgress - `true` when a sync begins, `false` when it ends.
	 */
	setSyncInProgress(inProgress: boolean): void {
		this.isSyncRunning = inProgress;
		if (!inProgress) {
			this.syncingPaths.clear();
			for (const path of this.deferredDirty) {
				this.dirtyPaths.add(path);
			}
			this.deferredDirty.clear();
		}
	}

	/**
	 * Registers a path as currently being written by the sync executor.
	 *
	 * Any vault event that fires for this path while it is in `syncingPaths`
	 * will be deferred rather than added to `dirtyPaths`, preventing the
	 * executor's own writes from triggering an immediate re-sync loop.
	 *
	 * @param path - The vault-relative path being actively written.
	 */
	markPathSyncing(path: string): void {
		this.syncingPaths.add(path);
	}

	/**
	 * Returns a read-only view of the current set of dirty vault paths.
	 *
	 * The set includes any file that was created, modified, deleted, or
	 * renamed since the last time the corresponding path was cleared.
	 *
	 * @returns A `ReadonlySet` of vault-relative dirty paths.
	 */
	getDirtyPaths(): ReadonlySet<string> {
		return this.dirtyPaths;
	}

	/**
	 * Returns `true` when there is at least one path pending sync.
	 *
	 * Callers (e.g. `SyncPlanner`) can use this as a cheap short-circuit
	 * before iterating the full dirty set.
	 *
	 * @returns `true` if one or more paths are dirty, `false` otherwise.
	 */
	hasDirtyPaths(): boolean {
		return this.dirtyPaths.size > 0;
	}

	/**
	 * Removes a single path from the dirty set after it has been synced.
	 *
	 * @param path - The vault-relative path to mark as clean.
	 */
	clearPath(path: string): void {
		this.dirtyPaths.delete(path);
	}

	/**
	 * Clears all dirty paths, discarding any accumulated change information.
	 *
	 * Typically called when a full sync completes and the entire local state
	 * has been reconciled with the remote.
	 */
	clearAll(): void {
		this.dirtyPaths.clear();
	}

	/**
	 * Replaces the current exclude pattern list with a new set of glob
	 * patterns.  Future events will be filtered against the updated list.
	 *
	 * @param patterns - New array of glob patterns to exclude from tracking.
	 */
	updateExcludePatterns(patterns: string[]): void {
		this.excludePatterns = patterns;
	}

	/**
	 * Handles create, modify, and delete vault events.
	 *
	 * Folders (`TFolder`) are silently ignored because S3 has no native
	 * directory concept and folder events carry no file content.
	 *
	 * If the file is currently being written by the executor (`syncingPaths`),
	 * the path is deferred to avoid re-triggering sync for files the executor
	 * is actively writing — those write-echo events would otherwise cause an
	 * unnecessary re-sync of a file that was just synced.
	 *
	 * @param file - The `TAbstractFile` emitted by the vault event.
	 */
	private onEvent(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		if (this.shouldExclude(file.path)) return;

		// If the executor is currently writing this path, defer the event so
		// the write-echo does not cause an immediate re-sync of the same file.
		if (this.syncingPaths.has(file.path)) {
			this.deferredDirty.add(file.path);
			return;
		}

		this.dirtyPaths.add(file.path);
	}

	/**
	 * Handles vault rename events, marking both the old and new paths dirty.
	 *
	 * Both paths must be tracked because:
	 * - The **old path** needs to be deleted from S3 (it no longer exists locally).
	 * - The **new path** needs to be uploaded to S3 (it is a new or moved file).
	 *
	 * Each path is independently tested against the exclude patterns so that,
	 * for example, a rename into an excluded directory only marks the old path
	 * dirty and vice-versa.
	 *
	 * The new path additionally respects the deferred-dirty mechanism in case
	 * the executor is concurrently writing it.
	 *
	 * @param file    - The `TAbstractFile` at its new path after the rename.
	 * @param oldPath - The vault-relative path before the rename.
	 */
	private onRenameEvent(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) return;

		const excludeOld = this.shouldExclude(oldPath);
		const excludeNew = this.shouldExclude(file.path);

		// Mark the old path dirty so the SyncPlanner knows to remove it from S3.
		if (!excludeOld) {
			this.dirtyPaths.add(oldPath);
		}

		// Mark the new path dirty so the SyncPlanner knows to upload the renamed file.
		if (!excludeNew) {
			if (this.syncingPaths.has(file.path)) {
				this.deferredDirty.add(file.path);
			} else {
				this.dirtyPaths.add(file.path);
			}
		}
	}

	/**
	 * Returns `true` if `path` should be silently ignored by the tracker.
	 *
	 * A path is excluded when it is a conflict artefact (prefixed with
	 * `LOCAL_` or `REMOTE_`) or when it matches one of the user-configured
	 * glob exclude patterns.
	 *
	 * @param path - The vault-relative path to test.
	 * @returns `true` if the path should be excluded from dirty tracking.
	 */
	private shouldExclude(path: string): boolean {
		return isConflictFile(path)
			|| isPluginOwnPath(path, this.app.vault.configDir)
			|| matchesAnyGlob(path, this.excludePatterns);
	}
}
