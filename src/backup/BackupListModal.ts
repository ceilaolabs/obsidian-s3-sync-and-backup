/**
 * Backup List Modal
 *
 * Displays the latest backup snapshots from S3 in a modal dialog with per-backup
 * download buttons. Uses {@link RetentionManager.listBackups} to discover backups
 * and {@link BackupDownloader.triggerDownload} to export selected backups as ZIP files.
 *
 * Shows up to {@link MAX_DISPLAYED_BACKUPS} (5) most recent backups sorted newest-first.
 * Each row displays the backup timestamp, file count, total size, encryption status,
 * and a download button.
 */

import { App, Modal, Notice } from 'obsidian';
import type { BackupInfo } from '../types';
import type { RetentionManager } from './RetentionManager';
import type { BackupDownloader } from './BackupDownloader';
import { formatBytes } from '../utils/time';

/** Maximum number of backups to display in the modal. */
const MAX_DISPLAYED_BACKUPS = 5;

/**
 * Modal that lists recent backup snapshots and provides per-backup ZIP download.
 *
 * Opened from the Backup settings section ("View backups" button) or the
 * "View backups" command palette entry. Fetches backup metadata from S3 on open,
 * shows a loading indicator while the request is in flight, and renders a list
 * of backup rows on success or an error message on failure.
 *
 * @example
 * ```typescript
 * const modal = new BackupListModal(app, retentionManager, backupDownloader);
 * modal.open();
 * ```
 */
export class BackupListModal extends Modal {
	private retentionManager: RetentionManager;
	private backupDownloader: BackupDownloader;
	private downloadingBackups: Set<string> = new Set();

	constructor(app: App, retentionManager: RetentionManager, backupDownloader: BackupDownloader) {
		super(app);
		this.retentionManager = retentionManager;
		this.backupDownloader = backupDownloader;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass('s3-backup-list-modal');

		contentEl.createEl('h2', { text: 'Recent backups' });

		const listContainer = contentEl.createDiv({ cls: 's3-backup-list-container' });
		listContainer.createEl('p', { text: 'Loading backups...', cls: 's3-backup-list-loading' });

		try {
			const backups = await this.retentionManager.listBackups();

			// Sort newest first and take the top N
			backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
			const displayed = backups.slice(0, MAX_DISPLAYED_BACKUPS);

			listContainer.empty();

			if (displayed.length === 0) {
				listContainer.createEl('p', {
					text: 'No backups found',
					cls: 's3-backup-list-empty',
				});
				return;
			}

			this.renderBackupList(listContainer, displayed, backups.length);
		} catch (error) {
			listContainer.empty();
			const message = error instanceof Error ? error.message : 'Unknown error';
			listContainer.createEl('p', {
				text: `Failed to load backups: ${message}`,
				cls: 's3-backup-list-error',
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderBackupList(container: HTMLElement, backups: BackupInfo[], totalCount: number): void {
		for (const backup of backups) {
			this.renderBackupRow(container, backup);
		}

		if (totalCount > MAX_DISPLAYED_BACKUPS) {
			container.createEl('p', {
				text: `Showing ${MAX_DISPLAYED_BACKUPS} of ${totalCount} backups`,
				cls: 's3-backup-list-footer',
			});
		}
	}

	private renderBackupRow(container: HTMLElement, backup: BackupInfo): void {
		const row = container.createDiv({ cls: 's3-backup-row' });

		const info = row.createDiv({ cls: 's3-backup-row-info' });

		// Timestamp as readable date
		const date = new Date(backup.timestamp);
		info.createEl('div', {
			text: date.toLocaleString(),
			cls: 's3-backup-row-date',
		});

		// Metadata line: file count, size, encryption
		const meta: string[] = [];
		meta.push(`${backup.fileCount} files`);
		meta.push(formatBytes(backup.totalSize));
		if (backup.encrypted) {
			meta.push('encrypted');
		}
		info.createEl('div', {
			text: meta.join(' · '),
			cls: 's3-backup-row-meta',
		});

		// Download button
		const actions = row.createDiv({ cls: 's3-backup-row-actions' });
		const downloadBtn = actions.createEl('button', { text: 'Download zip' });
		downloadBtn.addEventListener('click', () => {
			void this.handleDownload(backup.name, downloadBtn);
		});
	}

	private async handleDownload(backupName: string, button: HTMLButtonElement): Promise<void> {
		if (this.downloadingBackups.has(backupName)) return;

		this.downloadingBackups.add(backupName);
		const originalText = button.textContent ?? 'Download ZIP';
		button.textContent = 'Downloading...';
		button.disabled = true;

		try {
			await this.backupDownloader.triggerDownload(backupName);
			new Notice(`Backup downloaded: ${backupName}.zip`);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`Download failed: ${message}`);
		} finally {
			this.downloadingBackups.delete(backupName);
			button.textContent = originalText;
			button.disabled = false;
		}
	}
}
