/**
 * Status Bar Module
 *
 * Renders compact sync and backup indicators in the Obsidian status bar.
 * The bar consists of two independent clickable segments:
 *   - **Sync segment** — shows current sync status (idle, syncing, error, conflicts,
 *     paused, disabled) with a time-since-last-sync suffix.
 *   - **Backup segment** — shows current backup status (idle, running, completed,
 *     error, disabled) with a time-since-last-backup suffix.
 *
 * Both segments are keyboard-accessible (tabIndex=0, Enter/Space handlers) and
 * emit a {@link StatusBarAction} to the registered action handler when activated,
 * allowing the plugin to trigger a manual sync or backup on click.
 *
 * Call order: `new StatusBar(plugin)` → `setActionHandler(handler)` → `init()`.
 * After init, call `updateSyncState()` / `updateBackupState()` to reflect new
 * states as they change during plugin operation.
 */

import { Plugin, setIcon, setTooltip } from 'obsidian';
import { BackupState, BackupStatus, SyncState, SyncStatus } from './types';
import { formatRelativeTime } from './utils/time';

/**
 * Intent emitted by a status segment click or keyboard activation.
 *
 * `'sync'`   — the sync segment was activated; the plugin should trigger a manual sync.
 * `'backup'` — the backup segment was activated; the plugin should trigger a manual backup.
 */
export type StatusBarAction = 'sync' | 'backup';

/**
 * Visual specification for a single status indicator state.
 *
 * Used by {@link SYNC_STATUS_SPEC} and {@link BACKUP_STATUS_SPEC} to map each
 * status value to its icon name (Lucide icon used by `setIcon`), short label,
 * and an emoji fallback for environments where `setIcon` is unavailable.
 */
interface StatusIndicatorSpec {
    /** Lucide icon identifier passed to Obsidian's `setIcon` helper. */
    icon: string;
    /** Short human-readable label shown in the segment text (e.g., "Synced"). */
    label: string;
    /** Emoji fallback rendered if `setIcon` throws (e.g., in test environments). */
    emoji: string;
}

/**
 * Maps every {@link SyncStatus} value to its visual indicator specification.
 * Module-level constant — allocated once, shared across all `StatusBar` instances.
 */
const SYNC_STATUS_SPEC: Record<SyncStatus, StatusIndicatorSpec> = {
    idle: { icon: 'cloud', label: 'Ready', emoji: '☁️' },
    synced: { icon: 'check', label: 'Synced', emoji: '✓' },
    syncing: { icon: 'refresh-cw', label: 'Syncing', emoji: '↻' },
    error: { icon: 'x', label: 'Error', emoji: '✕' },
    conflicts: { icon: 'alert-triangle', label: 'Conflict', emoji: '⚠' },
    disabled: { icon: 'circle-off', label: 'Off', emoji: '○' },
    paused: { icon: 'pause', label: 'Paused', emoji: '⏸' },
};

/**
 * Maps every {@link BackupStatus} value to its visual indicator specification.
 * Module-level constant — allocated once, shared across all `StatusBar` instances.
 */
const BACKUP_STATUS_SPEC: Record<BackupStatus, StatusIndicatorSpec> = {
    idle: { icon: 'archive', label: 'Ready', emoji: '📦' },
    completed: { icon: 'check', label: 'Done', emoji: '✓' },
    running: { icon: 'refresh-cw', label: 'Running', emoji: '↻' },
    error: { icon: 'x', label: 'Error', emoji: '✕' },
    disabled: { icon: 'circle-off', label: 'Off', emoji: '○' },
};

/**
 * StatusBar — manages the plugin's status bar display in Obsidian.
 *
 * Renders two side-by-side clickable segments (sync + backup) inside a single
 * status bar item. Each segment shows an icon and short text label. The full
 * status bar item has a hover tooltip with detailed state information.
 *
 * Clicking (or pressing Enter/Space on) a segment emits the corresponding
 * {@link StatusBarAction} to the registered handler, enabling one-click manual
 * sync or backup from the status bar.
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

    /**
     * @param plugin - The Obsidian `Plugin` instance used to add the status bar item.
     */
    constructor(private plugin: Plugin) {}

    /**
     * Register the action handler invoked when a status segment is clicked or
     * activated via keyboard. Must be called before `init()`.
     *
     * @param handler - Callback that receives the {@link StatusBarAction} indicating
     *   which segment was activated (`'sync'` or `'backup'`).
     */
    setActionHandler(handler: (action: StatusBarAction) => void): void {
        this.actionHandler = handler;
    }

    /**
     * Create the status bar item and both segment elements, then render initial state.
     *
     * Adds the status bar item via `Plugin.addStatusBarItem()`, creates the sync and
     * backup segments (each with icon + text child spans), and performs an initial
     * `update()` render. Must be called after `setActionHandler()`.
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
     * Merge a partial sync state update and re-render the status bar.
     *
     * Only the fields provided in `state` are updated; all other fields retain their
     * current values. This allows callers to update a single field (e.g., just
     * `status`) without having to reconstruct the full state object.
     *
     * @param state - Partial {@link SyncState} to merge into the current sync state.
     */
    updateSyncState(state: Partial<SyncState>): void {
        this.syncState = { ...this.syncState, ...state };
        this.update();
    }

    /**
     * Merge a partial backup state update and re-render the status bar.
     *
     * Only the fields provided in `state` are updated; all other fields retain their
     * current values.
     *
     * @param state - Partial {@link BackupState} to merge into the current backup state.
     */
    updateBackupState(state: Partial<BackupState>): void {
        this.backupState = { ...this.backupState, ...state };
        this.update();
    }

    /**
     * Remove the status bar item from the DOM and clear all element references.
     *
     * Called by the plugin's `onunload()`. After `destroy()`, this instance must not
     * be used — all element references are set to `null`.
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
     * Create a single clickable/keyboard-accessible segment inside the status bar.
     *
     * Creates a `<div>` containing an icon `<span>` and a text `<span>`. Wires up a
     * `click` listener and a `keydown` listener (Enter/Space) for keyboard accessibility
     * — `tabIndex=0` makes the element focusable via Tab key. Both event types invoke
     * the registered action handler with the segment's type.
     *
     * @param type - Which segment to create: `'sync'` or `'backup'`.
     * @returns The created segment `HTMLElement`.
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
     * Re-render both segments and refresh the tooltip.
     *
     * No-ops if the status bar has not been initialized (i.e., `init()` hasn't
     * been called yet). Delegates to `renderSync()`, `renderBackup()`, and
     * `getTooltipContent()`.
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
     * Re-render the sync segment based on the current `syncState`.
     *
     * Updates the segment's CSS class (for status-based theming), re-renders the icon,
     * and sets the text label. Appends a conflict count or relative last-sync time suffix
     * when applicable.
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
     * Re-render the backup segment based on the current `backupState`.
     *
     * Updates the segment's CSS class, re-renders the icon, and sets the text label.
     * Appends a relative last-backup time suffix when a previous backup time is known.
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
     * Render the icon for a status segment using Obsidian's `setIcon` helper.
     *
     * Falls back to the spec's emoji character if `setIcon` throws (e.g., when the
     * icon name is unrecognized in a test environment or older Obsidian version).
     *
     * @param target - The icon container `<span>` element to render into.
     * @param spec   - The {@link StatusIndicatorSpec} providing the icon name and emoji.
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
     * Build the multi-line tooltip string displayed when hovering over the status bar.
     *
     * Includes the plugin name, sync status/last-sync/conflicts/errors, backup
     * status/last-backup/errors, and click-to-trigger hints. Lines are joined with
     * newlines and passed to Obsidian's `setTooltip`.
     *
     * @returns A newline-delimited string suitable for `setTooltip`.
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
