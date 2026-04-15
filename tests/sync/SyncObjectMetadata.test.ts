import type { SyncUploadMetadata } from '../../src/types';
import {
	decodeMetadata,
	encodeMetadata,
	getCurrentSyncVersion,
} from '../../src/sync/SyncObjectMetadata';

describe('SyncObjectMetadata', () => {
	describe('encodeMetadata', () => {
		it('encodes sync metadata into S3 metadata headers', () => {
			const metadata: SyncUploadMetadata = {
				fingerprint: 'sha256:abc123',
				clientMtime: 1712345678901,
				deviceId: 'device-1',
			};

			expect(encodeMetadata(metadata)).toEqual({
				'obsidian-sync-version': '2',
				'obsidian-fingerprint': 'sha256:abc123',
				'obsidian-mtime': '1712345678901',
				'obsidian-device-id': 'device-1',
			});
		});
	});

	describe('decodeMetadata', () => {
		it('returns an empty object when metadata is missing', () => {
			expect(decodeMetadata(undefined)).toEqual({});
		});

		it('decodes all known metadata fields when values are valid', () => {
			expect(
				decodeMetadata({
					'obsidian-sync-version': '12',
					'obsidian-fingerprint': 'sha256:def456',
					'obsidian-mtime': '1712345678901',
					'obsidian-device-id': 'device-2',
				})
			).toEqual({
				syncVersion: 12,
				fingerprint: 'sha256:def456',
				clientMtime: 1712345678901,
				deviceId: 'device-2',
			});
		});

		it('omits numeric fields when they are not valid integers', () => {
			expect(
				decodeMetadata({
					'obsidian-sync-version': 'v2',
					'obsidian-mtime': 'not-a-number',
				})
			).toEqual({});
		});

		it('preserves defined string fields even when they are empty', () => {
			expect(
				decodeMetadata({
					'obsidian-fingerprint': '',
					'obsidian-device-id': '',
				})
			).toEqual({
				fingerprint: '',
				deviceId: '',
			});
		});

		it('ignores unknown keys and missing known keys', () => {
			expect(
				decodeMetadata({
					other: 'value',
					'obsidian-fingerprint': 'sha256:xyz789',
				})
			).toEqual({
				fingerprint: 'sha256:xyz789',
			});
		});
	});

	describe('getCurrentSyncVersion', () => {
		it('returns the current metadata version used for encoding', () => {
			expect(getCurrentSyncVersion()).toBe(2);
		});
	});
});
