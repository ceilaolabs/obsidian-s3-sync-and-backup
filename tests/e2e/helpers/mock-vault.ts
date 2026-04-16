/**
 * Enhanced in-memory Obsidian Vault mock for E2E tests.
 *
 * Extends the basic mock from tests/__mocks__/obsidian.ts with full file system
 * semantics needed by SyncEngine, SyncPlanner, SyncExecutor, and SnapshotCreator:
 * - Binary file support (createBinary, readBinary, modifyBinary)
 * - getAbstractFileByPath lookups
 * - Folder creation
 * - File rename
 * - Event system (on/off/trigger) for ChangeTracker
 * - fileManager.trashFile for delete-local actions
 */

import { TFile, TFolder, FileStats } from 'obsidian';

/** In-memory file node with content stored as Uint8Array. */
class E2EFile extends TFile {
	content: Uint8Array;

	constructor(path: string, content: Uint8Array, mtime?: number) {
		super();
		this.path = path;
		this.content = content;

		const parts = path.split('/');
		this.name = parts[parts.length - 1];
		const dotIndex = this.name.lastIndexOf('.');
		this.basename = dotIndex > 0 ? this.name.substring(0, dotIndex) : this.name;
		this.extension = dotIndex > 0 ? this.name.substring(dotIndex + 1) : '';

		this.stat = {
			ctime: mtime ?? Date.now(),
			mtime: mtime ?? Date.now(),
			size: content.byteLength,
		} as FileStats;
	}

	updateContent(data: Uint8Array): void {
		this.content = data;
		this.stat = {
			...this.stat,
			mtime: Date.now(),
			size: data.byteLength,
		};
	}
}

class E2EFolder extends TFolder {
	constructor(path: string) {
		super();
		this.path = path;
		const parts = path.split('/');
		this.name = parts[parts.length - 1];
	}
}

type VaultEventName = 'create' | 'modify' | 'delete' | 'rename';
type VaultEventHandler = (...args: unknown[]) => void;

/**
 * Full in-memory Vault implementation for E2E pipeline tests.
 *
 * Provides all methods used by SyncEngine, SyncPlanner, SyncExecutor,
 * SnapshotCreator, and ChangeTracker.
 */
export class E2EVault {
	configDir = '.obsidian';
	private files = new Map<string, E2EFile>();
	private folders = new Set<string>();
	private listeners = new Map<VaultEventName, Set<VaultEventHandler>>();

	getName(): string { return 'E2ETestVault'; }

	getFiles(): TFile[] {
		return Array.from(this.files.values());
	}

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		const file = this.files.get(path);
		if (file) return file;
		if (this.folders.has(path)) return new E2EFolder(path);
		return null;
	}

	async read(file: TFile): Promise<string> {
		const f = this.files.get(file.path);
		if (!f) throw new Error(`File not found: ${file.path}`);
		return new TextDecoder().decode(f.content);
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const f = this.files.get(file.path);
		if (!f) throw new Error(`File not found: ${file.path}`);
		return f.content.buffer.slice(
			f.content.byteOffset,
			f.content.byteOffset + f.content.byteLength,
		);
	}

	async create(path: string, data: string): Promise<TFile> {
		const bytes = new TextEncoder().encode(data);
		const file = new E2EFile(path, bytes);
		this.files.set(path, file);
		this.emit('create', file);
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		const file = new E2EFile(path, new Uint8Array(data));
		this.files.set(path, file);
		this.emit('create', file);
		return file;
	}

	async modify(file: TFile, data: string): Promise<void> {
		const f = this.files.get(file.path);
		if (!f) throw new Error(`File not found: ${file.path}`);
		f.updateContent(new TextEncoder().encode(data));
		this.emit('modify', f);
	}

	async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
		const f = this.files.get(file.path);
		if (!f) throw new Error(`File not found: ${file.path}`);
		f.updateContent(new Uint8Array(data));
		this.emit('modify', f);
	}

	async delete(file: TFile): Promise<void> {
		this.files.delete(file.path);
		this.emit('delete', file);
	}

	async rename(file: TFile, newPath: string): Promise<void> {
		const f = this.files.get(file.path);
		if (!f) throw new Error(`File not found: ${file.path}`);
		this.files.delete(file.path);

		const renamed = new E2EFile(newPath, f.content, f.stat.mtime);
		this.files.set(newPath, renamed);
		this.emit('rename', renamed, file.path);
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const f = this.files.get(file.path);
		if (!f) throw new Error(`File not found: ${file.path}`);
		const current = new TextDecoder().decode(f.content);
		const result = fn(current);
		f.updateContent(new TextEncoder().encode(result));
		this.emit('modify', f);
		return result;
	}

	on(name: string, callback: VaultEventHandler): void {
		const eventName = name as VaultEventName;
		if (!this.listeners.has(eventName)) {
			this.listeners.set(eventName, new Set());
		}
		this.listeners.get(eventName)!.add(callback);
	}

	off(name: string, callback: VaultEventHandler): void {
		const eventName = name as VaultEventName;
		this.listeners.get(eventName)?.delete(callback);
	}

	/** Add a file directly (test setup helper, no events fired). */
	seed(path: string, content: string | Uint8Array, mtime?: number): TFile {
		const bytes = typeof content === 'string'
			? new TextEncoder().encode(content)
			: content;
		const file = new E2EFile(path, bytes, mtime);
		this.files.set(path, file);
		return file;
	}

	/** Remove all files and folders (test cleanup). */
	clear(): void {
		this.files.clear();
		this.folders.clear();
	}

	/** Check if a file exists. */
	has(path: string): boolean {
		return this.files.has(path);
	}

	private emit(event: VaultEventName, ...args: unknown[]): void {
		for (const handler of this.listeners.get(event) ?? []) {
			handler(...args);
		}
	}
}

/**
 * Minimal mock of Obsidian's App object for E2E tests.
 * Wraps E2EVault and provides a mock fileManager.
 */
export class E2EApp {
	vault: E2EVault;
	fileManager: { trashFile: (file: TFile) => Promise<void> };

	constructor(vault: E2EVault) {
		this.vault = vault;
		this.fileManager = {
			trashFile: async (file: TFile) => {
				await vault.delete(file);
			},
		};
	}
}
