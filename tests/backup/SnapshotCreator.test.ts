/**
 * Unit tests for SnapshotCreator module
 *
 * Tests backup name generation and file exclusion patterns.
 * Uses mocks for Obsidian App and S3Provider dependencies.
 */

import { SnapshotCreator } from '../../src/backup/SnapshotCreator';
import { hashContent } from '../../src/crypto/Hasher';
import { encrypt } from '../../src/crypto/FileEncryptor';
import { S3SyncBackupSettings } from '../../src/types';
import { readVaultFile } from '../../src/utils/vaultFiles';

jest.mock('../../src/crypto/Hasher', () => ({
    hashContent: jest.fn(),
}));

jest.mock('../../src/crypto/FileEncryptor', () => ({
    encrypt: jest.fn(),
}));

jest.mock('../../src/utils/vaultFiles', () => ({
    readVaultFile: jest.fn(),
}));

const mockedHashContent = jest.mocked(hashContent);
const mockedEncrypt = jest.mocked(encrypt);
const mockedReadVaultFile = jest.mocked(readVaultFile);

/**
 * Create mock App (Obsidian)
 */
const createMockApp = () => ({
    vault: {
        configDir: '.obsidian',
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
 * Create a mock vault file.
 */
const createMockFile = (path: string, size = 100) => ({
    path,
    stat: {
        size,
        mtime: 1000,
        ctime: 1000,
    },
});

/**
 * Access private backupFile method for tests.
 */
const getBackupFile = (creator: SnapshotCreator): (file: never, backupName: string, checksums: Record<string, string>) => Promise<void> => {
    return (creator as unknown as { backupFile: (file: never, backupName: string, checksums: Record<string, string>) => Promise<void> }).backupFile.bind(creator);
};

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
    beforeEach(() => {
        jest.clearAllMocks();
    });

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

    describe('createSnapshot', () => {
        /**
         * Should upload all files and manifest when backup succeeds.
         */
        it('should create a successful snapshot without exclusions', async () => {
            const mockApp = createMockApp();
            mockApp.vault.getFiles.mockReturnValue([
                createMockFile('notes/test.md'),
                createMockFile('attachments/image.png', 250),
            ]);
            const mockProvider = createMockS3Provider();
            mockProvider.uploadFile.mockResolvedValue(undefined);
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            mockedReadVaultFile.mockImplementation(async (_vault, file) => {
                if (file.path === 'notes/test.md') return 'hello world';
                return new Uint8Array([1, 2, 3]);
            });
            mockedHashContent.mockImplementation(async (content) => `hash-${content.length}`);

            const result = await creator.createSnapshot('device-1', 'My Device');

            expect(result.success).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.filesBackedUp).toBe(2);
            expect(mockProvider.uploadFile).toHaveBeenCalledTimes(3);

            const manifestCall = mockProvider.uploadFile.mock.calls[2];
            expect(manifestCall[0]).toMatch(/^backups\/backup-/);
            expect(manifestCall[0]).toContain('/.backup-manifest.json');
            expect(JSON.parse(manifestCall[1] as string)).toMatchObject({
                version: 1,
                deviceId: 'device-1',
                deviceName: 'My Device',
                fileCount: 2,
                totalSize: 350,
                encrypted: false,
            });
            expect(manifestCall[2]).toEqual({ contentType: 'application/json' });
        });

        /**
         * Should capture file-specific errors and continue creating the manifest.
         */
        it('should capture errors from individual files', async () => {
            const mockApp = createMockApp();
            mockApp.vault.getFiles.mockReturnValue([
                createMockFile('notes/test.md'),
                createMockFile('attachments/broken.png'),
            ]);
            const mockProvider = createMockS3Provider();
            mockProvider.uploadFile.mockResolvedValue(undefined);
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            mockedReadVaultFile.mockImplementation(async (_vault, file) => {
                if (file.path === 'attachments/broken.png') {
                    throw new Error('read failed');
                }

                return 'ok';
            });
            mockedHashContent.mockResolvedValue('checksum');

            const result = await creator.createSnapshot('device-1', 'My Device');

            expect(result.success).toBe(false);
            expect(result.filesBackedUp).toBe(1);
            expect(result.errors).toEqual(['attachments/broken.png: read failed']);
            expect(mockProvider.uploadFile).toHaveBeenCalledTimes(2);
        });

        /**
         * Should encrypt file content before upload when encryption is enabled.
         */
        it('should encrypt uploaded content when encryption is enabled', async () => {
            const mockApp = createMockApp();
            mockApp.vault.getFiles.mockReturnValue([createMockFile('notes/test.md')]);
            const mockProvider = createMockS3Provider();
            mockProvider.uploadFile.mockResolvedValue(undefined);
            const settings = createTestSettings({ encryptionEnabled: true });
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);
            const encryptionKey = new Uint8Array(32);
            creator.setEncryptionKey(encryptionKey);

            const encryptedBytes = new Uint8Array([9, 8, 7]);
            mockedReadVaultFile.mockResolvedValue('secret note');
            mockedHashContent.mockResolvedValue('checksum');
            mockedEncrypt.mockReturnValue(encryptedBytes);

            const result = await creator.createSnapshot('device-1', 'My Device');

            expect(result.success).toBe(true);
            expect(mockedEncrypt).toHaveBeenCalledWith(expect.any(Uint8Array), encryptionKey);
            expect(mockProvider.uploadFile).toHaveBeenNthCalledWith(1, expect.stringContaining('backup-'), encryptedBytes);
            expect(mockProvider.uploadFile).toHaveBeenNthCalledWith(2, expect.stringContaining('/.backup-manifest.json'), expect.any(String), { contentType: 'application/json' });
        });

        /**
         * Should skip files that match configured exclude patterns.
         */
        it('should skip excluded files', async () => {
            const mockApp = createMockApp();
            mockApp.vault.getFiles.mockReturnValue([
                createMockFile('notes/test.md'),
                createMockFile('temp/file.tmp'),
            ]);
            const mockProvider = createMockS3Provider();
            mockProvider.uploadFile.mockResolvedValue(undefined);
            const settings = createTestSettings({ excludePatterns: ['temp/**'] });
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

            mockedReadVaultFile.mockResolvedValue('content');
            mockedHashContent.mockResolvedValue('checksum');

            const result = await creator.createSnapshot('device-1', 'My Device');

            expect(result.success).toBe(true);
            expect(result.filesBackedUp).toBe(1);
            expect(mockedReadVaultFile).toHaveBeenCalledTimes(1);
            expect(mockProvider.uploadFile).toHaveBeenCalledTimes(2);
        });

        /**
         * Should emit debug output when debug logging is enabled.
         */
        it('should log snapshot completion when debug logging is enabled', async () => {
            const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
            try {
                const mockApp = createMockApp();
                mockApp.vault.getFiles.mockReturnValue([createMockFile('notes/test.md')]);
                const mockProvider = createMockS3Provider();
                mockProvider.uploadFile.mockResolvedValue(undefined);
                const settings = createTestSettings({ debugLogging: true });
                const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);

                mockedReadVaultFile.mockResolvedValue('content');
                mockedHashContent.mockResolvedValue('checksum');

                const result = await creator.createSnapshot('device-1', 'My Device');

                expect(result.success).toBe(true);
                expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('[S3 Backup] Snapshot created:'));
            } finally {
                debugSpy.mockRestore();
            }
        });
    });

    describe('backupFile', () => {
        /**
         * Should upload plain text content without encryption.
         */
        it('should upload text files as strings', async () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            mockProvider.uploadFile.mockResolvedValue(undefined);
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);
            const backupFile = getBackupFile(creator);
            const checksums: Record<string, string> = {};

            mockedReadVaultFile.mockResolvedValue('text content');
            mockedHashContent.mockResolvedValue('text-hash');

            await backupFile(createMockFile('notes/test.md') as never, 'backup-2026-04-08T00-00-00', checksums);

            expect(checksums['notes/test.md']).toBe('sha256:text-hash');
            expect(mockProvider.uploadFile).toHaveBeenCalledWith(
                'backups/backup-2026-04-08T00-00-00/notes/test.md',
                'text content'
            );
        });

        /**
         * Should upload binary content as bytes.
         */
        it('should upload binary files as bytes', async () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            mockProvider.uploadFile.mockResolvedValue(undefined);
            const settings = createTestSettings();
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);
            const backupFile = getBackupFile(creator);
            const checksums: Record<string, string> = {};
            const binaryContent = new Uint8Array([1, 2, 3, 4]);

            mockedReadVaultFile.mockResolvedValue(binaryContent);
            mockedHashContent.mockResolvedValue('binary-hash');

            await backupFile(createMockFile('attachments/image.png', 250) as never, 'backup-2026-04-08T00-00-00', checksums);

            expect(checksums['attachments/image.png']).toBe('sha256:binary-hash');
            expect(mockProvider.uploadFile).toHaveBeenCalledWith(
                'backups/backup-2026-04-08T00-00-00/attachments/image.png',
                binaryContent
            );
        });

        /**
         * Should encrypt file bytes before upload when encryption is enabled.
         */
        it('should encrypt backup file content when encryption is enabled', async () => {
            const mockApp = createMockApp();
            const mockProvider = createMockS3Provider();
            mockProvider.uploadFile.mockResolvedValue(undefined);
            const settings = createTestSettings({ encryptionEnabled: true });
            const creator = new SnapshotCreator(mockApp as never, mockProvider as never, settings);
            creator.setEncryptionKey(new Uint8Array(32));
            const backupFile = getBackupFile(creator);
            const checksums: Record<string, string> = {};
            const plainBytes = new Uint8Array([5, 6, 7]);
            const encryptedBytes = new Uint8Array([9, 9, 9]);

            mockedReadVaultFile.mockResolvedValue(plainBytes);
            mockedHashContent.mockResolvedValue('encrypted-hash');
            mockedEncrypt.mockReturnValue(encryptedBytes);

            await backupFile(createMockFile('attachments/private.bin', 300) as never, 'backup-2026-04-08T00-00-00', checksums);

            expect(mockedEncrypt).toHaveBeenCalledWith(plainBytes, expect.any(Uint8Array));
            expect(checksums['attachments/private.bin']).toBe('sha256:encrypted-hash');
            expect(mockProvider.uploadFile).toHaveBeenCalledWith(
                'backups/backup-2026-04-08T00-00-00/attachments/private.bin',
                encryptedBytes
            );
        });
    });
});
