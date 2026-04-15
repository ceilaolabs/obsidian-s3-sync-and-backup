/**
 * Tracks local vault file events and maintains a set of "dirty" paths
 * that have changed since the last sync.
 *
 * In the v2 architecture the ChangeTracker no longer writes to the journal
 * or hashes file content.  It simply records which paths were created,
 * modified, deleted, or renamed so the SyncPlanner can prioritise them
 * during the next sync cycle.
 */

import { App, TFile, TAbstractFile } from 'obsidian';
import { isConflictFile, matchesAnyGlob } from '../utils/paths';

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

	constructor(app: App) {
		this.app = app;
		this.onCreateHandler = (file) => this.onEvent(file);
		this.onModifyHandler = (file) => this.onEvent(file);
		this.onDeleteHandler = (file) => this.onEvent(file);
		this.onRenameHandler = (file, oldPath) => this.onRenameEvent(file, oldPath);
	}

	startTracking(excludePatterns: string[] = []): void {
		if (this.isTracking) return;
		this.excludePatterns = excludePatterns;
		this.isTracking = true;

		this.app.vault.on('create', this.onCreateHandler);
		this.app.vault.on('modify', this.onModifyHandler);
		this.app.vault.on('delete', this.onDeleteHandler);
		this.app.vault.on('rename', this.onRenameHandler);
	}

	stopTracking(): void {
		if (!this.isTracking) return;
		this.isTracking = false;

		this.app.vault.off('create', this.onCreateHandler);
		this.app.vault.off('modify', this.onModifyHandler);
		this.app.vault.off('delete', this.onDeleteHandler);
		this.app.vault.off('rename', this.onRenameHandler);
	}

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

	markPathSyncing(path: string): void {
		this.syncingPaths.add(path);
	}

	getDirtyPaths(): ReadonlySet<string> {
		return this.dirtyPaths;
	}

	hasDirtyPaths(): boolean {
		return this.dirtyPaths.size > 0;
	}

	clearPath(path: string): void {
		this.dirtyPaths.delete(path);
	}

	clearAll(): void {
		this.dirtyPaths.clear();
	}

	updateExcludePatterns(patterns: string[]): void {
		this.excludePatterns = patterns;
	}

	private onEvent(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		if (this.shouldExclude(file.path)) return;

		if (this.syncingPaths.has(file.path)) {
			this.deferredDirty.add(file.path);
			return;
		}

		this.dirtyPaths.add(file.path);
	}

	private onRenameEvent(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) return;

		const excludeOld = this.shouldExclude(oldPath);
		const excludeNew = this.shouldExclude(file.path);

		if (!excludeOld) {
			this.dirtyPaths.add(oldPath);
		}

		if (!excludeNew) {
			if (this.syncingPaths.has(file.path)) {
				this.deferredDirty.add(file.path);
			} else {
				this.dirtyPaths.add(file.path);
			}
		}
	}

	private shouldExclude(path: string): boolean {
		return isConflictFile(path) || matchesAnyGlob(path, this.excludePatterns);
	}
}
