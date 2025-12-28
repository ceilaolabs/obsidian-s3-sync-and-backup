/**
 * Unit tests for ConflictHandler module
 *
 * Tests conflict path generation, detection, and resolution tracking.
 * Uses mocks for Obsidian App and SyncJournal dependencies.
 */

// Mock Obsidian module before importing ConflictHandler
jest.mock('obsidian', () => ({
    App: jest.fn(),
    Modal: class MockModal {
        constructor() { }
        open() { }
        close() { }
    },
    TFile: jest.fn(),
}));

import { ConflictHandler } from '../../src/sync/ConflictHandler';

/**
 * Create mock App (Obsidian)
 */
const createMockApp = () => ({
    vault: {
        getAbstractFileByPath: jest.fn(),
        rename: jest.fn(),
        create: jest.fn(),
        createFolder: jest.fn(),
    },
});

/**
 * Create mock SyncJournal
 */
const createMockJournal = () => ({
    markConflict: jest.fn(),
    deleteEntry: jest.fn(),
    getConflictedEntries: jest.fn().mockResolvedValue([]),
});

describe('ConflictHandler', () => {
    describe('generateConflictPaths', () => {
        /**
         * Root-level file should have LOCAL_ and REMOTE_ prefixes
         */
        it('should generate paths for root-level file', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const handler = new ConflictHandler(mockApp as never, mockJournal as never);

            // Access private method via type assertion for testing
            const generatePaths = (handler as unknown as { generateConflictPaths: (path: string) => { localPath: string; remotePath: string } }).generateConflictPaths.bind(handler);
            const result = generatePaths('document.md');

            expect(result.localPath).toBe('LOCAL_document.md');
            expect(result.remotePath).toBe('REMOTE_document.md');
        });

        /**
         * Nested file should preserve directory structure
         */
        it('should generate paths for nested file', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const handler = new ConflictHandler(mockApp as never, mockJournal as never);

            const generatePaths = (handler as unknown as { generateConflictPaths: (path: string) => { localPath: string; remotePath: string } }).generateConflictPaths.bind(handler);
            const result = generatePaths('Notes/daily/2024-01-01.md');

            expect(result.localPath).toBe('Notes/daily/LOCAL_2024-01-01.md');
            expect(result.remotePath).toBe('Notes/daily/REMOTE_2024-01-01.md');
        });

        /**
         * Deep nesting should be preserved
         */
        it('should handle deeply nested paths', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const handler = new ConflictHandler(mockApp as never, mockJournal as never);

            const generatePaths = (handler as unknown as { generateConflictPaths: (path: string) => { localPath: string; remotePath: string } }).generateConflictPaths.bind(handler);
            const result = generatePaths('Projects/2024/Q1/notes.md');

            expect(result.localPath).toBe('Projects/2024/Q1/LOCAL_notes.md');
            expect(result.remotePath).toBe('Projects/2024/Q1/REMOTE_notes.md');
        });
    });

    describe('isConflictFile', () => {
        let handler: ConflictHandler;

        beforeEach(() => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            handler = new ConflictHandler(mockApp as never, mockJournal as never);
        });

        /**
         * LOCAL_ prefix should be detected
         */
        it('should detect LOCAL_ prefix', () => {
            expect(handler.isConflictFile('LOCAL_document.md')).toBe(true);
            expect(handler.isConflictFile('Notes/LOCAL_file.md')).toBe(true);
        });

        /**
         * REMOTE_ prefix should be detected
         */
        it('should detect REMOTE_ prefix', () => {
            expect(handler.isConflictFile('REMOTE_document.md')).toBe(true);
            expect(handler.isConflictFile('Notes/REMOTE_file.md')).toBe(true);
        });

        /**
         * Normal files should not be detected
         */
        it('should return false for normal files', () => {
            expect(handler.isConflictFile('document.md')).toBe(false);
            expect(handler.isConflictFile('Notes/file.md')).toBe(false);
        });

        /**
         * Prefix in directory name should not trigger
         */
        it('should not match prefix in directory name', () => {
            expect(handler.isConflictFile('LOCAL_folder/normal.md')).toBe(false);
            expect(handler.isConflictFile('REMOTE_backup/file.md')).toBe(false);
        });
    });

    describe('getOriginalPath', () => {
        let handler: ConflictHandler;

        beforeEach(() => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            handler = new ConflictHandler(mockApp as never, mockJournal as never);
        });

        /**
         * Extract original from LOCAL_ file
         */
        it('should extract original path from LOCAL_ file', () => {
            expect(handler.getOriginalPath('LOCAL_document.md')).toBe('document.md');
            expect(handler.getOriginalPath('Notes/LOCAL_file.md')).toBe('Notes/file.md');
        });

        /**
         * Extract original from REMOTE_ file
         */
        it('should extract original path from REMOTE_ file', () => {
            expect(handler.getOriginalPath('REMOTE_document.md')).toBe('document.md');
            expect(handler.getOriginalPath('Notes/REMOTE_file.md')).toBe('Notes/file.md');
        });

        /**
         * Non-conflict files return null
         */
        it('should return null for non-conflict file', () => {
            expect(handler.getOriginalPath('normal.md')).toBeNull();
            expect(handler.getOriginalPath('Notes/document.md')).toBeNull();
        });

        /**
         * Handle deep nesting
         */
        it('should handle deeply nested conflict paths', () => {
            expect(handler.getOriginalPath('A/B/C/LOCAL_note.md')).toBe('A/B/C/note.md');
            expect(handler.getOriginalPath('A/B/C/REMOTE_note.md')).toBe('A/B/C/note.md');
        });
    });

    describe('conflict tracking', () => {
        /**
         * Active conflicts should be tracked
         */
        it('should track active conflicts', async () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

            const handler = new ConflictHandler(mockApp as never, mockJournal as never);

            await handler.handleConflict('test.md', 'local content', 'remote content');

            expect(handler.getConflictCount()).toBe(1);
            expect(handler.getActiveConflicts().length).toBe(1);
        });

        /**
         * Resolving should remove from active
         */
        it('should remove resolved conflicts', async () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

            const handler = new ConflictHandler(mockApp as never, mockJournal as never);

            await handler.handleConflict('test.md', 'local', 'remote');
            expect(handler.getConflictCount()).toBe(1);

            await handler.markResolved('test.md');
            expect(handler.getConflictCount()).toBe(0);
        });
    });

    describe('handleConflict', () => {
        /**
         * Should create LOCAL_ and REMOTE_ files
         */
        it('should create conflict files and track conflict', async () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

            const handler = new ConflictHandler(mockApp as never, mockJournal as never);

            const result = await handler.handleConflict(
                'Notes/doc.md',
                'local version',
                'remote version'
            );

            expect(result.path).toBe('Notes/doc.md');
            expect(result.localPath).toBe('Notes/LOCAL_doc.md');
            expect(result.remotePath).toBe('Notes/REMOTE_doc.md');
            expect(result.resolved).toBe(false);

            // Verify vault operations
            expect(mockApp.vault.create).toHaveBeenCalledWith('Notes/LOCAL_doc.md', 'local version');
            expect(mockApp.vault.create).toHaveBeenCalledWith('Notes/REMOTE_doc.md', 'remote version');
        });

        /**
         * Should update journal
         */
        it('should mark conflict in journal', async () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

            const handler = new ConflictHandler(mockApp as never, mockJournal as never);

            await handler.handleConflict('test.md', 'local', 'remote');

            expect(mockJournal.markConflict).toHaveBeenCalledWith('test.md', '', '');
        });
    });
});
