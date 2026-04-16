/**
 * Backup Scheduler Module
 *
 * Manages automatic backup timing with catch-up logic for missed backups. If the
 * Obsidian app was closed (or the device was offline) during a scheduled backup
 * window, this scheduler detects the overdue backup on the next startup and runs
 * it immediately before resuming the normal periodic schedule.
 *
 * ## Scheduling strategy
 * Rather than scheduling a one-shot timer for the exact next-due time, the scheduler
 * registers a recurring "check" interval via Obsidian's `registerInterval`. The check
 * interval is the minimum of the configured backup interval and one hour, ensuring the
 * app can never miss a backup by more than one hour. This also means Obsidian
 * automatically cancels the interval when the plugin is unloaded (no manual cleanup
 * needed beyond calling `stop()`).
 *
 * ## Persistence
 * The timestamp of the last successful backup is persisted in Obsidian's `data.json`
 * (the plugin's own storage file) via `plugin.loadData()` / `plugin.saveData()`. This
 * survives app restarts, enabling the catch-up logic to work across sessions.
 *
 * ## Typical call flow
 * ```
 * BackupScheduler.start()
 *   → loadLastBackupTime()        (restore persisted timestamp)
 *   → checkAndRunBackup()         (catch-up: run immediately if overdue)
 *   → registerInterval(...)       (periodic future checks)
 * ```
 */

import { Plugin } from 'obsidian';
import {
	BackupResult,
    S3SyncBackupSettings,
    BACKUP_INTERVAL_MS,
} from '../types';

/**
 * Manages automatic backup scheduling, catch-up logic, and manual backup triggering.
 *
 * The scheduler works by registering a periodic check via Obsidian's `registerInterval`.
 * On each check (and immediately on `start()`), it compares the current time against
 * `lastBackupTime + intervalMs`. If the backup is overdue it invokes the registered
 * `onBackupTrigger` callback, saves the new timestamp, and notifies via `onBackupComplete`.
 *
 * Callers must register callbacks via `setCallbacks()` before calling `start()`.
 *
 * @example
 * ```typescript
 * const scheduler = new BackupScheduler(this, settings);
 * scheduler.setCallbacks({
 *   onBackupTrigger: () => snapshotCreator.createSnapshot(deviceId, deviceName),
 *   onBackupComplete: (result) => statusBar.updateBackupStatus(result),
 * });
 * await scheduler.start();
 * ```
 */
export class BackupScheduler {
    private plugin: Plugin;
    private settings: S3SyncBackupSettings;
    private intervalId: number | null = null;
    private isEnabled = false;
    private lastBackupTime: number | null = null;

	// Callbacks
	private onBackupTrigger?: () => Promise<BackupResult | null>;
	private onBackupComplete?: (result: BackupResult | null) => void;

    /**
     * Key used to store the last backup timestamp inside `data.json`.
     *
     * Obsidian plugins share a single `data.json` file (managed by `plugin.loadData()` /
     * `plugin.saveData()`). This namespaced key prevents collisions with other stored
     * plugin data (e.g., sync settings, journal entries).
     */
    private readonly LAST_BACKUP_KEY = 'obsidian-s3-sync-last-backup';

    /**
     * Creates a new BackupScheduler instance.
     *
     * Does not start the scheduling loop — call `start()` when the plugin is ready.
     *
     * @param plugin - The Obsidian Plugin instance. Used to call `registerInterval`,
     *   `loadData`, and `saveData` for lifecycle management and persistence.
     * @param settings - Current plugin settings. Must include `backupEnabled`,
     *   `backupInterval`, and `debugLogging`.
     */
    constructor(plugin: Plugin, settings: S3SyncBackupSettings) {
        this.plugin = plugin;
        this.settings = settings;
    }

    /**
     * Register the callbacks that the scheduler will invoke during backup lifecycle events.
     *
     * Both callbacks are optional — if `onBackupTrigger` is not set, `checkAndRunBackup`
     * will do nothing. `onBackupComplete` is useful for updating UI (e.g., status bar).
     *
     * @param callbacks.onBackupTrigger - Async function that performs the actual backup.
     *   Should return a `BackupResult` on success, or `null`/reject on failure.
     * @param callbacks.onBackupComplete - Called after each backup attempt (successful or
     *   failed) with the `BackupResult`, or `null` if the trigger threw an error.
     */
	setCallbacks(callbacks: {
		onBackupTrigger?: () => Promise<BackupResult | null>;
		onBackupComplete?: (result: BackupResult | null) => void;
	}): void {
        this.onBackupTrigger = callbacks.onBackupTrigger;
        this.onBackupComplete = callbacks.onBackupComplete;
    }

    /**
     * Apply updated settings to the scheduler.
     *
     * If the scheduler is currently running and the backup interval has changed, this
     * method restarts the scheduler so the new interval takes effect immediately.
     *
     * @param settings - The new plugin settings. Replaces the current settings in full.
     */
    updateSettings(settings: S3SyncBackupSettings): void {
        this.settings = settings;

        // Restart scheduler if interval changed
        if (this.isEnabled) {
            this.stop();
            void this.start();
        }
    }

    /**
     * Start the backup scheduler.
     *
     * Performs the following steps in order:
     * 1. Guards against double-start and checks `backupEnabled` in settings.
     * 2. Loads the persisted last-backup timestamp from `data.json`.
     * 3. Runs a catch-up check — if a backup was due while the app was closed, it
     *    triggers immediately rather than waiting for the next interval tick.
     * 4. Registers a recurring interval (capped at 1 hour) via `plugin.registerInterval`
     *    so Obsidian automatically clears it on plugin unload.
     *
     * Calling `start()` when the scheduler is already enabled is a no-op.
     *
     * @returns Resolves once the initial catch-up check has completed and the interval
     *   has been registered.
     */
    async start(): Promise<void> {
        if (this.isEnabled) return;
        if (!this.settings.backupEnabled) return;

        this.isEnabled = true;

        // Load last backup time
        await this.loadLastBackupTime();

        // Check if backup is due (catch-up logic)
        await this.checkAndRunBackup();

        // Schedule periodic checks
        const checkIntervalMs = Math.min(
            BACKUP_INTERVAL_MS[this.settings.backupInterval],
            60 * 60 * 1000 // Check at least every hour
        );

        this.intervalId = this.plugin.registerInterval(
            window.setInterval(() => {
                void this.checkAndRunBackup();
            }, checkIntervalMs)
        ) as unknown as number;

        if (this.settings.debugLogging) {
            console.debug(`[S3 Backup] Scheduler started: ${this.settings.backupInterval}`);
        }
    }

    /**
     * Stop the backup scheduler and cancel any pending interval.
     *
     * After calling `stop()`, no further automatic backups will be triggered until
     * `start()` is called again. Manual backups via `triggerManualBackup()` remain
     * available regardless of scheduler state.
     *
     * Calling `stop()` when the scheduler is already stopped is a no-op.
     */
    stop(): void {
        if (!this.isEnabled) return;

        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }

        this.isEnabled = false;

        if (this.settings.debugLogging) {
            console.debug('[S3 Backup] Scheduler stopped');
        }
    }

    /**
     * Determine whether a backup is overdue and run it if so.
     *
     * Called both on `start()` (for catch-up) and on every periodic interval tick.
     * The overdue check is:
     *
     * ```
     * now >= lastBackupTime + intervalMs
     * ```
     *
     * If `lastBackupTime` is `null` (no backup has ever run), `(null || 0) + intervalMs`
     * evaluates as `intervalMs` milliseconds from epoch — effectively always overdue,
     * so the first backup runs immediately on startup.
     *
     * On success, updates `lastBackupTime` and persists it via `saveLastBackupTime()`.
     * On failure, logs the error and calls `onBackupComplete(null)` to notify the UI.
     */
    private async checkAndRunBackup(): Promise<void> {
        if (!this.settings.backupEnabled) return;

        const intervalMs = BACKUP_INTERVAL_MS[this.settings.backupInterval];
        const now = Date.now();

        // Calculate when next backup is due
        const nextDue = (this.lastBackupTime || 0) + intervalMs;

        // Catch-up: if now >= nextDue, the backup interval has elapsed (or this is the
        // first ever backup). Trigger immediately instead of waiting for the next tick.
        if (now >= nextDue) {
            // Backup is due
            if (this.settings.debugLogging) {
                console.debug('[S3 Backup] Backup is due, triggering...');
            }

			try {
				const result = await this.onBackupTrigger?.() ?? null;
				if (!result?.success) {
					throw new Error(result?.errors[0] || 'Backup failed');
				}
				this.lastBackupTime = Date.now();
				await this.saveLastBackupTime();
				this.onBackupComplete?.(result);
			} catch (error) {
				console.error('[S3 Backup] Backup failed:', error);
				this.onBackupComplete?.(null);
			}
		}
	}

    /**
     * Immediately trigger a backup outside of the automatic schedule.
     *
     * On success, updates `lastBackupTime` and calls `onBackupComplete` with the result.
     * This effectively resets the automatic schedule — the next scheduled backup will be
     * measured from the time this manual backup completed.
     *
     * On failure, calls `onBackupComplete(null)` for UI notification and re-throws the
     * error so the caller can display it to the user.
     *
     * @returns The `BackupResult` produced by the backup trigger callback.
     * @throws Re-throws any error from `onBackupTrigger` or if the result indicates
     *   failure (i.e. `result.success === false`).
     */
	async triggerManualBackup(): Promise<BackupResult | null> {
        if (this.settings.debugLogging) {
            console.debug('[S3 Backup] Manual backup triggered');
        }

		try {
			const result = await this.onBackupTrigger?.() ?? null;
			if (!result?.success) {
				throw new Error(result?.errors[0] || 'Backup failed');
			}
			this.lastBackupTime = Date.now();
			await this.saveLastBackupTime();
			this.onBackupComplete?.(result);
			return result;
		} catch (error) {
			console.error('[S3 Backup] Manual backup failed:', error);
			this.onBackupComplete?.(null);
			throw error;
		}
	}

    /**
     * Return the Unix epoch timestamp (ms) of the last successful backup.
     *
     * Returns `null` if no backup has ever completed in this session or if the
     * persisted value could not be loaded from `data.json`.
     *
     * @returns Last backup time in milliseconds since epoch, or `null`.
     */
    getLastBackupTime(): number | null {
        return this.lastBackupTime;
    }

    /**
     * Calculate the approximate wall-clock time when the next automatic backup is due.
     *
     * Returns `null` if the scheduler is not running or no backup has completed yet
     * (in which case the next backup will trigger immediately on the first check).
     *
     * @returns A `Date` representing the next scheduled backup time, or `null` if the
     *   scheduler is stopped or no baseline time is available.
     */
    getNextBackupTime(): Date | null {
        if (!this.isEnabled || !this.lastBackupTime) return null;

        const intervalMs = BACKUP_INTERVAL_MS[this.settings.backupInterval];
        return new Date(this.lastBackupTime + intervalMs);
    }

    /**
     * Read the persisted last-backup timestamp from the plugin's `data.json` store.
     *
     * Uses `plugin.loadData()` which reads the entire `data.json` blob. The value is
     * stored under `LAST_BACKUP_KEY` and must be a number (Unix ms). Any read error or
     * missing/invalid value results in `lastBackupTime` remaining `null`, which causes
     * the catch-up check to trigger a backup immediately.
     */
    private async loadLastBackupTime(): Promise<void> {
        try {
            // Use plugin's loadData for persistence
            const data = await this.plugin.loadData() as Record<string, unknown> | null;
            if (data && typeof data[this.LAST_BACKUP_KEY] === 'number') {
                this.lastBackupTime = data[this.LAST_BACKUP_KEY] as number;
            }
        } catch {
            this.lastBackupTime = null;
        }
    }

    /**
     * Persist the current `lastBackupTime` to the plugin's `data.json` store.
     *
     * Performs a read-modify-write of the entire `data.json` blob to avoid clobbering
     * other plugin data (e.g., sync journal settings). Errors are logged but not
     * re-thrown — a failure to persist only means the catch-up logic may re-run the
     * backup on the next startup, which is a safe degraded behaviour.
     */
    private async saveLastBackupTime(): Promise<void> {
        try {
            const data = (await this.plugin.loadData() as Record<string, unknown> | null) ?? {};
            data[this.LAST_BACKUP_KEY] = this.lastBackupTime;
            await this.plugin.saveData(data);
        } catch (error) {
            console.error('[S3 Backup] Failed to save last backup time:', error);
        }
    }
}
