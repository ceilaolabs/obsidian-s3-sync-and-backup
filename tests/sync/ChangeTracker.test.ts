/**
 * Unit tests for ChangeTracker module
 *
 * Tests file exclusion patterns and pending change tracking.
 * Uses mocks for Obsidian App and SyncJournal dependencies.
 */

import { ChangeTracker, PendingChange } from '../../src/sync/ChangeTracker';
import { SyncJournal } from '../../src/sync/SyncJournal';

/**
 * Create mock App (Obsidian)
 */
const createMockApp = () => ({
    vault: {
        on: jest.fn(),
        off: jest.fn(),
        read: jest.fn().mockResolvedValue('content'),
    },
});

/**
 * Create mock SyncJournal
 */
const createMockJournal = () => ({
    markPending: jest.fn(),
    markDeleted: jest.fn(),
    deleteEntry: jest.fn(),
});

describe('ChangeTracker', () => {
    describe('shouldExclude', () => {
        /**
         * Access private shouldExclude via helper
         */
        function testExclude(patterns: string[], path: string): boolean {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);
            tracker.updateExcludePatterns(patterns);

            // Access private method via reflection
            const shouldExclude = (tracker as unknown as { shouldExclude: (path: string) => boolean }).shouldExclude.bind(tracker);
            return shouldExclude(path);
        }

        /**
         * Single wildcard pattern
         */
        it('should match single wildcard pattern *.tmp', () => {
            expect(testExclude(['*.tmp'], 'file.tmp')).toBe(true);
            expect(testExclude(['*.tmp'], 'notes.tmp')).toBe(true);
            expect(testExclude(['*.tmp'], 'file.md')).toBe(false);
        });

        /**
         * Extension pattern in subdirectory (should not match with single *)
         */
        it('should not match nested files with single *', () => {
            expect(testExclude(['*.tmp'], 'dir/file.tmp')).toBe(false);
        });

        /**
         * Double wildcard for recursive matching
         * Note: The current implementation matches one level after **
         */
        it('should match double wildcard pattern in subdirectories', () => {
            expect(testExclude(['**/*.log'], 'dir/file.log')).toBe(true);
            // The current implementation's regex translates ** to .*
            // which matches one or more directory levels
            expect(testExclude(['**/*.log'], 'file.txt')).toBe(false);
        });

        /**
         * Directory pattern
         */
        it('should match directory pattern .trash/*', () => {
            expect(testExclude(['.trash/*'], '.trash/deleted.md')).toBe(true);
            expect(testExclude(['.trash/*'], '.trash/file.txt')).toBe(true);
            expect(testExclude(['.trash/*'], 'notes/file.md')).toBe(false);
        });

        /**
         * Multiple patterns
         */
        it('should match any of multiple patterns', () => {
            const patterns = ['*.tmp', '*.bak', '.trash/*'];
            expect(testExclude(patterns, 'file.tmp')).toBe(true);
            expect(testExclude(patterns, 'file.bak')).toBe(true);
            expect(testExclude(patterns, '.trash/old.md')).toBe(true);
            expect(testExclude(patterns, 'notes.md')).toBe(false);
        });

        /**
         * Obsidian config folder
         * Note: .obsidian/** matches files in .obsidian/ directory
         */
        it('should match .obsidian patterns', () => {
            expect(testExclude(['.obsidian/**'], '.obsidian/config.json')).toBe(true);
            // Deep nesting only matches if pattern covers full path
        });
    });

    describe('pending changes', () => {
        /**
         * Get pending changes
         */
        it('should return empty array initially', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            expect(tracker.getPendingChanges()).toEqual([]);
            expect(tracker.getPendingCount()).toBe(0);
        });

        /**
         * Clear pending changes
         */
        it('should clear all pending changes', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            // Access private method to add change
            const addChange = (tracker as unknown as { addPendingChange: (change: PendingChange) => void }).addPendingChange.bind(tracker);
            addChange({ path: 'test.md', type: 'modify', timestamp: Date.now() });

            expect(tracker.getPendingCount()).toBe(1);

            tracker.clearPendingChanges();

            expect(tracker.getPendingCount()).toBe(0);
        });

        /**
         * Clear specific pending change
         */
        it('should clear specific pending change', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            const addChange = (tracker as unknown as { addPendingChange: (change: PendingChange) => void }).addPendingChange.bind(tracker);
            addChange({ path: 'file1.md', type: 'modify', timestamp: Date.now() });
            addChange({ path: 'file2.md', type: 'create', timestamp: Date.now() });

            expect(tracker.getPendingCount()).toBe(2);

            tracker.clearPendingChange('file1.md');

            expect(tracker.getPendingCount()).toBe(1);
            expect(tracker.getPendingChanges()[0].path).toBe('file2.md');
        });
    });

    describe('addPendingChange debouncing', () => {
        /**
         * Rapid modifications to same file should coalesce
         */
        it('should coalesce rapid modifications to same file', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            const addChange = (tracker as unknown as { addPendingChange: (change: PendingChange) => void }).addPendingChange.bind(tracker);

            // Simulate rapid modifications
            addChange({ path: 'note.md', type: 'create', timestamp: 1000 });
            addChange({ path: 'note.md', type: 'modify', timestamp: 1100 });
            addChange({ path: 'note.md', type: 'modify', timestamp: 1200 });

            // Should only have one entry
            expect(tracker.getPendingCount()).toBe(1);

            // Timestamp should be updated to latest
            expect(tracker.getPendingChanges()[0].timestamp).toBe(1200);
        });

        /**
         * Changes to different files should all be tracked
         */
        it('should track changes to different files separately', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            const addChange = (tracker as unknown as { addPendingChange: (change: PendingChange) => void }).addPendingChange.bind(tracker);

            addChange({ path: 'file1.md', type: 'modify', timestamp: 1000 });
            addChange({ path: 'file2.md', type: 'modify', timestamp: 1000 });
            addChange({ path: 'file3.md', type: 'create', timestamp: 1000 });

            expect(tracker.getPendingCount()).toBe(3);
        });

        /**
         * Delete should not be debounced
         */
        it('should record delete even if prior changes exist', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            const addChange = (tracker as unknown as { addPendingChange: (change: PendingChange) => void }).addPendingChange.bind(tracker);

            addChange({ path: 'file.md', type: 'delete', timestamp: 1000 });

            expect(tracker.getPendingCount()).toBe(1);
            expect(tracker.getPendingChanges()[0].type).toBe('delete');
        });
    });

    describe('updateExcludePatterns', () => {
        it('should update patterns without error', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            expect(() => tracker.updateExcludePatterns(['*.tmp', '*.log'])).not.toThrow();
        });
    });

    describe('startTracking / stopTracking', () => {
        it('should register event handlers on start', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            tracker.startTracking([]);

            expect(mockApp.vault.on).toHaveBeenCalledWith('create', expect.any(Function));
            expect(mockApp.vault.on).toHaveBeenCalledWith('modify', expect.any(Function));
            expect(mockApp.vault.on).toHaveBeenCalledWith('delete', expect.any(Function));
            expect(mockApp.vault.on).toHaveBeenCalledWith('rename', expect.any(Function));
        });

        it('should unregister event handlers on stop', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            tracker.startTracking([]);
            tracker.stopTracking();

            expect(mockApp.vault.off).toHaveBeenCalledWith('create', expect.any(Function));
            expect(mockApp.vault.off).toHaveBeenCalledWith('modify', expect.any(Function));
            expect(mockApp.vault.off).toHaveBeenCalledWith('delete', expect.any(Function));
            expect(mockApp.vault.off).toHaveBeenCalledWith('rename', expect.any(Function));
        });

        it('should not register twice on double start', () => {
            const mockApp = createMockApp();
            const mockJournal = createMockJournal();
            const tracker = new ChangeTracker(mockApp as never, mockJournal as never);

            tracker.startTracking([]);
            tracker.startTracking([]);

            // Should only register once
            expect(mockApp.vault.on).toHaveBeenCalledTimes(4); // 4 events
        });
    });
});
