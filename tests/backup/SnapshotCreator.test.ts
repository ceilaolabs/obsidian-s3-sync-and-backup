/**
 * Unit tests for SnapshotCreator module
 *
 * Tests backup name generation and file exclusion patterns.
 * Uses mocks for Obsidian App and S3Provider dependencies.
 */

import { SnapshotCreator } from '../../src/backup/SnapshotCreator';
import { S3SyncBackupSettings } from '../../src/types';

/**
 * Create mock App (Obsidian)
 */
const createMockApp = () => ({
    vault: {
        getFiles: jest.fn().mockReturnValue([]),
        read: jest.fn().mockResolvedValue('content'),
    },
});

/**
 * Create mock S3Provider
 */
const createMockS3Provider = () => ({
    uploadFile: jest.fn(),
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
        retentionEnabled: false,
        retentionMode: 'copies',
        retentionDays: 30,
        retentionCopies: 5,
        excludePatterns: [],
        debugLogging: false,
        ...overrides,
    };
}

describe('SnapshotCreator', () => {
    describe('generateBackupName', () => {
        /**
         * Access private method via reflection for testing
         */
        function getBackupName(creator: SnapshotCreator): string {
            return (creator as unknown as { generateBackupName: () => string }).generateBackupName();
        }

        /**
         * Should generate valid backup folder name format
         */
        it('should generate backup name with timestamp format', () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            const name = getBackupName(creator);

            // Format: backup-YYYY-MM-DDTHH-MM-SS
            expect(name).toMatch(/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
        });

        /**
         * Should use colons replaced with dashes
         */
        it('should not contain colons in timestamp', () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            const name = getBackupName(creator);

            expect(name).not.toContain(':');
        });

        /**
         * Should not contain milliseconds
         */
        it('should not contain milliseconds', () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            const name = getBackupName(creator);

            expect(name).not.toMatch(/\.\d{3}/);
        });
    });

    describe('shouldExclude', () => {
        /**
         * Access private method via reflection
         */
        function testExclude(patterns: string[], path: string): boolean {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({ excludePatterns: patterns });
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            return (creator as unknown as { shouldExclude: (path: string) => boolean }).shouldExclude(path);
        }

        /**
         * Single wildcard pattern
         */
        it('should exclude files matching *.tmp', () => {
            expect(testExclude(['*.tmp'], 'file.tmp')).toBe(true);
            expect(testExclude(['*.tmp'], 'file.md')).toBe(false);
        });

        /**
         * Double wildcard for recursive matching
         * Note: Current regex matches one level after **
         */
        it('should exclude files matching subdirectory patterns', () => {
            expect(testExclude(['**/*.log'], 'dir/file.log')).toBe(true);
        });

        /**
         * Directory pattern - matches files directly in the directory
         */
        it('should exclude files in .obsidian/**', () => {
            expect(testExclude(['.obsidian/**'], '.obsidian/config.json')).toBe(true);
            expect(testExclude(['.obsidian/**'], 'notes.md')).toBe(false);
        });

        /**
         * Multiple patterns
         */
        it('should exclude files matching any pattern', () => {
            const patterns = ['*.tmp', '.git/**', '.trash/*'];
            expect(testExclude(patterns, 'temp.tmp')).toBe(true);
            expect(testExclude(patterns, '.git/config')).toBe(true);
            expect(testExclude(patterns, '.trash/old.md')).toBe(true);
            expect(testExclude(patterns, 'notes.md')).toBe(false);
        });

        /**
         * Empty patterns
         */
        it('should not exclude anything with empty patterns', () => {
            expect(testExclude([], 'file.tmp')).toBe(false);
            expect(testExclude([], '.obsidian/config')).toBe(false);
        });
    });

    describe('setEncryptionKey', () => {
        it('should accept encryption key', () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            const key = new Uint8Array(32);
            expect(() => creator.setEncryptionKey(key)).not.toThrow();
        });

        it('should accept null to clear key', () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            expect(() => creator.setEncryptionKey(null)).not.toThrow();
        });
    });

    describe('updateSettings', () => {
        it('should update settings', () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            const settings = createTestSettings({ backupPrefix: 'old-prefix' });
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            const newSettings = createTestSettings({ backupPrefix: 'new-prefix' });
            expect(() => creator.updateSettings(newSettings)).not.toThrow();
        });
    });
});
