/**
 * Backup Scheduler Module
 *
 * Manages backup scheduling with catch-up logic for missed backups.
 * Handles periodic backup triggering based on user configuration.
 */

import { Plugin } from 'obsidian';
import {
    S3SyncBackupSettings,
    BACKUP_INTERVAL_MS,
} from '../types';

/**
 * BackupScheduler class - Manages backup timing
 */
export class BackupScheduler {
    private plugin: Plugin;
    private settings: S3SyncBackupSettings;
    private intervalId: number | null = null;
    private isEnabled = false;
    private lastBackupTime: number | null = null;

    // Callbacks
    private onBackupTrigger?: () => Promise<void>;
    private onBackupComplete?: (success: boolean) => void;

    // Storage key for last backup time
    private readonly LAST_BACKUP_KEY = 'obsidian-s3-sync-last-backup';

    constructor(plugin: Plugin, settings: S3SyncBackupSettings) {
        this.plugin = plugin;
        this.settings = settings;
    }

    /**
     * Set backup trigger callback
     */
    setCallbacks(callbacks: {
        onBackupTrigger?: () => Promise<void>;
        onBackupComplete?: (success: boolean) => void;
    }): void {
        this.onBackupTrigger = callbacks.onBackupTrigger;
        this.onBackupComplete = callbacks.onBackupComplete;
    }

    /**
     * Update settings
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
     * Start the backup scheduler
     * Checks for missed backups and schedules next backup
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
     * Stop the backup scheduler
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
     * Check if backup is due and run if needed
     */
    private async checkAndRunBackup(): Promise<void> {
        if (!this.settings.backupEnabled) return;

        const intervalMs = BACKUP_INTERVAL_MS[this.settings.backupInterval];
        const now = Date.now();

        // Calculate when next backup is due
        const nextDue = (this.lastBackupTime || 0) + intervalMs;

        if (now >= nextDue) {
            // Backup is due
            if (this.settings.debugLogging) {
                console.debug('[S3 Backup] Backup is due, triggering...');
            }

            try {
                await this.onBackupTrigger?.();
                this.lastBackupTime = Date.now();
                await this.saveLastBackupTime();
                this.onBackupComplete?.(true);
            } catch (error) {
                console.error('[S3 Backup] Backup failed:', error);
                this.onBackupComplete?.(false);
            }
        }
    }

    /**
     * Trigger manual backup
     */
    async triggerManualBackup(): Promise<void> {
        if (this.settings.debugLogging) {
            console.debug('[S3 Backup] Manual backup triggered');
        }

        try {
            await this.onBackupTrigger?.();
            this.lastBackupTime = Date.now();
            await this.saveLastBackupTime();
            this.onBackupComplete?.(true);
        } catch (error) {
            console.error('[S3 Backup] Manual backup failed:', error);
            this.onBackupComplete?.(false);
            throw error;
        }
    }

    /**
     * Get last backup time
     */
    getLastBackupTime(): number | null {
        return this.lastBackupTime;
    }

    /**
     * Get next scheduled backup time (approximate)
     */
    getNextBackupTime(): Date | null {
        if (!this.isEnabled || !this.lastBackupTime) return null;

        const intervalMs = BACKUP_INTERVAL_MS[this.settings.backupInterval];
        return new Date(this.lastBackupTime + intervalMs);
    }

    /**
     * Load last backup time from storage
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
     * Save last backup time to storage
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
