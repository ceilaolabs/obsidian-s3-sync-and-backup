/**
 * Commands Module
 *
 * Registers all command palette commands for the plugin.
 */

import { Notice } from 'obsidian';
import type S3SyncBackupPlugin from './main';

/**
 * Command IDs - must be stable after release
 */
export const COMMAND_IDS = {
    SYNC_NOW: 's3-sync-backup:sync-now',
    BACKUP_NOW: 's3-sync-backup:backup-now',
    PAUSE_SYNC: 's3-sync-backup:pause-sync',
    RESUME_SYNC: 's3-sync-backup:resume-sync',
    VIEW_SYNC_LOG: 's3-sync-backup:view-sync-log',
    VIEW_BACKUPS: 's3-sync-backup:view-backups',
    OPEN_SETTINGS: 's3-sync-backup:open-settings',
};

/**
 * Register all plugin commands
 */
export function registerCommands(plugin: S3SyncBackupPlugin): void {
    // Sync now
    plugin.addCommand({
        id: 'sync-now',
        name: 'Sync now',
        callback: async () => {
            if (!plugin.settings.syncEnabled) {
                new Notice('Sync is disabled. Enable it in settings.');
                return;
            }
            new Notice('Starting sync...');
            // @ts-ignore - accessing internal method
            await plugin.triggerManualSync?.();
        },
    });

    // Backup now
    plugin.addCommand({
        id: 'backup-now',
        name: 'Backup now',
        callback: async () => {
            if (!plugin.settings.backupEnabled) {
                new Notice('Backup is disabled. Enable it in settings.');
                return;
            }
            new Notice('Starting backup...');
            // @ts-ignore - accessing internal method
            await plugin.triggerManualBackup?.();
        },
    });

    // Pause sync
    plugin.addCommand({
        id: 'pause-sync',
        name: 'Pause sync',
        checkCallback: (checking: boolean) => {
            // Only show if sync is enabled and not paused
            if (plugin.settings.syncEnabled && plugin.settings.autoSyncEnabled) {
                if (!checking) {
                    // @ts-ignore - accessing internal method
                    plugin.pauseSync?.();
                    new Notice('Sync paused');
                }
                return true;
            }
            return false;
        },
    });

    // Resume sync
    plugin.addCommand({
        id: 'resume-sync',
        name: 'Resume sync',
        checkCallback: (checking: boolean) => {
            // Only show if sync is paused
            if (plugin.settings.syncEnabled) {
                if (!checking) {
                    // @ts-ignore - accessing internal method
                    plugin.resumeSync?.();
                    new Notice('Sync resumed');
                }
                return true;
            }
            return false;
        },
    });

    // View sync log
    plugin.addCommand({
        id: 'view-sync-log',
        name: 'View sync log',
        callback: () => {
            new Notice('Sync log viewer coming soon');
        },
    });

    // View backups
    plugin.addCommand({
        id: 'view-backups',
        name: 'View backups',
        callback: () => {
            // Open settings to backup section
            (plugin.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
            (plugin.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById('obsidian-s3-sync-and-backup');
        },
    });

    // Open settings
    plugin.addCommand({
        id: 'open-settings',
        name: 'Open settings',
        callback: () => {
            (plugin.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
            (plugin.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById('obsidian-s3-sync-and-backup');
        },
    });
}
