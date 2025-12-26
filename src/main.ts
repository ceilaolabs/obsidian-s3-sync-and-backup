/**
 * Obsidian S3 Sync & Backup Plugin
 *
 * Main plugin entry point. Provides bi-directional vault synchronization
 * and scheduled backups with S3-compatible storage.
 *
 * @author Sathindu
 * @version 1.0.0
 */

import { Notice, Plugin } from 'obsidian';
import { S3SyncBackupSettings, DEFAULT_SETTINGS } from './types';
import { S3SyncBackupSettingTab } from './settings';
import { StatusBar } from './statusbar';
import { S3Provider } from './storage/S3Provider';
import { SyncJournal } from './sync/SyncJournal';
import { ChangeTracker } from './sync/ChangeTracker';
import { SyncEngine } from './sync/SyncEngine';
import { SyncScheduler } from './sync/SyncScheduler';
import { SnapshotCreator } from './backup/SnapshotCreator';
import { RetentionManager } from './backup/RetentionManager';
import { getOrCreateDeviceId } from './crypto/VaultMarker';

/**
 * S3SyncBackupPlugin - Main plugin class
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

	/** Sync engine for sync operations */
	private syncEngine: SyncEngine | null = null;

	/** Sync scheduler for periodic syncs */
	private syncScheduler: SyncScheduler | null = null;

	/** Backup snapshot creator */
	private snapshotCreator: SnapshotCreator | null = null;

	/** Backup retention manager */
	private retentionManager: RetentionManager | null = null;

	/** Device ID for backup tracking */
	private deviceId: string = '';

	/** Backup in progress flag */
	private isBackupRunning = false;

	/**
	 * Plugin load lifecycle hook
	 * Called when the plugin is enabled
	 */
	async onload(): Promise<void> {
		console.log('Loading S3 Sync & Backup plugin');

		// Load settings
		await this.loadSettings();

		// Get device ID
		this.deviceId = getOrCreateDeviceId();

		// Initialize S3 provider
		this.s3Provider = new S3Provider(this.settings);

		// Initialize status bar
		this.statusBar = new StatusBar(this);
		this.statusBar.init();

		// Initialize sync journal
		const vaultName = this.app.vault.getName();
		this.syncJournal = new SyncJournal(vaultName);
		await this.syncJournal.initialize();

		// Initialize change tracker
		this.changeTracker = new ChangeTracker(this.app, this.syncJournal);

		// Initialize sync engine
		this.syncEngine = new SyncEngine(
			this.app,
			this.s3Provider,
			this.syncJournal,
			this.changeTracker,
			this.settings
		);

		// Initialize sync scheduler
		this.syncScheduler = new SyncScheduler(this, this.syncEngine, this.settings);
		this.syncScheduler.setCallbacks({
			onSyncStart: () => {
				this.statusBar?.updateSyncState({
					status: 'syncing',
					isSyncing: true,
				});
			},
			onSyncComplete: (success, conflictCount) => {
				this.statusBar?.updateSyncState({
					status: conflictCount > 0 ? 'conflicts' : 'synced',
					lastSyncTime: Date.now(),
					isSyncing: false,
					conflictCount,
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

		// Initialize backup components
		this.snapshotCreator = new SnapshotCreator(this.app, this.s3Provider, this.settings);
		this.retentionManager = new RetentionManager(this.s3Provider, this.settings);

		// Update status bar based on settings
		this.updateStatusBarFromSettings();

		// Register settings tab
		this.addSettingTab(new S3SyncBackupSettingTab(this.app, this));

		// Add ribbon icon for manual sync
		this.addRibbonIcon('refresh-cw', 'Sync with S3', async () => {
			await this.triggerManualSync();
		});

		// Register commands
		this.registerCommands();

		// Start sync services if enabled
		this.startSyncServices();

		// Sync on startup if enabled
		if (this.settings.syncEnabled && this.settings.syncOnStartup) {
			// Delay startup sync to let vault fully load
			setTimeout(() => {
				this.syncScheduler?.triggerSync('startup');
			}, 3000);
		}
	}

	/**
	 * Plugin unload lifecycle hook
	 * Called when the plugin is disabled
	 */
	onunload(): void {
		console.log('Unloading S3 Sync & Backup plugin');

		// Stop sync services
		this.stopSyncServices();

		// Close sync journal
		if (this.syncJournal) {
			this.syncJournal.close();
			this.syncJournal = null;
		}

		// Destroy S3 provider
		if (this.s3Provider) {
			this.s3Provider.destroy();
			this.s3Provider = null;
		}

		// Cleanup status bar
		if (this.statusBar) {
			this.statusBar.destroy();
			this.statusBar = null;
		}
	}

	/**
	 * Load plugin settings from disk
	 */
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/**
	 * Save plugin settings to disk
	 */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);

		// Update S3 provider with new settings
		if (this.s3Provider) {
			this.s3Provider.updateSettings(this.settings);
		}

		// Update sync engine settings
		if (this.syncEngine) {
			this.syncEngine.updateSettings(this.settings);
		}

		// Update sync scheduler settings
		if (this.syncScheduler) {
			this.syncScheduler.updateSettings(this.settings);
		}

		// Update backup components
		if (this.snapshotCreator) {
			this.snapshotCreator.updateSettings(this.settings);
		}
		if (this.retentionManager) {
			this.retentionManager.updateSettings(this.settings);
		}
	}

	/**
	 * Called when settings are changed
	 * Updates sync services and status bar
	 */
	onSettingsChanged(): void {
		this.updateStatusBarFromSettings();
		this.restartSyncServices();
	}

	/**
	 * Update status bar based on current settings
	 */
	private updateStatusBarFromSettings(): void {
		if (!this.statusBar) return;

		// Update sync status
		if (this.settings.syncEnabled) {
			this.statusBar.updateSyncState({
				status: this.syncScheduler?.getIsPaused() ? 'paused' : 'synced',
				lastSyncTime: null,
			});
		} else {
			this.statusBar.updateSyncState({
				status: 'disabled',
			});
		}

		// Update backup status
		if (this.settings.backupEnabled) {
			this.statusBar.updateBackupState({
				status: 'completed',
				lastBackupTime: null,
			});
		} else {
			this.statusBar.updateBackupState({
				status: 'disabled',
			});
		}
	}

	/**
	 * Start sync services
	 */
	private startSyncServices(): void {
		if (this.settings.syncEnabled) {
			// Start change tracking
			this.changeTracker?.startTracking(this.settings.excludePatterns);

			// Start sync scheduler
			if (this.settings.autoSyncEnabled) {
				this.syncScheduler?.start();
			}
		}
	}

	/**
	 * Stop sync services
	 */
	private stopSyncServices(): void {
		this.changeTracker?.stopTracking();
		this.syncScheduler?.stop();
	}

	/**
	 * Restart sync services (after settings change)
	 */
	private restartSyncServices(): void {
		this.stopSyncServices();
		this.startSyncServices();
	}

	/**
	 * Register command palette commands
	 */
	private registerCommands(): void {
		// Sync now command
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: async () => {
				await this.triggerManualSync();
			},
		});

		// Backup now command
		this.addCommand({
			id: 'backup-now',
			name: 'Backup now',
			callback: async () => {
				await this.triggerManualBackup();
			},
		});

		// Pause sync command
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

		// Resume sync command
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

		// Open settings command
		this.addCommand({
			id: 'open-settings',
			name: 'Open settings',
			callback: () => {
				// Navigate to plugin settings
				// @ts-ignore - accessing internal API
				this.app.setting.open();
				// @ts-ignore
				this.app.setting.openTabById('obsidian-s3-sync-and-backup');
			},
		});
	}

	/**
	 * Trigger manual sync with user feedback
	 */
	async triggerManualSync(): Promise<void> {
		if (!this.settings.syncEnabled) {
			new Notice('Sync is disabled. Enable it in settings.');
			return;
		}

		if (this.syncEngine?.isInProgress()) {
			new Notice('Sync already in progress...');
			return;
		}

		new Notice('Starting sync...');
		await this.syncScheduler?.triggerSync('manual');
		new Notice('Sync completed');
	}

	/**
	 * Trigger manual backup with user feedback
	 */
	async triggerManualBackup(): Promise<void> {
		if (!this.settings.backupEnabled) {
			new Notice('Backup is disabled. Enable it in settings.');
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

		this.isBackupRunning = true;
		new Notice('Starting backup...');

		// Update status bar
		this.statusBar?.updateBackupState({
			status: 'running',
			isRunning: true,
		});

		try {
			// Create backup snapshot
			const vaultName = this.app.vault.getName();
			const result = await this.snapshotCreator.createSnapshot(this.deviceId, vaultName);

			if (result.success) {
				new Notice(`Backup completed: ${result.filesBackedUp} files`);

				// Update status bar
				this.statusBar?.updateBackupState({
					status: 'completed',
					lastBackupTime: Date.now(),
					isRunning: false,
				});

				// Apply retention policy
				if (this.settings.retentionEnabled && this.retentionManager) {
					const deleted = await this.retentionManager.applyRetentionPolicy();
					if (deleted > 0 && this.settings.debugLogging) {
						console.log(`[S3 Backup] Retention: deleted ${deleted} old backups`);
					}
				}
			} else {
				const errorMsg = result.errors.length > 0 ? result.errors[0] : 'Unknown error';
				new Notice(`Backup completed with errors: ${errorMsg}`);

				this.statusBar?.updateBackupState({
					status: 'error',
					isRunning: false,
					lastError: errorMsg,
				});
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`Backup failed: ${errorMessage}`);

			this.statusBar?.updateBackupState({
				status: 'error',
				isRunning: false,
				lastError: errorMessage,
			});
		} finally {
			this.isBackupRunning = false;
		}
	}

	/**
	 * Pause automatic sync
	 */
	private pauseSync(): void {
		this.syncScheduler?.pause();
		this.statusBar?.updateSyncState({
			status: 'paused',
		});
		new Notice('Sync paused');
	}

	/**
	 * Resume automatic sync
	 */
	private resumeSync(): void {
		this.syncScheduler?.resume();
		this.statusBar?.updateSyncState({
			status: 'synced',
		});
		new Notice('Sync resumed');
	}

	/**
	 * Get S3 provider instance
	 * Used by other modules that need S3 access
	 */
	getS3Provider(): S3Provider | null {
		return this.s3Provider;
	}

	/**
	 * Get sync journal instance
	 */
	getSyncJournal(): SyncJournal | null {
		return this.syncJournal;
	}
}
