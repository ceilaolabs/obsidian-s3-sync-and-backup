/**
 * Sync Scheduler Module
 *
 * Manages periodic sync scheduling, pause/resume control, and sync-on-startup
 * functionality for the S3 Sync & Backup plugin.
 *
 * The scheduler wraps `window.setInterval` via Obsidian's `Plugin.registerInterval`
 * API so the interval is automatically cleared when the plugin is unloaded —
 * no manual teardown is needed for the happy path.  The `stop()` method is
 * still provided for cases where the scheduler must be cancelled early (e.g.
 * when the user disables sync in settings mid-session).
 *
 * Pause/resume support keeps the interval alive (avoiding drift in the next
 * fire time) but suppresses the `triggerSync` call inside the tick handler.
 * This is used during backup operations and settings saves to prevent
 * concurrent sync/backup races.
 *
 * All actual sync work is delegated to `SyncEngine.sync()`.  The scheduler
 * is responsible only for timing and lifecycle; it does not interpret sync
 * results beyond forwarding them to optional status callbacks.
 */

import { Plugin } from 'obsidian';
import { SyncEngine } from './SyncEngine';
import { S3SyncBackupSettings, SyncResult } from '../types';
import type { EncryptionCoordinator } from '../crypto/EncryptionCoordinator';

/**
 * Drives periodic vault synchronisation by wrapping `window.setInterval` in
 * Obsidian's `registerInterval` for automatic cleanup, and delegating each
 * tick to `SyncEngine.sync()`.
 *
 * Key responsibilities:
 * - Start/stop a periodic timer based on the `autoSyncEnabled` and
 *   `syncIntervalMinutes` settings.
 * - Skip ticks while paused (interval continues firing, sync is suppressed).
 * - Guard against concurrent syncs by checking `SyncEngine.isInProgress()`.
 * - Forward lifecycle events (`onSyncStart`, `onSyncComplete`, `onSyncError`)
 *   to status-bar or UI callbacks registered via `setCallbacks()`.
 * - Re-start the interval when settings change (e.g. interval duration updated).
 *
 * Typical usage:
 * ```ts
 * const scheduler = new SyncScheduler(plugin, syncEngine, settings);
 * scheduler.setCallbacks({ onSyncStart, onSyncComplete, onSyncError });
 * scheduler.start();
 * // On plugin unload, Obsidian auto-clears the interval via registerInterval.
 * ```
 */
export class SyncScheduler {
    private plugin: Plugin;
    private syncEngine: SyncEngine;
    private settings: S3SyncBackupSettings;
    private intervalId: number | null = null;
    private isEnabled = false;
    private isPaused = false;

    /** Optional encryption coordinator for preflight blocking checks. */
    private encryptionCoordinator: EncryptionCoordinator | null = null;

    // Callback for status updates
    private onSyncStart?: () => void;
    private onSyncComplete?: (result: SyncResult) => void;
    private onSyncError?: (error: string) => void;

    /**
     * Creates a new `SyncScheduler`.
     *
     * The scheduler does not start automatically — call `start()` after
     * construction (or after verifying that sync is enabled in settings).
     *
     * @param plugin   - The Obsidian `Plugin` instance, used to call
     *   `registerInterval` for lifecycle-safe timer management.
     * @param syncEngine - The `SyncEngine` to invoke on each scheduled tick.
     * @param settings   - The current plugin settings snapshot.  Update via
     *   `updateSettings()` whenever the user saves new settings.
     */
    constructor(plugin: Plugin, syncEngine: SyncEngine, settings: S3SyncBackupSettings) {
        this.plugin = plugin;
        this.syncEngine = syncEngine;
        this.settings = settings;
    }

    /**
     * Registers optional lifecycle callbacks for sync status reporting.
     *
     * All callbacks are optional; omit any that are not needed.
     * Callbacks are invoked synchronously in the scheduler's async flow so
     * they must not block (e.g. no awaiting heavy I/O inside them).
     *
     * @param callbacks.onSyncStart    - Invoked immediately before each sync begins.
     * @param callbacks.onSyncComplete - Invoked with the `SyncResult` after a
     *   successful sync (even if individual file errors occurred).
     * @param callbacks.onSyncError    - Invoked with an error message string if
     *   `SyncEngine.sync()` throws an unhandled exception.
     */
    setCallbacks(callbacks: {
        onSyncStart?: () => void;
        onSyncComplete?: (result: SyncResult) => void;
        onSyncError?: (error: string) => void;
    }): void {
        this.onSyncStart = callbacks.onSyncStart;
        this.onSyncComplete = callbacks.onSyncComplete;
        this.onSyncError = callbacks.onSyncError;
    }

    /**
     * Set the encryption coordinator for preflight blocking checks.
     */
    setEncryptionCoordinator(coordinator: EncryptionCoordinator): void {
        this.encryptionCoordinator = coordinator;
    }

    /**
     * Replaces the current settings and restarts the scheduler if the
     * interval duration or enabled state may have changed.
     *
     * Called by the settings tab's `save` handler.  If sync is currently
     * running the old interval is stopped and a new one is started with the
     * updated `syncIntervalMinutes` value.
     *
     * @param settings - The new settings object to adopt.
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;

        // Restart scheduler if interval changed
        if (this.isEnabled && this.settings.autoSyncEnabled) {
            this.stop();
            this.start();
        }
    }

    /**
     * Starts the periodic sync interval.
     *
     * No-ops if the scheduler is already running or if either `syncEnabled`
     * or `autoSyncEnabled` is `false` in settings.
     *
     * The interval is registered via `Plugin.registerInterval` so Obsidian
     * automatically clears it on plugin unload.
     * `registerInterval` returns a `number` (the raw interval ID) but
     * TypeScript may infer a `NodeJS.Timeout` type in some environments; the
     * `as unknown as number` cast ensures we store a plain number regardless
     * of the TypeScript environment's DOM/Node type resolution.
     */
    start(): void {
        if (this.isEnabled) return;
        if (!this.settings.syncEnabled || !this.settings.autoSyncEnabled) return;

        this.isEnabled = true;
        this.isPaused = false;

        // Calculate interval in milliseconds
        const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;

        // Register interval with plugin for auto-cleanup on unload.
        // Cast required: Obsidian's registerInterval returns the raw interval ID
        // as a number, but TypeScript's lib may type window.setInterval as
        // returning NodeJS.Timeout in some configurations.
        this.intervalId = this.plugin.registerInterval(
            window.setInterval(() => {
                if (!this.isPaused) {
                    void this.triggerSync('scheduled');
                }
            }, intervalMs)
        ) as unknown as number;

        if (this.settings.debugLogging) {
            console.debug(`[S3 Sync] Scheduler started: every ${this.settings.syncIntervalMinutes} minutes`);
        }
    }

    /**
     * Stops the periodic sync interval and resets the enabled/paused state.
     *
     * Safe to call when the scheduler is already stopped.  After this call,
     * `start()` may be called again to restart the scheduler.
     */
    stop(): void {
        if (!this.isEnabled) return;

        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }

        this.isEnabled = false;
        this.isPaused = false;

        if (this.settings.debugLogging) {
            console.debug('[S3 Sync] Scheduler stopped');
        }
    }

    /**
     * Pauses sync execution without clearing the underlying interval.
     *
     * While paused, the interval timer continues to fire at the configured
     * cadence but each tick is a no-op (the `triggerSync` call is skipped).
     * This preserves the interval's phase so resuming does not reset the
     * clock — the next sync fires at the original next tick time rather than
     * `interval` milliseconds after resume.
     *
     * Typically called before a backup operation starts to prevent concurrent
     * sync/backup activity.
     */
    pause(): void {
        this.isPaused = true;
        if (this.settings.debugLogging) {
            console.debug('[S3 Sync] Scheduler paused');
        }
    }

    /**
     * Resumes sync execution after a `pause()` call.
     *
     * The next sync will fire at the next scheduled interval tick.  If an
     * immediate sync is required after resuming, call `triggerSync('manual')`
     * explicitly.
     */
    resume(): void {
        this.isPaused = false;
        if (this.settings.debugLogging) {
            console.debug('[S3 Sync] Scheduler resumed');
        }
    }

    /**
     * Returns the current paused state of the scheduler.
     *
     * @returns `true` when the scheduler is paused (interval fires but syncs
     *   are suppressed); `false` otherwise.
     */
    getIsPaused(): boolean {
        return this.isPaused;
    }

    /**
     * Triggers a single sync operation via `SyncEngine.sync()`.
     *
     * If a sync is already in progress the call is silently skipped and
     * `null` is returned — this prevents concurrent sync runs from queuing
     * up behind each other.
     *
     * The `trigger` parameter is used for logging only; it does not affect
     * the sync behaviour:
     * - `'scheduled'` — fired automatically by the periodic interval timer.
     * - `'manual'`    — invoked by the user via a command or settings button.
     * - `'startup'`   — invoked once when the plugin loads (sync-on-startup).
     *
     * @param trigger - The source that initiated this sync, for debug logging.
     * @returns A promise resolving to the `SyncResult` from the engine, or
     *   `null` if the sync was skipped because one was already in progress
     *   or if the engine threw an unhandled error.
     */
    async triggerSync(trigger: 'manual' | 'scheduled' | 'startup'): Promise<SyncResult | null> {
        if (this.syncEngine.isInProgress()) {
            if (this.settings.debugLogging) {
                console.debug('[S3 Sync] Skipping - sync already in progress');
            }
            return null;
        }

        // Block scheduled/startup syncs when encryption state prevents safe operation
        if (this.encryptionCoordinator?.shouldBlock()) {
            if (this.settings.debugLogging) {
                console.debug(`[S3 Sync] Skipping - ${this.encryptionCoordinator.getBlockReason()}`);
            }
            return null;
        }

        if (this.settings.debugLogging) {
            console.debug(`[S3 Sync] Triggering sync: ${trigger}`);
        }

        this.onSyncStart?.();

        try {
            const result = await this.syncEngine.sync();

            this.onSyncComplete?.(result);

            if (result.errors.length > 0 && this.settings.debugLogging) {
                console.debug('[S3 Sync] Errors:', result.errors);
            }

            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.onSyncError?.(errorMessage);
            console.error('[S3 Sync] Sync failed:', error);
            return null;
        }
    }

    /**
     * Returns the approximate time at which the next scheduled sync will fire.
     *
     * The estimate is computed as `now + syncIntervalMinutes` and is therefore
     * only accurate immediately after a sync completes (i.e. it does not track
     * elapsed time since the last tick).  Returns `null` when the scheduler is
     * disabled or paused.
     *
     * @returns A `Date` representing the approximate next sync time, or `null`
     *   if the scheduler is not running or is currently paused.
     */
    getNextSyncTime(): Date | null {
        if (!this.isEnabled || this.isPaused) return null;

        const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
        return new Date(Date.now() + intervalMs);
    }
}
