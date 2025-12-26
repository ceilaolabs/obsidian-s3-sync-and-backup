/**
 * Status Bar Module
 *
 * Provides status bar integration for displaying sync and backup status.
 * Shows current state with icons and relative time since last operation.
 */

import { Plugin } from 'obsidian';
import { SyncState, BackupState } from './types';

/**
 * Status icons for different states
 */
const SYNC_ICONS: Record<string, string> = {
    synced: '✓',
    syncing: '↻',
    error: '!',
    conflicts: '⚠',
    disabled: '○',
    paused: '⏸',
};

const BACKUP_ICONS: Record<string, string> = {
    completed: '✓',
    running: '↻',
    error: '!',
    disabled: '○',
};

/**
 * Format milliseconds into relative time string
 *
 * @param timestamp - Epoch timestamp in milliseconds
 * @returns Relative time string (e.g., "2m ago", "3h ago")
 */
export function formatRelativeTime(timestamp: number | null): string {
    if (!timestamp) return '';

    const now = Date.now();
    const diff = now - timestamp;

    // Less than 1 minute
    if (diff < 60 * 1000) {
        return 'just now';
    }

    // Minutes (1-59)
    if (diff < 60 * 60 * 1000) {
        const minutes = Math.floor(diff / (60 * 1000));
        return `${minutes}m ago`;
    }

    // Hours (1-23)
    if (diff < 24 * 60 * 60 * 1000) {
        const hours = Math.floor(diff / (60 * 60 * 1000));
        return `${hours}h ago`;
    }

    // Days (1-6)
    if (diff < 7 * 24 * 60 * 60 * 1000) {
        const days = Math.floor(diff / (24 * 60 * 60 * 1000));
        return `${days}d ago`;
    }

    // Weeks
    return '1w+ ago';
}

/**
 * StatusBar class - Manages status bar display
 */
export class StatusBar {
    private plugin: Plugin;
    private statusBarEl: HTMLElement | null = null;
    private syncState: SyncState;
    private backupState: BackupState;

    constructor(plugin: Plugin) {
        this.plugin = plugin;

        // Initialize with default states
        this.syncState = {
            status: 'disabled',
            lastSyncTime: null,
            conflictCount: 0,
            isSyncing: false,
            lastError: null,
        };

        this.backupState = {
            status: 'disabled',
            lastBackupTime: null,
            isRunning: false,
            lastError: null,
        };
    }

    /**
     * Initialize the status bar element
     * Call this in plugin's onload()
     */
    init(): void {
        this.statusBarEl = this.plugin.addStatusBarItem();
        this.statusBarEl.addClass('s3-sync-backup-status');
        this.update();

        // Add click handlers
        this.statusBarEl.addEventListener('click', this.handleClick.bind(this));
    }

    /**
     * Update sync state
     */
    updateSyncState(state: Partial<SyncState>): void {
        this.syncState = { ...this.syncState, ...state };
        this.update();
    }

    /**
     * Update backup state
     */
    updateBackupState(state: Partial<BackupState>): void {
        this.backupState = { ...this.backupState, ...state };
        this.update();
    }

    /**
     * Get sync status text for display
     */
    private getSyncStatusText(): string {
        const icon = SYNC_ICONS[this.syncState.status] || '?';

        switch (this.syncState.status) {
            case 'synced':
                return `Sync: ${icon} ${formatRelativeTime(this.syncState.lastSyncTime)}`;
            case 'syncing':
                return `Sync: ${icon}`;
            case 'error':
                return `Sync: ${icon}`;
            case 'conflicts':
                return `Sync: ${icon} ${this.syncState.conflictCount}`;
            case 'paused':
                return `Sync: ${icon}`;
            case 'disabled':
            default:
                return `Sync: ${icon}`;
        }
    }

    /**
     * Get backup status text for display
     */
    private getBackupStatusText(): string {
        const icon = BACKUP_ICONS[this.backupState.status] || '?';

        switch (this.backupState.status) {
            case 'completed':
                return `Backup: ${icon} ${formatRelativeTime(this.backupState.lastBackupTime)}`;
            case 'running':
                return `Backup: ${icon}`;
            case 'error':
                return `Backup: ${icon}`;
            case 'disabled':
            default:
                return `Backup: ${icon}`;
        }
    }

    /**
     * Update status bar display
     */
    private update(): void {
        if (!this.statusBarEl) return;

        const syncText = this.getSyncStatusText();
        const backupText = this.getBackupStatusText();

        this.statusBarEl.setText(`${syncText} | ${backupText}`);

        // Update tooltip
        this.statusBarEl.setAttribute('aria-label', this.getTooltipContent());
    }

    /**
     * Generate tooltip content
     */
    private getTooltipContent(): string {
        const lines: string[] = [
            'S3 Sync & Backup Status',
            '',
            `Sync: ${this.syncState.status}`,
        ];

        if (this.syncState.lastSyncTime) {
            lines.push(`  Last: ${new Date(this.syncState.lastSyncTime).toLocaleString()}`);
        }

        if (this.syncState.conflictCount > 0) {
            lines.push(`  Conflicts: ${this.syncState.conflictCount}`);
        }

        if (this.syncState.lastError) {
            lines.push(`  Error: ${this.syncState.lastError}`);
        }

        lines.push('');
        lines.push(`Backup: ${this.backupState.status}`);

        if (this.backupState.lastBackupTime) {
            lines.push(`  Last: ${new Date(this.backupState.lastBackupTime).toLocaleString()}`);
        }

        if (this.backupState.lastError) {
            lines.push(`  Error: ${this.backupState.lastError}`);
        }

        lines.push('');
        lines.push('Click to sync/backup manually');

        return lines.join('\n');
    }

    /**
     * Handle click on status bar
     * Left click triggers sync, right click opens context menu
     */
    private handleClick(event: MouseEvent): void {
        // For now, just dispatch a custom event that main.ts can listen to
        // This will be connected to the actual sync/backup triggers later
        if (event.button === 0) {
            // Left click - trigger sync
            this.statusBarEl?.dispatchEvent(new CustomEvent('s3-sync-trigger'));
        }
    }

    /**
     * Cleanup
     */
    destroy(): void {
        if (this.statusBarEl) {
            this.statusBarEl.remove();
            this.statusBarEl = null;
        }
    }
}
