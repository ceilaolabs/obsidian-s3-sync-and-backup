/**
 * Obsidian S3 Sync & Backup Plugin
 *
 * Main plugin entry point. Provides bi-directional vault synchronization
 * and scheduled backups with S3-compatible storage.
 *
 * @author Ceilão Labs
 */

import { Notice, Plugin } from 'obsidian';
import { S3SyncBackupSettings, DEFAULT_SETTINGS } from './types';
import { S3SyncBackupSettingTab } from './settings';
import { StatusBar } from './statusbar';
import { S3Provider } from './storage/S3Provider';
import { SyncJournal } from './sync/SyncJournal';
import { ChangeTracker } from './sync/ChangeTracker';
import { SyncPathCodec } from './sync/SyncPathCodec';
import { SyncPayloadCodec } from './sync/SyncPayloadCodec';
import { SyncEngine } from './sync/SyncEngine';
import { SyncScheduler } from './sync/SyncScheduler';
import { BackupDownloader } from './backup/BackupDownloader';
import { SnapshotCreator } from './backup/SnapshotCreator';
import { RetentionManager } from './backup/RetentionManager';
import { BackupScheduler } from './backup/BackupScheduler';
import { getOrCreateDeviceId } from './crypto/VaultMarker';
import { EncryptionCoordinator } from './crypto/EncryptionCoordinator';
import { BackupResult } from './types';

/**
 * S3SyncBackupPlugin — main plugin class.
 *
 * Manages plugin lifecycle, settings, and orchestrates sync/backup operations.
 */
export default class S3SyncBackupPlugin extends Plugin {
	settings!: S3SyncBackupSettings;

	/** S3 provider instance */
	private s3Provider: S3Provider | null = null;

	/** Status bar component */
	private statusBar: StatusBar | null = null;

	/** Sync journal for state persistence */
	private syncJournal: SyncJournal | null = null;

	/** Change tracker for vault events */
	private changeTracker: ChangeTracker | null = null;

	/** Path encoder/decoder for S3 key conversion */
	private pathCodec: SyncPathCodec | null = null;

	/** Payload encoder/decoder for encryption layer */
	private payloadCodec: SyncPayloadCodec | null = null;

	/** Sync engine for sync operations */
	private syncEngine: SyncEngine | null = null;

	/** Sync scheduler for periodic syncs */
	private syncScheduler: SyncScheduler | null = null;

	/** Backup snapshot creator */
	private snapshotCreator: SnapshotCreator | null = null;

	/** Backup downloader for zip exports */
	private backupDownloader: BackupDownloader | null = null;

	/** Backup retention manager */
	private retentionManager: RetentionManager | null = null;

	/** Backup scheduler for periodic backups */
	private backupScheduler: BackupScheduler | null = null;

	/** Encryption coordinator — owns encryption state and key propagation */
	private encryptionCoordinator: EncryptionCoordinator | null = null;

	/** Device ID for sync and backup tracking */
	private deviceId: string = '';

	/** Backup in progress flag */
	private isBackupRunning = false;

	/**
	 * Plugin load lifecycle hook.
	 * Called when the plugin is enabled.
	 */
	async onload(): Promise<void> {
		console.debug('Loading S3 Sync & Backup plugin');

		await this.loadSettings();

		this.deviceId = getOrCreateDeviceId(this.app);

		// S3 provider must be created first — all subsystems (sync engine, backup snapshot
		// creator, etc.) accept it as a constructor argument. Creating it here once ensures
		// a single authenticated client is reused across the entire plugin lifecycle.
		this.s3Provider = new S3Provider(this.settings);

		// Status bar
		this.statusBar = new StatusBar(this);
		this.statusBar.setActionHandler((action) => {
			if (action === 'sync') {
				void this.triggerManualSync();
				return;
			}

			void this.triggerManualBackup();
		});
		this.statusBar.init();

		// Sync journal must be initialized (IndexedDB opened) before the sync engine is
		// constructed, because SyncEngine holds a reference to the open journal instance
		// and reads/writes baselines immediately on the first sync pass. The await here
		// ensures the database schema migrations have completed before any sync can run.
		// (v2 — IndexedDB with stateRecords, conflicts, metadata stores)
		const vaultName = this.app.vault.getName();
		this.syncJournal = new SyncJournal(vaultName);
		await this.syncJournal.initialize();

		// Path codec
		this.pathCodec = new SyncPathCodec(this.settings.syncPrefix);

		// Payload codec (encryption key is null until the user provides a passphrase)
		this.payloadCodec = new SyncPayloadCodec(null);

		// Change tracker (v2 — dirty-path hints only, no journal coupling)
		this.changeTracker = new ChangeTracker(this.app);

		// Sync engine (v2 — thin orchestrator: planner → executor)
		this.syncEngine = new SyncEngine(
			this.app,
			this.s3Provider,
			this.syncJournal,
			this.pathCodec,
			this.payloadCodec,
			this.changeTracker,
			this.settings,
			this.deviceId,
		);

		// Sync scheduler
		this.syncScheduler = new SyncScheduler(this, this.syncEngine, this.settings);
		this.syncScheduler.setCallbacks({
			onSyncStart: () => {
				this.statusBar?.updateSyncState({
					status: 'syncing',
					isSyncing: true,
					lastError: null,
				});
			},
			onSyncComplete: (result) => {
				const status = result.errors.length > 0
					? 'error'
					: result.conflicts.length > 0
						? 'conflicts'
						: 'synced';

				this.statusBar?.updateSyncState({
					status,
					lastSyncTime: result.completedAt,
					isSyncing: false,
					conflictCount: result.conflicts.length,
					lastError: result.errors[0]?.message ?? null,
				});
			},
			onSyncError: (error) => {
				this.statusBar?.updateSyncState({
					status: 'error',
					isSyncing: false,
					lastError: error,
				});
			},
		});

		// Backup components
		this.snapshotCreator = new SnapshotCreator(this.app, this.s3Provider, this.settings);
		this.backupDownloader = new BackupDownloader(this.s3Provider, this.settings);
		this.retentionManager = new RetentionManager(this.s3Provider, this.settings);

		// Backup scheduler
		this.backupScheduler = new BackupScheduler(this, this.settings);
		this.backupScheduler.setCallbacks({
			onBackupTrigger: async () => {
				return await this.runBackup();
			},
			onBackupComplete: (result) => {
				this.statusBar?.updateBackupState({
					status: result?.success ? 'completed' : 'error',
					lastBackupTime: result?.success ? result.completedAt : null,
					isRunning: false,
					lastError: result?.success ? null : (result?.errors[0] ?? 'Backup failed'),
				});
			},
		});

		// Encryption coordinator — constructed after payloadCodec, snapshotCreator,
		// and backupDownloader are available so it can propagate keys to all of them.
		this.encryptionCoordinator = new EncryptionCoordinator(
			this.app,
			this.s3Provider,
			this.payloadCodec,
			this.pathCodec,
			this.snapshotCreator,
			this.backupDownloader,
			this.settings,
			this.deviceId,
		);

		// Wire coordinator into the sync scheduler so scheduled syncs are blocked
		// when encryption state prevents safe operation.
		this.syncScheduler.setEncryptionCoordinator(this.encryptionCoordinator);

		this.updateStatusBarFromSettings();

		// Settings tab
		this.addSettingTab(new S3SyncBackupSettingTab(this.app, this));

		// Ribbon icon
		this.addRibbonIcon('refresh-cw', 'Sync with S3', async () => {
			await this.triggerManualSync();
		});

		// Commands
		this.registerCommands();

		// Start sync services if enabled
		this.startSyncServices();

		// Check remote encryption state on startup. If the vault is encrypted
		// (marker exists in S3), auto-enable locally and block sync/backup until
		// the user provides the passphrase in settings. This handles multi-device
		// detection: device A enables encryption → device B detects on startup.
		if (this.s3Provider && this.encryptionCoordinator) {
			this.app.workspace.onLayoutReady(() => {
				void this.checkEncryptionOnStartup();
			});
		}

		// Startup sync is deferred until workspace layout is ready so that Obsidian has
		// finished restoring open tabs and the vault index is fully populated. Triggering
		// sync too early (before onLayoutReady) can cause spurious file-not-found errors
		// because the vault's in-memory file tree may not yet reflect disk reality.
		if (this.settings.syncEnabled && this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				void this.syncScheduler?.triggerSync('startup');
			});
		}
	}

	/**
	 * Plugin unload lifecycle hook.
	 * Called when the plugin is disabled.
	 */
	onunload(): void {
		console.debug('Unloading S3 Sync & Backup plugin');

		this.stopSyncServices();

		if (this.syncJournal) {
			this.syncJournal.close();
			this.syncJournal = null;
		}

		if (this.s3Provider) {
			this.s3Provider.destroy();
			this.s3Provider = null;
		}

		if (this.statusBar) {
			this.statusBar.destroy();
			this.statusBar = null;
		}
	}

	/**
	 * Load plugin settings from disk.
	 */
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<S3SyncBackupSettings> | null);
	}

	/**
	 * Save plugin settings to disk and propagate to all subsystems.
	 */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);

		if (this.s3Provider) {
			this.s3Provider.updateSettings(this.settings);
		}

		if (this.syncEngine) {
			this.syncEngine.updateSettings(this.settings);
		}

		if (this.pathCodec) {
			this.pathCodec.updatePrefix(this.settings.syncPrefix);
		}

		if (this.syncScheduler) {
			this.syncScheduler.updateSettings(this.settings);
		}

		if (this.snapshotCreator) {
			this.snapshotCreator.updateSettings(this.settings);
		}
		if (this.backupDownloader) {
			this.backupDownloader.updateSettings(this.settings);
		}
		if (this.retentionManager) {
			this.retentionManager.updateSettings(this.settings);
		}
		if (this.backupScheduler) {
			this.backupScheduler.updateSettings(this.settings);
		}

		if (this.changeTracker) {
			this.changeTracker.updateExcludePatterns(this.settings.excludePatterns);
		}

		if (this.encryptionCoordinator) {
			this.encryptionCoordinator.updateSettings(this.settings);
		}
	}

	/**
	 * Called when settings are changed via the settings tab.
	 */
	onSettingsChanged(): void {
		this.updateStatusBarFromSettings();
		this.restartSyncServices();
	}

	/**
	 * Update the encryption key used by the payload codec.
	 * Called when the user provides or changes their passphrase.
	 *
	 * @param key - Derived encryption key, or null to disable encryption.
	 * @deprecated Use EncryptionCoordinator instead. Kept for backwards compatibility.
	 */
	updateEncryptionKey(key: Uint8Array | null): void {
		this.payloadCodec?.updateKey(key);
	}

	/**
	 * Check remote encryption state on startup and notify the user if
	 * the vault is encrypted but no passphrase has been provided yet.
	 */
	private async checkEncryptionOnStartup(): Promise<void> {
		if (!this.encryptionCoordinator) return;

		await this.encryptionCoordinator.refreshRemoteMode(
			async () => { await this.saveSettings(); },
		);

		const state = this.encryptionCoordinator.getState();

		if (state.remoteMode === 'encrypted' && !state.hasKey) {
			// Auto-unlock with saved passphrase if "remember passphrase" is enabled
			if (this.settings.rememberPassphrase && this.settings.savedPassphrase) {
				const success = await this.encryptionCoordinator.unlock(this.settings.savedPassphrase);
				if (success) {
					if (this.settings.debugLogging) {
						console.debug('[S3 Sync] Auto-unlocked vault with saved passphrase');
					}
					return;
				}
				// Saved passphrase is wrong (changed on another device?) — clear it
				this.settings.rememberPassphrase = false;
				this.settings.savedPassphrase = '';
				await this.saveSettings();
				new Notice('Saved passphrase is incorrect — enter the current passphrase in settings', 10000);
				return;
			}

			new Notice('Vault is encrypted — enter passphrase in settings to unlock sync and backup', 10000);
		} else if (state.remoteMode === 'transitioning') {
			new Notice('Encryption migration in progress on another device — sync and backup paused', 10000);
		}
	}

	/**
	 * Get the encryption coordinator for use by the settings tab.
	 */
	getEncryptionCoordinator(): EncryptionCoordinator | null {
		return this.encryptionCoordinator;
	}

	/**
	 * Sync the status bar's display with the current settings state.
	 *
	 * Called on initial load and whenever settings change. Sets the sync segment
	 * to `idle` (or `paused` if currently paused, or `disabled` if sync is off)
	 * and the backup segment to `idle` (or `disabled` if backup is off).
	 * Does not alter any "in-progress" states that may have been set by an
	 * ongoing sync or backup — those are managed by scheduler callbacks.
	 */
	private updateStatusBarFromSettings(): void {
		if (!this.statusBar) return;

		if (this.settings.syncEnabled) {
			this.statusBar.updateSyncState({
				status: this.syncScheduler?.getIsPaused() ? 'paused' : 'idle',
				lastSyncTime: null,
				conflictCount: 0,
				isSyncing: false,
				lastError: null,
			});
		} else {
			this.statusBar.updateSyncState({
				status: 'disabled',
				lastSyncTime: null,
				conflictCount: 0,
				isSyncing: false,
				lastError: null,
			});
		}

		if (this.settings.backupEnabled) {
			this.statusBar.updateBackupState({
				status: 'idle',
				lastBackupTime: this.backupScheduler?.getLastBackupTime() ?? null,
				isRunning: false,
				lastError: null,
			});
		} else {
			this.statusBar.updateBackupState({
				status: 'disabled',
				lastBackupTime: null,
				isRunning: false,
				lastError: null,
			});
		}
	}

	/**
	 * Start all active sync and backup services based on current settings.
	 *
	 * Activates the change tracker (vault file watcher) and the periodic sync
	 * scheduler if auto-sync is enabled. Starts the backup scheduler if backup
	 * is enabled. Safe to call after `stopSyncServices()` — calling start on an
	 * already-running scheduler has no effect.
	 */
	private startSyncServices(): void {
		if (this.settings.syncEnabled) {
			this.changeTracker?.startTracking(this.settings.excludePatterns);

			if (this.settings.autoSyncEnabled) {
				this.syncScheduler?.start();
			}
		}

		if (this.settings.backupEnabled) {
			void this.backupScheduler?.start();
		}
	}

	/**
	 * Stop all background sync and backup services.
	 *
	 * Halts the change tracker, sync scheduler, and backup scheduler. Does not
	 * interrupt an in-progress sync or backup operation — those run to completion.
	 * Called during plugin unload and before settings-driven restarts.
	 */
	private stopSyncServices(): void {
		this.changeTracker?.stopTracking();
		this.syncScheduler?.stop();
		this.backupScheduler?.stop();
	}

	/**
	 * Restart all sync and backup services.
	 *
	 * Convenience wrapper around `stopSyncServices()` + `startSyncServices()`.
	 * Called when settings change to apply the new configuration (e.g., changed
	 * sync interval, toggling auto-sync, or enabling/disabling backup).
	 */
	private restartSyncServices(): void {
		this.stopSyncServices();
		this.startSyncServices();
	}

	/**
	 * Register all command palette commands for the plugin.
	 *
	 * Commands are registered here rather than in a separate `commands.ts` module
	 * because they require direct access to private plugin methods (triggerManualSync,
	 * pauseSync, resumeSync). The `checkCallback` pattern is used for pause/resume so
	 * Obsidian only shows commands that are currently applicable.
	 */
	private registerCommands(): void {
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: async () => {
				await this.triggerManualSync();
			},
		});

		this.addCommand({
			id: 'backup-now',
			name: 'Backup now',
			callback: async () => {
				await this.triggerManualBackup();
			},
		});

		this.addCommand({
			id: 'pause-sync',
			name: 'Pause sync',
			checkCallback: (checking: boolean) => {
				if (this.settings.syncEnabled && !this.syncScheduler?.getIsPaused()) {
					if (!checking) {
						this.pauseSync();
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: 'resume-sync',
			name: 'Resume sync',
			checkCallback: (checking: boolean) => {
				if (this.settings.syncEnabled && this.syncScheduler?.getIsPaused()) {
					if (!checking) {
						this.resumeSync();
					}
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: 'open-settings',
			name: 'Open settings',
			callback: () => {
				(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
				(this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById('s3-sync-and-backup');
			},
		});
	}

	/**
	 * Trigger manual sync with user feedback via Notice.
	 */
	async triggerManualSync(): Promise<void> {
		if (!this.settings.syncEnabled) {
			new Notice('Sync is disabled. Enable it in settings.');
			return;
		}

		// Encryption preflight: refresh remote state and block if needed
		if (this.encryptionCoordinator) {
			await this.encryptionCoordinator.refreshRemoteMode(
				async () => { await this.saveSettings(); },
			);
			const blockReason = this.encryptionCoordinator.getBlockReason();
			if (blockReason) {
				new Notice(`Sync blocked: ${blockReason}`);
				return;
			}
		}

		if (this.syncEngine?.isInProgress()) {
			new Notice('Sync already in progress...');
			return;
		}

		new Notice('Starting sync...');
		const result = await this.syncScheduler?.triggerSync('manual');

		if (!result) {
			return;
		}

		const firstError = result.errors[0];
		if (firstError) {
			new Notice(`Sync completed with errors: ${firstError.message}`);
			return;
		}

		if (result.conflicts.length > 0) {
			new Notice(`Sync completed with ${result.conflicts.length} conflict(s)`);
			return;
		}

		new Notice(`Sync completed: ${result.filesUploaded} uploaded, ${result.filesDownloaded} downloaded, ${result.filesDeleted} deleted`);
	}

	/**
	 * Trigger manual backup with user feedback via Notice.
	 */
	async triggerManualBackup(): Promise<void> {
		if (!this.settings.backupEnabled) {
			new Notice('Backup is disabled. Enable it in settings.');
			return;
		}

		// Encryption preflight: block backup if vault is encrypted but no key loaded
		if (this.encryptionCoordinator?.shouldBlock()) {
			const reason = this.encryptionCoordinator.getBlockReason();
			new Notice(`Backup blocked: ${reason}`);
			return;
		}

		if (this.isBackupRunning) {
			new Notice('Backup already in progress...');
			return;
		}

		if (!this.snapshotCreator || !this.s3Provider) {
			new Notice('Backup system not initialized');
			return;
		}
		new Notice('Starting backup...');

		try {
			const result = await this.backupScheduler?.triggerManualBackup() ?? await this.runBackup();

			if (result?.success) {
				new Notice(`Backup completed: ${result.filesBackedUp} files`);
				return;
			}

			const errorMsg = result?.errors[0] ?? 'Unknown error';
			new Notice(`Backup completed with errors: ${errorMsg}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`Backup failed: ${errorMessage}`);
		}
	}

	/**
	 * Execute a backup operation: create a vault snapshot, upload to S3, and apply
	 * retention policy if configured.
	 *
	 * Guards against concurrent runs via `isBackupRunning`. Updates the status bar
	 * to reflect the running/completed states. Returns `null` if already running or
	 * if the backup system is not fully initialized.
	 *
	 * @returns The `BackupResult` on completion (success or failure with errors), or
	 *   `null` if the backup was skipped due to a concurrent run or missing subsystems.
	 */
	private async runBackup(): Promise<BackupResult | null> {
		if (this.isBackupRunning) {
			if (this.settings.debugLogging) {
				console.debug('[S3 Backup] Skipping scheduled backup - already running');
			}
			return null;
		}

		if (!this.snapshotCreator || !this.s3Provider) {
			console.error('[S3 Backup] Backup system not initialized');
			return null;
		}

		// Block scheduled backups when encryption state prevents safe operation
		if (this.encryptionCoordinator?.shouldBlock()) {
			if (this.settings.debugLogging) {
				console.debug(`[S3 Backup] Skipping - ${this.encryptionCoordinator.getBlockReason()}`);
			}
			return null;
		}

		this.isBackupRunning = true;

		this.statusBar?.updateBackupState({
			status: 'running',
			isRunning: true,
			lastError: null,
		});

		try {
			const vaultName = this.app.vault.getName();
			const result = await this.snapshotCreator.createSnapshot(this.deviceId, vaultName);

			if (result.success) {
				if (this.settings.debugLogging) {
					console.debug(`[S3 Backup] Scheduled backup completed: ${result.filesBackedUp} files`);
				}

				if (this.settings.retentionEnabled && this.retentionManager) {
					const deleted = await this.retentionManager.applyRetentionPolicy();
					if (deleted > 0 && this.settings.debugLogging) {
						console.debug(`[S3 Backup] Retention: deleted ${deleted} old backups`);
					}
				}

				return result;
			} else {
				const errorMsg = result.errors.length > 0 ? result.errors[0] : 'Unknown error';
				console.error(`[S3 Backup] Scheduled backup failed: ${errorMsg}`);
				return result;
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			console.error(`[S3 Backup] Scheduled backup failed: ${errorMessage}`);
			return null;
		} finally {
			this.isBackupRunning = false;
		}
	}

	/**
	 * Pause automatic sync scheduling and reflect the paused state in the status bar.
	 *
	 * The sync scheduler is suspended (no more periodic triggers) but an in-progress
	 * sync run is allowed to complete. Manual sync via `triggerManualSync()` remains
	 * available while paused.
	 */
	private pauseSync(): void {
		this.syncScheduler?.pause();
		this.statusBar?.updateSyncState({
			status: 'paused',
		});
		new Notice('Sync paused');
	}

	/**
	 * Resume automatic sync scheduling after a pause.
	 *
	 * Restores the scheduler to active state and resets the status bar to `idle`.
	 * The next scheduled sync will fire after the configured interval from the
	 * resume point (not immediately).
	 */
	private resumeSync(): void {
		this.syncScheduler?.resume();
		this.statusBar?.updateSyncState({
			status: 'idle',
		});
		new Notice('Sync resumed');
	}

	/**
	 * Get S3 provider instance.
	 * Used by settings tab and other modules that need S3 access.
	 *
	 * @returns The active {@link S3Provider}, or `null` if the plugin has not yet
	 *   loaded or has been unloaded.
	 */
	getS3Provider(): S3Provider | null {
		return this.s3Provider;
	}

	/**
	 * Get sync journal instance.
	 *
	 * Used by modules that need to read or write per-file sync baselines (e.g.,
	 * settings tab actions such as clearing the journal on bucket change).
	 *
	 * @returns The active {@link SyncJournal}, or `null` if the plugin has not yet
	 *   loaded or has been unloaded.
	 */
	getSyncJournal(): SyncJournal | null {
		return this.syncJournal;
	}

	/**
	 * Build the callbacks object needed by {@link EncryptionCoordinator} for
	 * enable/disable encryption flows that need to pause schedulers and save settings.
	 */
	getEncryptionCallbacks(): import('./crypto/EncryptionCoordinator').EncryptionCoordinatorCallbacks {
		return {
			saveSettings: () => this.saveSettings(),
			pauseSchedulers: () => {
				this.syncScheduler?.pause();
				this.backupScheduler?.stop();
			},
			resumeSchedulers: () => {
				this.syncScheduler?.resume();
				if (this.settings.backupEnabled) {
					void this.backupScheduler?.start();
				}
			},
		};
	}
}
