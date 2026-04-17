/**
 * Unit tests for BackupListModal.
 *
 * These tests validate loading, empty, error, rendering, download, and cleanup
 * behavior for the backup list modal without testing RetentionManager or
 * BackupDownloader internals.
 */

jest.mock('obsidian');

jest.mock('../../src/backup/RetentionManager', () => ({
	RetentionManager: jest.fn(),
}));

jest.mock('../../src/backup/BackupDownloader', () => ({
	BackupDownloader: jest.fn(),
}));

import { App, Modal, Notice } from 'obsidian';
import { BackupListModal } from '../../src/backup/BackupListModal';
import { formatBytes } from '../../src/utils/time';
import type { BackupInfo } from '../../src/types';
import type { RetentionManager } from '../../src/backup/RetentionManager';
import type { BackupDownloader } from '../../src/backup/BackupDownloader';

interface MockRetentionManager {
	listBackups: jest.Mock<Promise<BackupInfo[]>, []>;
}

interface MockBackupDownloader {
	triggerDownload: jest.Mock<Promise<void>, [string]>;
}

interface ElementOptions {
	text?: string;
	cls?: string;
}

class MockElement {
	tagName: string;
	textContent: string | null;
	disabled = false;
	children: MockElement[] = [];
	classes: Set<string> = new Set();
	private listeners: Map<string, Array<() => void>> = new Map();

	constructor(tagName: string, options?: ElementOptions) {
		this.tagName = tagName;
		this.textContent = options?.text ?? null;
		if (options?.cls) {
			this.addClass(options.cls);
		}
	}

	addClass(cls: string): void {
		this.classes.add(cls);
	}

	createEl(tagName: string, options?: ElementOptions): MockElement {
		const child = new MockElement(tagName, options);
		this.children.push(child);
		return child;
	}

	createDiv(options?: ElementOptions): MockElement {
		return this.createEl('div', options);
	}

	empty(): void {
		this.children = [];
		this.textContent = null;
	}

	addEventListener(eventName: string, listener: () => void): void {
		const existing = this.listeners.get(eventName) ?? [];
		existing.push(listener);
		this.listeners.set(eventName, existing);
	}

	click(): void {
		for (const listener of this.listeners.get('click') ?? []) {
			listener();
		}
	}

	get className(): string {
		return Array.from(this.classes).join(' ');
	}

	collectByClass(className: string): MockElement[] {
		const matches: MockElement[] = this.classes.has(className) ? [this] : [];

		for (const child of this.children) {
			matches.push(...child.collectByClass(className));
		}

		return matches;
	}

	collectByTagName(tagName: string): MockElement[] {
		const matches: MockElement[] = this.tagName === tagName ? [this] : [];

		for (const child of this.children) {
			matches.push(...child.collectByTagName(tagName));
		}

		return matches;
	}

	collectText(): string[] {
		const values = this.textContent ? [this.textContent] : [];

		for (const child of this.children) {
			values.push(...child.collectText());
		}

		return values;
	}
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

function createBackup(overrides: Partial<BackupInfo>): BackupInfo {
	return {
		name: 'backup-2026-04-16T00-00-00',
		timestamp: '2026-04-16T00:00:00.000Z',
		fileCount: 1,
		totalSize: 512,
		encrypted: false,
		...overrides,
	};
}

function createMockRetentionManager(): MockRetentionManager {
	return {
		listBackups: jest.fn(),
	};
}

function createMockBackupDownloader(): MockBackupDownloader {
	return {
		triggerDownload: jest.fn(),
	};
}

function getTextsByClass(root: MockElement, className: string): string[] {
	return root.collectByClass(className).map((element) => element.textContent ?? '');
}

function flushPromises(): Promise<void> {
	return Promise.resolve();
}

function configureModalMock(): void {
	const mockedModal = Modal as unknown as jest.MockedClass<typeof Modal>;
	mockedModal.mockImplementation(function (this: Modal, app: App) {
		this.app = app;
		this.contentEl = new MockElement('div') as unknown as HTMLElement;
		return this;
	});
}

function createApp(): App {
	const actualObsidian = jest.requireActual('obsidian') as typeof import('obsidian');
	return new actualObsidian.App();
}

function createModal(backups: BackupInfo[] = []): {
	modal: BackupListModal;
	retentionManager: MockRetentionManager;
	backupDownloader: MockBackupDownloader;
	contentEl: MockElement;
} {
	const retentionManager = createMockRetentionManager();
	retentionManager.listBackups.mockResolvedValue(backups);
	const backupDownloader = createMockBackupDownloader();
	backupDownloader.triggerDownload.mockResolvedValue();
	const modal = new BackupListModal(
		createApp(),
		retentionManager as unknown as RetentionManager,
		backupDownloader as unknown as BackupDownloader,
	);

	return {
		modal,
		retentionManager,
		backupDownloader,
		contentEl: modal.contentEl as unknown as MockElement,
	};
}

/**
 * Covers modal lifecycle and user-facing backup list behavior.
 */
describe('BackupListModal', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		configureModalMock();
	});

	/**
	 * Covers the initial loading placeholder while the S3 listing is still pending.
	 */
	it('shows a loading state immediately when the modal opens', async () => {
		const deferred = createDeferred<BackupInfo[]>();
		const retentionManager = createMockRetentionManager();
		retentionManager.listBackups.mockReturnValue(deferred.promise);
		const backupDownloader = createMockBackupDownloader();
		backupDownloader.triggerDownload.mockResolvedValue();
		const modal = new BackupListModal(
			createApp(),
			retentionManager as unknown as RetentionManager,
			backupDownloader as unknown as BackupDownloader,
		);
		const contentEl = modal.contentEl as unknown as MockElement;

		const openPromise = modal.onOpen();

		expect(contentEl.classes.has('s3-backup-list-modal')).toBe(true);
		expect(contentEl.collectText()).toContain('Recent backups');
		expect(contentEl.collectText()).toContain('Loading backups...');

		deferred.resolve([]);
		await openPromise;
	});

	/**
	 * Covers successful rendering, sort order, truncation, row metadata, and footer text.
	 */
	it('lists the newest five backups first with row metadata and a footer when more backups exist', async () => {
		const backups = [
			createBackup({
				name: 'backup-1',
				timestamp: '2026-04-11T08:00:00.000Z',
				fileCount: 1,
				totalSize: 10,
			}),
			createBackup({
				name: 'backup-2',
				timestamp: '2026-04-16T08:00:00.000Z',
				fileCount: 2,
				totalSize: 2048,
				encrypted: true,
			}),
			createBackup({
				name: 'backup-3',
				timestamp: '2026-04-14T08:00:00.000Z',
				fileCount: 3,
				totalSize: 4096,
			}),
			createBackup({
				name: 'backup-4',
				timestamp: '2026-04-15T08:00:00.000Z',
				fileCount: 4,
				totalSize: 8192,
				encrypted: true,
			}),
			createBackup({
				name: 'backup-5',
				timestamp: '2026-04-13T08:00:00.000Z',
				fileCount: 5,
				totalSize: 16384,
			}),
			createBackup({
				name: 'backup-6',
				timestamp: '2026-04-12T08:00:00.000Z',
				fileCount: 6,
				totalSize: 32768,
			}),
		];
		const { modal, contentEl } = createModal(backups);

		await modal.onOpen();

		const sortedBackups = [...backups]
			.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
			.slice(0, 5);

		expect(contentEl.collectByClass('s3-backup-row')).toHaveLength(5);
		expect(getTextsByClass(contentEl, 's3-backup-row-date')).toEqual(
			sortedBackups.map((backup) => new Date(backup.timestamp).toLocaleString()),
		);
		expect(getTextsByClass(contentEl, 's3-backup-row-meta')).toEqual(
			sortedBackups.map((backup) => {
				const metadata = [`${backup.fileCount} files`, formatBytes(backup.totalSize)];
				if (backup.encrypted) {
					metadata.push('encrypted');
				}

				return metadata.join(' · ');
			}),
		);
		expect(getTextsByClass(contentEl, 's3-backup-list-footer')).toEqual(['Showing 5 of 6 backups']);
		expect(contentEl.collectByTagName('button')).toHaveLength(5);
		expect(contentEl.collectByTagName('button').every((button) => button.textContent === 'Download zip')).toBe(true);
	});

	/**
	 * Covers the empty-state message when S3 returns no backup snapshots.
	 */
	it('shows a no backups found message when no snapshots are available', async () => {
		const { modal, contentEl } = createModal([]);

		await modal.onOpen();

		expect(getTextsByClass(contentEl, 's3-backup-list-empty')).toEqual(['No backups found']);
		expect(contentEl.collectByClass('s3-backup-row')).toHaveLength(0);
	});

	/**
	 * Covers the error message rendered when backup discovery fails.
	 */
	it('shows an error message when listing backups fails', async () => {
		const retentionManager = createMockRetentionManager();
		retentionManager.listBackups.mockRejectedValue(new Error('S3 unavailable'));
		const backupDownloader = createMockBackupDownloader();
		backupDownloader.triggerDownload.mockResolvedValue();
		const modal = new BackupListModal(
			createApp(),
			retentionManager as unknown as RetentionManager,
			backupDownloader as unknown as BackupDownloader,
		);
		const contentEl = modal.contentEl as unknown as MockElement;

		await modal.onOpen();

		expect(getTextsByClass(contentEl, 's3-backup-list-error')).toEqual(['Failed to load backups: S3 unavailable']);
	});

	/**
	 * Covers successful download initiation, temporary disabled state, and double-click prevention.
	 */
	it('triggers downloads once per backup and restores the button state after completion', async () => {
		const deferred = createDeferred<void>();
		const backup = createBackup({
			name: 'backup-2026-04-16T08-00-00',
			timestamp: '2026-04-16T08:00:00.000Z',
		});
		const { modal, backupDownloader, contentEl } = createModal([backup]);
		backupDownloader.triggerDownload.mockReturnValue(deferred.promise);

		await modal.onOpen();
		const button = contentEl.collectByTagName('button')[0];

		button.click();
		button.click();

		expect(backupDownloader.triggerDownload).toHaveBeenCalledTimes(1);
		expect(backupDownloader.triggerDownload).toHaveBeenCalledWith('backup-2026-04-16T08-00-00');
		expect(button.textContent).toBe('Downloading...');
		expect(button.disabled).toBe(true);

		deferred.resolve();
		await flushPromises();

		expect(button.textContent).toBe('Download zip');
		expect(button.disabled).toBe(false);
		expect(Notice).toHaveBeenCalledWith('Backup downloaded: backup-2026-04-16T08-00-00.zip');
	});

	/**
	 * Covers failed download notices and button reset behavior after rejection.
	 */
	it('shows a notice and re-enables the button when a download fails', async () => {
		const backup = createBackup({ name: 'backup-2026-04-15T08-00-00' });
		const { modal, backupDownloader, contentEl } = createModal([backup]);
		backupDownloader.triggerDownload.mockRejectedValue(new Error('Network failed'));

		await modal.onOpen();
		const button = contentEl.collectByTagName('button')[0];

		button.click();
		await flushPromises();

		expect(button.textContent).toBe('Download zip');
		expect(button.disabled).toBe(false);
		expect(Notice).toHaveBeenCalledWith('Download failed: Network failed');
	});

	/**
	 * Covers modal cleanup when the dialog closes.
	 */
	it('empties its content element when the modal closes', async () => {
		const { modal, contentEl } = createModal([createBackup({ name: 'backup-1' })]);

		await modal.onOpen();
		expect(contentEl.children.length).toBeGreaterThan(0);

		modal.onClose();

		expect(contentEl.children).toHaveLength(0);
		expect(contentEl.collectText()).toEqual([]);
	});
});
