/**
 * Sync Scheduler Module
 *
 * Manages periodic sync scheduling and sync-on-startup functionality.
 */

import { Plugin } from 'obsidian';
import { SyncEngine } from './SyncEngine';
import { S3SyncBackupSettings, SyncIntervalMinutes } from '../types';

/**
 * SyncScheduler class - Manages sync timing
 */
export class SyncScheduler {
    private plugin: Plugin;
    private syncEngine: SyncEngine;
    private settings: S3SyncBackupSettings;
    private intervalId: number | null = null;
    private isEnabled = false;
    private isPaused = false;

    // Callback for status updates
    private onSyncStart?: () => void;
    private onSyncComplete?: (success: boolean, conflictCount: number) => void;
    private onSyncError?: (error: string) => void;

    constructor(plugin: Plugin, syncEngine: SyncEngine, settings: S3SyncBackupSettings) {
        this.plugin = plugin;
        this.syncEngine = syncEngine;
        this.settings = settings;
    }

    /**
     * Set status callbacks
     */
    setCallbacks(callbacks: {
        onSyncStart?: () => void;
        onSyncComplete?: (success: boolean, conflictCount: number) => void;
        onSyncError?: (error: string) => void;
    }): void {
        this.onSyncStart = callbacks.onSyncStart;
        this.onSyncComplete = callbacks.onSyncComplete;
        this.onSyncError = callbacks.onSyncError;
    }

    /**
     * Update settings
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
     * Start the scheduler
     */
    start(): void {
        if (this.isEnabled) return;
        if (!this.settings.syncEnabled || !this.settings.autoSyncEnabled) return;

        this.isEnabled = true;
        this.isPaused = false;

        // Calculate interval in milliseconds
        const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;

        // Register interval with plugin for auto-cleanup
        this.intervalId = this.plugin.registerInterval(
            window.setInterval(() => {
                if (!this.isPaused) {
                    this.triggerSync('scheduled');
                }
            }, intervalMs)
        ) as unknown as number;

        if (this.settings.debugLogging) {
            console.log(`[S3 Sync] Scheduler started: every ${this.settings.syncIntervalMinutes} minutes`);
        }
    }

    /**
     * Stop the scheduler
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
            console.log('[S3 Sync] Scheduler stopped');
        }
    }

    /**
     * Pause the scheduler (keeps interval but skips syncs)
     */
    pause(): void {
        this.isPaused = true;
        if (this.settings.debugLogging) {
            console.log('[S3 Sync] Scheduler paused');
        }
    }

    /**
     * Resume the scheduler
     */
    resume(): void {
        this.isPaused = false;
        if (this.settings.debugLogging) {
            console.log('[S3 Sync] Scheduler resumed');
        }
    }

    /**
     * Check if scheduler is paused
     */
    getIsPaused(): boolean {
        return this.isPaused;
    }

    /**
     * Trigger a sync operation
     */
    async triggerSync(trigger: 'manual' | 'scheduled' | 'startup'): Promise<void> {
        if (this.syncEngine.isInProgress()) {
            if (this.settings.debugLogging) {
                console.log('[S3 Sync] Skipping - sync already in progress');
            }
            return;
        }

        if (this.settings.debugLogging) {
            console.log(`[S3 Sync] Triggering sync: ${trigger}`);
        }

        this.onSyncStart?.();

        try {
            const result = await this.syncEngine.sync();

            this.onSyncComplete?.(result.success, result.conflicts.length);

            if (result.errors.length > 0 && this.settings.debugLogging) {
                console.log('[S3 Sync] Errors:', result.errors);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.onSyncError?.(errorMessage);
            console.error('[S3 Sync] Sync failed:', error);
        }
    }

    /**
     * Get next scheduled sync time (approximate)
     */
    getNextSyncTime(): Date | null {
        if (!this.isEnabled || this.isPaused) return null;

        const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
        return new Date(Date.now() + intervalMs);
    }
}
