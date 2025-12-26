/**
 * Time Utility Module
 *
 * Provides time formatting utilities for status bar display.
 */

/**
 * Format timestamp as relative time string
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
    const weeks = Math.floor(diff / (7 * 24 * 60 * 60 * 1000));
    return `${weeks}w ago`;
}

/**
 * Format timestamp as absolute date/time string
 *
 * @param timestamp - Epoch timestamp in milliseconds
 * @returns Formatted date string
 */
export function formatDateTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

/**
 * Format timestamp as date only
 *
 * @param timestamp - Epoch timestamp in milliseconds
 * @returns Formatted date string (e.g., "Dec 25, 2024")
 */
export function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

/**
 * Format duration in milliseconds to human readable string
 *
 * @param ms - Duration in milliseconds
 * @returns Human readable duration (e.g., "2h 30m", "45s")
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }

    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        const remainingSeconds = seconds % 60;
        return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Format bytes to human readable size
 *
 * @param bytes - Size in bytes
 * @returns Human readable size (e.g., "1.5 MB", "256 KB")
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Generate ISO timestamp for backup naming
 * Format: 2024-12-25T14-30-00 (colons replaced with dashes)
 */
export function generateBackupTimestamp(): string {
    return new Date()
        .toISOString()
        .replace(/:/g, '-')
        .replace(/\.\d{3}Z$/, '');
}

/**
 * Parse backup timestamp from folder name
 */
export function parseBackupTimestamp(backupName: string): Date | null {
    const match = backupName.match(/^backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/);
    if (!match || !match[1]) return null;

    // Convert back to ISO format
    const isoString = match[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2') + '.000Z';
    return new Date(isoString);
}
