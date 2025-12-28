/**
 * Unit tests for RetentionManager module
 *
 * Tests backup retention policy logic including:
 * - Days-based retention (delete backups older than N days)
 * - Copies-based retention (keep only N most recent)
 * - Timestamp parsing from folder names
 */

import { RetentionManager } from '../../src/backup/RetentionManager';
import { S3SyncBackupSettings, BackupInfo } from '../../src/types';

/**
 * Mock S3Provider for testing
 */
const createMockS3Provider = () => ({
    listObjects: jest.fn(),
    downloadFileAsText: jest.fn(),
    deletePrefix: jest.fn(),
});

/**
 * Create test settings
 */
function createTestSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
    return {
        provider: 'r2',
        endpoint: 'https://test.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'test-bucket',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        forcePathStyle: true,
        encryptionEnabled: false,
        syncEnabled: false,
        syncPrefix: 'vault',
        autoSyncEnabled: false,
        syncIntervalMinutes: 5,
        syncOnStartup: false,
        backupEnabled: true,
        backupPrefix: 'backups',
        backupInterval: '1day',
        retentionEnabled: true,
        retentionMode: 'copies',
        retentionDays: 30,
        retentionCopies: 5,
        excludePatterns: [],
        debugLogging: false,
        ...overrides,
    };
}

/**
 * Create mock backup info
 */
function createBackupInfo(name: string, timestamp: string, fileCount = 10, totalSize = 1000): BackupInfo {
    return { name, timestamp, fileCount, totalSize, encrypted: false };
}

describe('RetentionManager', () => {
    describe('applyRetentionPolicy - disabled', () => {
        /**
         * When retention is disabled, no backups should be deleted
         */
        it('should return 0 when retention is disabled', async () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({ retentionEnabled: false });
            const manager = new RetentionManager(mockProvider as never, settings);

            const result = await manager.applyRetentionPolicy();

            expect(result).toBe(0);
            expect(mockProvider.deletePrefix).not.toHaveBeenCalled();
        });
    });

    describe('applyRetentionPolicy - copies mode', () => {
        /**
         * Should delete oldest backups exceeding retentionCopies limit
         */
        it('should delete backups exceeding copies limit', async () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({
                retentionEnabled: true,
                retentionMode: 'copies',
                retentionCopies: 3,
            });

            // Mock 5 backups (should keep 3, delete 2)
            mockProvider.listObjects.mockResolvedValue([
                { key: 'backups/backup-2024-01-05T10-00-00/file.md', size: 100, lastModified: new Date() },
                { key: 'backups/backup-2024-01-04T10-00-00/file.md', size: 100, lastModified: new Date() },
                { key: 'backups/backup-2024-01-03T10-00-00/file.md', size: 100, lastModified: new Date() },
                { key: 'backups/backup-2024-01-02T10-00-00/file.md', size: 100, lastModified: new Date() },
                { key: 'backups/backup-2024-01-01T10-00-00/file.md', size: 100, lastModified: new Date() },
            ]);

            // Mock manifest downloads
            mockProvider.downloadFileAsText.mockImplementation((key: string) => {
                const match = key.match(/backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
                if (match) {
                    const ts = match[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2') + '.000Z';
                    return Promise.resolve(JSON.stringify({
                        timestamp: ts,
                        fileCount: 1,
                        totalSize: 100,
                        encrypted: false,
                    }));
                }
                return Promise.reject(new Error('Not found'));
            });

            const manager = new RetentionManager(mockProvider as never, settings);
            const result = await manager.applyRetentionPolicy();

            // Should delete 2 oldest backups
            expect(result).toBe(2);
            expect(mockProvider.deletePrefix).toHaveBeenCalledTimes(2);
            // Should delete the oldest ones (Jan 1 and Jan 2)
            expect(mockProvider.deletePrefix).toHaveBeenCalledWith('backups/backup-2024-01-01T10-00-00/');
            expect(mockProvider.deletePrefix).toHaveBeenCalledWith('backups/backup-2024-01-02T10-00-00/');
        });

        /**
         * Should not delete when backups equal copies limit
         */
        it('should not delete when exactly at copies limit', async () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({
                retentionEnabled: true,
                retentionMode: 'copies',
                retentionCopies: 3,
            });

            // Mock exactly 3 backups
            mockProvider.listObjects.mockResolvedValue([
                { key: 'backups/backup-2024-01-03T10-00-00/file.md', size: 100, lastModified: new Date() },
                { key: 'backups/backup-2024-01-02T10-00-00/file.md', size: 100, lastModified: new Date() },
                { key: 'backups/backup-2024-01-01T10-00-00/file.md', size: 100, lastModified: new Date() },
            ]);
            mockProvider.downloadFileAsText.mockRejectedValue(new Error('Not found'));

            const manager = new RetentionManager(mockProvider as never, settings);
            const result = await manager.applyRetentionPolicy();

            expect(result).toBe(0);
            expect(mockProvider.deletePrefix).not.toHaveBeenCalled();
        });

        /**
         * Should handle empty backup list
         */
        it('should return 0 for empty backup list', async () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({ retentionEnabled: true, retentionMode: 'copies' });

            mockProvider.listObjects.mockResolvedValue([]);

            const manager = new RetentionManager(mockProvider as never, settings);
            const result = await manager.applyRetentionPolicy();

            expect(result).toBe(0);
        });
    });

    describe('applyRetentionPolicy - days mode', () => {
        /**
         * Should delete backups older than retentionDays
         */
        it('should delete backups older than retention days', async () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({
                retentionEnabled: true,
                retentionMode: 'days',
                retentionDays: 7,
            });

            const now = Date.now();
            const oldTimestamp = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
            const recentTimestamp = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago

            mockProvider.listObjects.mockResolvedValue([
                { key: 'backups/backup-old/file.md', size: 100, lastModified: new Date() },
                { key: 'backups/backup-recent/file.md', size: 100, lastModified: new Date() },
            ]);

            mockProvider.downloadFileAsText.mockImplementation((key: string) => {
                if (key.includes('backup-old')) {
                    return Promise.resolve(JSON.stringify({
                        timestamp: oldTimestamp,
                        fileCount: 1,
                        totalSize: 100,
                        encrypted: false,
                    }));
                }
                return Promise.resolve(JSON.stringify({
                    timestamp: recentTimestamp,
                    fileCount: 1,
                    totalSize: 100,
                    encrypted: false,
                }));
            });

            const manager = new RetentionManager(mockProvider as never, settings);
            const result = await manager.applyRetentionPolicy();

            // Should delete only the old backup
            expect(result).toBe(1);
            expect(mockProvider.deletePrefix).toHaveBeenCalledWith('backups/backup-old/');
        });

        /**
         * Should keep backups within retention period
         */
        it('should keep backups within retention period', async () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({
                retentionEnabled: true,
                retentionMode: 'days',
                retentionDays: 30,
            });

            const now = Date.now();
            const recentTimestamp = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago

            mockProvider.listObjects.mockResolvedValue([
                { key: 'backups/backup-recent/file.md', size: 100, lastModified: new Date() },
            ]);

            mockProvider.downloadFileAsText.mockResolvedValue(JSON.stringify({
                timestamp: recentTimestamp,
                fileCount: 1,
                totalSize: 100,
                encrypted: false,
            }));

            const manager = new RetentionManager(mockProvider as never, settings);
            const result = await manager.applyRetentionPolicy();

            expect(result).toBe(0);
            expect(mockProvider.deletePrefix).not.toHaveBeenCalled();
        });
    });

    describe('parseTimestampFromFolderName', () => {
        /**
         * Test the private method indirectly via listBackups fallback
         * When manifest is missing, it parses timestamp from folder name
         */
        it('should parse timestamp from valid folder name format', async () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings();

            mockProvider.listObjects.mockResolvedValue([
                { key: 'backups/backup-2024-12-25T14-30-00/file.md', size: 100, lastModified: new Date() },
            ]);
            // Simulate missing manifest
            mockProvider.downloadFileAsText.mockRejectedValue(new Error('Not found'));

            const manager = new RetentionManager(mockProvider as never, settings);
            const backups = await manager.listBackups();

            expect(backups.length).toBe(1);
            // Parsed timestamp should be in ISO format
            expect(backups[0].timestamp).toBe('2024-12-25T14:30:00.000Z');
        });

        /**
         * Invalid folder names should fallback to current time
         */
        it('should fallback for invalid folder name format', async () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings();

            mockProvider.listObjects.mockResolvedValue([
                { key: 'backups/backup-invalid-format/file.md', size: 100, lastModified: new Date() },
            ]);
            mockProvider.downloadFileAsText.mockRejectedValue(new Error('Not found'));

            const manager = new RetentionManager(mockProvider as never, settings);
            const before = Date.now();
            const backups = await manager.listBackups();
            const after = Date.now();

            expect(backups.length).toBe(1);
            // Should be a valid ISO timestamp close to now
            const parsed = new Date(backups[0].timestamp).getTime();
            expect(parsed).toBeGreaterThanOrEqual(before);
            expect(parsed).toBeLessThanOrEqual(after);
        });
    });

    describe('updateSettings', () => {
        it('should update settings', () => {
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({ retentionCopies: 5 });
            const manager = new RetentionManager(mockProvider as never, settings);

            const newSettings = createTestSettings({ retentionCopies: 10 });
            manager.updateSettings(newSettings);

            // Settings update is internal, verify by running policy
            // This mainly ensures no crash
            expect(() => manager.updateSettings(newSettings)).not.toThrow();
        });
    });
});
