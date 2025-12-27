/**
 * Unit tests for time utilities
 */

import {
    formatRelativeTime,
    formatDuration,
    formatBytes,
    generateBackupTimestamp,
    parseBackupTimestamp,
} from '../../src/utils/time';

describe('Time Utils', () => {
    describe('formatRelativeTime', () => {
        it('should format "just now" for recent times', () => {
            const now = Date.now();
            expect(formatRelativeTime(now)).toBe('just now');
            expect(formatRelativeTime(now - 30000)).toBe('just now'); // 30s ago
        });

        it('should format minutes', () => {
            const now = Date.now();
            expect(formatRelativeTime(now - 2 * 60 * 1000)).toBe('2m ago');
            expect(formatRelativeTime(now - 45 * 60 * 1000)).toBe('45m ago');
        });

        it('should format hours', () => {
            const now = Date.now();
            expect(formatRelativeTime(now - 2 * 60 * 60 * 1000)).toBe('2h ago');
            expect(formatRelativeTime(now - 12 * 60 * 60 * 1000)).toBe('12h ago');
        });

        it('should format days', () => {
            const now = Date.now();
            expect(formatRelativeTime(now - 2 * 24 * 60 * 60 * 1000)).toBe('2d ago');
            expect(formatRelativeTime(now - 5 * 24 * 60 * 60 * 1000)).toBe('5d ago');
        });

        it('should format weeks', () => {
            const now = Date.now();
            expect(formatRelativeTime(now - 14 * 24 * 60 * 60 * 1000)).toBe('2w ago');
        });

        it('should handle null timestamp', () => {
            expect(formatRelativeTime(null)).toBe('');
        });
    });

    describe('formatDuration', () => {
        it('should format milliseconds', () => {
            expect(formatDuration(500)).toBe('500ms');
        });

        it('should format seconds', () => {
            expect(formatDuration(5000)).toBe('5s');
            expect(formatDuration(45000)).toBe('45s');
        });

        it('should format minutes and seconds', () => {
            expect(formatDuration(90000)).toBe('1m 30s');
            expect(formatDuration(150000)).toBe('2m 30s');
        });

        it('should format minutes without seconds', () => {
            expect(formatDuration(120000)).toBe('2m');
        });

        it('should format hours and minutes', () => {
            expect(formatDuration(5400000)).toBe('1h 30m');
        });

        it('should format hours without minutes', () => {
            expect(formatDuration(7200000)).toBe('2h');
        });
    });

    describe('formatBytes', () => {
        it('should format bytes', () => {
            expect(formatBytes(0)).toBe('0 B');
            expect(formatBytes(500)).toBe('500 B');
        });

        it('should format kilobytes', () => {
            expect(formatBytes(1024)).toBe('1.0 KB');
            expect(formatBytes(1536)).toBe('1.5 KB');
        });

        it('should format megabytes', () => {
            expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
            expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
        });

        it('should format gigabytes', () => {
            expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
        });
    });

    describe('generateBackupTimestamp', () => {
        it('should generate timestamp in correct format', () => {
            const timestamp = generateBackupTimestamp();

            // Format: 2024-12-26T21-00-00
            expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
        });

        it('should use dashes instead of colons', () => {
            const timestamp = generateBackupTimestamp();

            expect(timestamp).not.toContain(':');
        });
    });

    describe('parseBackupTimestamp', () => {
        it('should parse backup folder name to Date', () => {
            const date = parseBackupTimestamp('backup-2024-12-26T21-30-00');

            expect(date).toBeInstanceOf(Date);
            expect(date?.getFullYear()).toBe(2024);
            expect(date?.getMonth()).toBe(11); // December (0-indexed)
            expect(date?.getDate()).toBe(26);
        });

        it('should return null for invalid format', () => {
            expect(parseBackupTimestamp('invalid')).toBeNull();
            expect(parseBackupTimestamp('backup-invalid')).toBeNull();
        });

        it('should roundtrip correctly', () => {
            const timestamp = generateBackupTimestamp();
            const backupName = `backup-${timestamp}`;
            const parsed = parseBackupTimestamp(backupName);

            expect(parsed).toBeInstanceOf(Date);
        });
    });
});
