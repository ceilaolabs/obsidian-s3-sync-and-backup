/**
 * Commands Module
 *
 * Exports `COMMAND_IDS` constants and the `registerCommands` function for the plugin's
 * command palette entries.
 *
 * **Architecture note:** This module was originally intended as the central command
 * registry, but the primary command registrations now live in `main.ts` via
 * `registerCommands()` on the plugin class, because those commands require direct
 * access to private plugin methods (e.g., `triggerManualSync`, `pauseSync`,
 * `resumeSync`). This standalone module is kept for future refactoring and to provide
 * a stable home for the `COMMAND_IDS` constants, which must remain unchanged across
 * releases so that user-defined hotkey bindings continue to work.
 */

import { Notice } from 'obsidian';
import type S3SyncBackupPlugin from './main';

/**
 * Stable command IDs used to register all plugin commands with Obsidian.
 *
 * These IDs are included in user hotkey configuration stored in `.obsidian/hotkeys.json`.
 * Once a release ships, an ID MUST NEVER be changed or removed — doing so silently
 * breaks any hotkey bindings users have configured for that command. New commands can
 * freely add new IDs, but existing ones are effectively part of the plugin's public API.
 *
 * The full command ID registered with Obsidian is `{pluginId}:{COMMAND_IDS value}`.
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
 * Register all additional plugin commands with Obsidian's command palette.
 *
 * Note: The core sync/backup commands (sync-now, backup-now, pause-sync, resume-sync,
 * open-settings) are already registered in `main.ts` via the plugin's private
 * `registerCommands()` method, because those require access to private plugin methods.
 * This function registers supplementary commands and is provided for future use.
 *
 * The `@ts-ignore` annotations below suppress TypeScript errors that arise when calling
 * plugin methods that are public at runtime but not declared on the `Plugin` type in
 * Obsidian's type definitions (e.g., `triggerManualSync`, `pauseSync`). These are
 * safe to call — the methods exist on the actual `S3SyncBackupPlugin` instance.
 *
 * @param plugin - The `S3SyncBackupPlugin` instance on which to register commands.
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
            (plugin.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById('simple-storage-sync-and-backup');
        },
    });

    // Open settings
    plugin.addCommand({
        id: 'open-settings',
        name: 'Open settings',
        callback: () => {
            (plugin.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
            (plugin.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById('simple-storage-sync-and-backup');
        },
    });
}
