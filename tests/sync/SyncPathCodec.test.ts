import { SyncPathCodec } from '../../src/sync/SyncPathCodec';

describe('SyncPathCodec', () => {
	const metadataDir = '.obsidian-s3-sync';

	describe('localToRemote', () => {
		it('adds a normalized prefix to local paths', () => {
			const codec = new SyncPathCodec(' //vault\\nested// ');

			expect(codec.localToRemote('/Notes\\daily.md')).toBe('vault/nested/Notes/daily.md');
		});

		it('returns a normalized local path when the prefix is empty', () => {
			const codec = new SyncPathCodec('   ');

			expect(codec.localToRemote('/Notes\\daily.md')).toBe('Notes/daily.md');
		});

		it('returns the normalized prefix when the local path is empty', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.localToRemote('')).toBe('vault');
		});
	});

	describe('remoteToLocal', () => {
		it('removes the configured prefix from matching remote keys', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.remoteToLocal('vault/Notes/daily.md')).toBe('Notes/daily.md');
		});

		it('returns an empty string when the remote key is exactly the prefix', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.remoteToLocal('vault')).toBe('');
		});

		it('returns null when the remote key is outside the configured prefix', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.remoteToLocal('other/Notes/daily.md')).toBeNull();
		});

		it('returns a normalized remote key when the prefix is empty', () => {
			const codec = new SyncPathCodec('');

			expect(codec.remoteToLocal('Notes\\daily.md')).toBe('Notes/daily.md');
		});
	});

	describe('isMetadataKey', () => {
		it('returns true for metadata files inside the configured prefix', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.isMetadataKey(`vault/${metadataDir}/engine.json`)).toBe(true);
		});

		it('returns false for non-metadata files within the prefix', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.isMetadataKey('vault/Notes/daily.md')).toBe(false);
		});

		it('returns false for keys outside the configured prefix', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.isMetadataKey('archive/.obsidian-s3-sync/engine.json')).toBe(false);
		});

		it('returns false for the metadata directory root itself', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.isMetadataKey(`vault/${metadataDir}`)).toBe(false);
		});
	});

	describe('getListPrefix', () => {
		it('returns the normalized prefix with a trailing slash', () => {
			const codec = new SyncPathCodec(' //vault\\nested// ');

			expect(codec.getListPrefix()).toBe('vault/nested/');
		});

		it('returns an empty string when no prefix is configured', () => {
			const codec = new SyncPathCodec('');

			expect(codec.getListPrefix()).toBe('');
		});
	});

	describe('getMetadataDir', () => {
		it('returns the metadata directory key with the configured prefix', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.getMetadataDir()).toBe(`vault/${metadataDir}`);
		});

		it('returns the metadata directory key without a prefix', () => {
			const codec = new SyncPathCodec('');

			expect(codec.getMetadataDir()).toBe(metadataDir);
		});
	});

	describe('getEngineMarkerKey', () => {
		it('returns the engine marker path with the configured prefix', () => {
			const codec = new SyncPathCodec('vault');

			expect(codec.getEngineMarkerKey()).toBe(`vault/${metadataDir}/engine.json`);
		});

		it('returns the engine marker path without a prefix', () => {
			const codec = new SyncPathCodec('');

			expect(codec.getEngineMarkerKey()).toBe(`${metadataDir}/engine.json`);
		});
	});

	describe('updatePrefix', () => {
		it('uses the updated normalized prefix for future operations', () => {
			const codec = new SyncPathCodec('vault');

			codec.updatePrefix(' //archive\\2026// ');

			expect(codec.localToRemote('Notes/daily.md')).toBe('archive/2026/Notes/daily.md');
			expect(codec.remoteToLocal('archive/2026/Notes/daily.md')).toBe('Notes/daily.md');
			expect(codec.getListPrefix()).toBe('archive/2026/');
		});
	});
});
