/**
 * Status Bar Module
 *
 * Renders compact sync and backup indicators in the Obsidian status bar.
 */

import { Plugin, setIcon, setTooltip } from 'obsidian';
import { BackupState, BackupStatus, SyncState, SyncStatus } from './types';
import { formatRelativeTime } from './utils/time';

/**
 * Intent emitted by a status segment click.
 */
export type StatusBarAction = 'sync' | 'backup';

interface StatusIndicatorSpec {
    icon: string;
    label: string;
    emoji: string;
}

const SYNC_STATUS_SPEC: Record<SyncStatus, StatusIndicatorSpec> = {
    idle: { icon: 'cloud', label: 'Ready', emoji: '☁️' },
    synced: { icon: 'check', label: 'Synced', emoji: '✓' },
    syncing: { icon: 'refresh-cw', label: 'Syncing', emoji: '↻' },
    error: { icon: 'x', label: 'Error', emoji: '✕' },
    conflicts: { icon: 'alert-triangle', label: 'Conflict', emoji: '⚠' },
    disabled: { icon: 'circle-off', label: 'Off', emoji: '○' },
    paused: { icon: 'pause', label: 'Paused', emoji: '⏸' },
};

const BACKUP_STATUS_SPEC: Record<BackupStatus, StatusIndicatorSpec> = {
    idle: { icon: 'archive', label: 'Ready', emoji: '📦' },
    completed: { icon: 'check', label: 'Done', emoji: '✓' },
    running: { icon: 'refresh-cw', label: 'Running', emoji: '↻' },
    error: { icon: 'x', label: 'Error', emoji: '✕' },
    disabled: { icon: 'circle-off', label: 'Off', emoji: '○' },
};

/**
 * StatusBar class - manages the bottom bar display.
 */
export class StatusBar {
    private statusBarEl: HTMLElement | null = null;
    private syncSegmentEl: HTMLElement | null = null;
    private backupSegmentEl: HTMLElement | null = null;
    private syncIconEl: HTMLElement | null = null;
    private syncTextEl: HTMLElement | null = null;
    private backupIconEl: HTMLElement | null = null;
    private backupTextEl: HTMLElement | null = null;
    private actionHandler?: (action: StatusBarAction) => void;

    private syncState: SyncState = {
        status: 'disabled',
        lastSyncTime: null,
        conflictCount: 0,
        isSyncing: false,
        lastError: null,
    };

    private backupState: BackupState = {
        status: 'disabled',
        lastBackupTime: null,
        isRunning: false,
        lastError: null,
    };

    constructor(private plugin: Plugin) {}

    /**
     * Set the action handler invoked by click interactions.
     */
    setActionHandler(handler: (action: StatusBarAction) => void): void {
        this.actionHandler = handler;
    }

    /**
     * Initialize the status bar.
     */
    init(): void {
        this.statusBarEl = this.plugin.addStatusBarItem();
        this.statusBarEl.addClass('s3-sync-backup-status');
        this.statusBarEl.empty();

        this.syncSegmentEl = this.createSegment('sync');
        this.backupSegmentEl = this.createSegment('backup');
        this.update();
    }

    /**
     * Update the sync state.
     */
    updateSyncState(state: Partial<SyncState>): void {
        this.syncState = { ...this.syncState, ...state };
        this.update();
    }

    /**
     * Update the backup state.
     */
    updateBackupState(state: Partial<BackupState>): void {
        this.backupState = { ...this.backupState, ...state };
        this.update();
    }

    /**
     * Destroy the status bar.
     */
    destroy(): void {
        this.statusBarEl?.remove();
        this.statusBarEl = null;
        this.syncSegmentEl = null;
        this.backupSegmentEl = null;
        this.syncIconEl = null;
        this.syncTextEl = null;
        this.backupIconEl = null;
        this.backupTextEl = null;
    }

    /**
     * Create a clickable sync or backup segment.
     */
    private createSegment(type: StatusBarAction): HTMLElement {
        const segment = this.statusBarEl!.createDiv({ cls: `s3-sync-backup-segment s3-sync-backup-${type}` });
        segment.tabIndex = 0;

        const iconEl = segment.createSpan({ cls: 's3-sync-backup-icon' });
        const textEl = segment.createSpan({ cls: 's3-sync-backup-text' });

        if (type === 'sync') {
            this.syncIconEl = iconEl;
            this.syncTextEl = textEl;
        } else {
            this.backupIconEl = iconEl;
            this.backupTextEl = textEl;
        }

        segment.addEventListener('click', () => {
            this.actionHandler?.(type);
        });
        segment.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.actionHandler?.(type);
            }
        });

        return segment;
    }

    /**
     * Render the current states.
     */
    private update(): void {
        if (!this.statusBarEl || !this.syncSegmentEl || !this.backupSegmentEl) {
            return;
        }

        this.renderSync();
        this.renderBackup();
        setTooltip(this.statusBarEl, this.getTooltipContent());
    }

    /**
     * Render the sync segment.
     */
    private renderSync(): void {
        if (!this.syncSegmentEl || !this.syncIconEl || !this.syncTextEl) {
            return;
        }

        const spec = SYNC_STATUS_SPEC[this.syncState.status];
        this.syncSegmentEl.className = `s3-sync-backup-segment s3-sync-backup-sync is-${this.syncState.status}`;

        this.renderIcon(this.syncIconEl, spec);
        const suffix = this.syncState.status === 'conflicts'
            ? ` ${this.syncState.conflictCount}`
            : this.syncState.lastSyncTime
                ? ` ${formatRelativeTime(this.syncState.lastSyncTime)}`
                : '';
        this.syncTextEl.setText(`Sync ${spec.label}${suffix}`.trim());
    }

    /**
     * Render the backup segment.
     */
    private renderBackup(): void {
        if (!this.backupSegmentEl || !this.backupIconEl || !this.backupTextEl) {
            return;
        }

        const spec = BACKUP_STATUS_SPEC[this.backupState.status];
        this.backupSegmentEl.className = `s3-sync-backup-segment s3-sync-backup-backup is-${this.backupState.status}`;

        this.renderIcon(this.backupIconEl, spec);
        const suffix = this.backupState.lastBackupTime ? ` ${formatRelativeTime(this.backupState.lastBackupTime)}` : '';
        this.backupTextEl.setText(`Backup ${spec.label}${suffix}`.trim());
    }

    /**
     * Render an icon using Obsidian icons with an emoji fallback.
     */
    private renderIcon(target: HTMLElement, spec: StatusIndicatorSpec): void {
        target.empty();
        try {
            setIcon(target, spec.icon);
        } catch {
            target.setText(spec.emoji);
        }
    }

    /**
     * Generate tooltip content.
     */
    private getTooltipContent(): string {
        const lines = [
            'S3 Sync & Backup',
            '',
            `Sync: ${SYNC_STATUS_SPEC[this.syncState.status].label}`,
        ];

        if (this.syncState.lastSyncTime) {
            lines.push(`Last sync: ${new Date(this.syncState.lastSyncTime).toLocaleString()}`);
        }
        if (this.syncState.conflictCount > 0) {
            lines.push(`Conflicts: ${this.syncState.conflictCount}`);
        }
        if (this.syncState.lastError) {
            lines.push(`Sync error: ${this.syncState.lastError}`);
        }

        lines.push('');
        lines.push(`Backup: ${BACKUP_STATUS_SPEC[this.backupState.status].label}`);
        if (this.backupState.lastBackupTime) {
            lines.push(`Last backup: ${new Date(this.backupState.lastBackupTime).toLocaleString()}`);
        }
        if (this.backupState.lastError) {
            lines.push(`Backup error: ${this.backupState.lastError}`);
        }

        lines.push('');
        lines.push('Click Sync to run sync now');
        lines.push('Click Backup to run backup now');

        return lines.join('\n');
    }
}
