/**
 * Unit tests for RemoteSyncStore manifest conflict handling.
 */

import { RemoteSyncManifestChangedError, RemoteSyncStore } from '../../src/sync/RemoteSyncStore';

function createMockS3Provider() {
	return {
		getFileMetadata: jest.fn(),
		downloadFileAsText: jest.fn(),
		downloadFileAsTextWithEtag: jest.fn(),
		uploadFile: jest.fn(),
	};
}

describe('RemoteSyncStore', () => {
	it('touches a device entry under the current sync prefix', async () => {
		const s3Provider = createMockS3Provider();
		const store = new RemoteSyncStore(s3Provider as never, 'vault');
		const deviceInfo = {
			deviceId: 'device-a',
			deviceName: 'Laptop',
			platform: 'macos',
			lastSeenAt: 1000,
			createdAt: 500,
			manifestGeneration: 2,
		};

		await store.touchDevice(deviceInfo);

		expect(s3Provider.uploadFile).toHaveBeenCalledWith(
			'vault/.obsidian-s3-sync/devices/device-a.json',
			JSON.stringify(deviceInfo, null, 2),
			{ contentType: 'application/json' },
		);
	});

	it('identifies metadata keys under the sync metadata directory', () => {
		const store = new RemoteSyncStore(createMockS3Provider() as never, 'vault');

		expect(store.isMetadataKey('vault/.obsidian-s3-sync/manifest.json')).toBe(true);
		expect(store.isMetadataKey('vault/.obsidian-s3-sync/devices/device-a.json')).toBe(true);
		expect(store.isMetadataKey('vault/notes/note.md')).toBe(false);
	});

	it('updates the sync prefix used by subsequent keys', () => {
		const store = new RemoteSyncStore(createMockS3Provider() as never, 'vault');

		expect(store.getManifestKey()).toBe('vault/.obsidian-s3-sync/manifest.json');
		store.updateSyncPrefix('archive');
		expect(store.getManifestKey()).toBe('archive/.obsidian-s3-sync/manifest.json');
	});

	it('saves the manifest with an existing etag', async () => {
		const s3Provider = createMockS3Provider();
		s3Provider.uploadFile.mockResolvedValue('etag-2');
		const store = new RemoteSyncStore(s3Provider as never, 'vault');
		const manifest = store.createEmptyManifest();

		await store.saveManifest(manifest, 'etag-1');

		expect(s3Provider.uploadFile).toHaveBeenCalledWith(
			'vault/.obsidian-s3-sync/manifest.json',
			JSON.stringify(manifest, null, 2),
			{
				contentType: 'application/json',
				ifMatch: 'etag-1',
				ifNoneMatch: undefined,
			},
		);
	});

	it('uses ifNoneMatch when saving a new manifest', async () => {
		const s3Provider = createMockS3Provider();
		s3Provider.uploadFile.mockResolvedValue('etag-1');
		const store = new RemoteSyncStore(s3Provider as never, 'vault');
		const manifest = store.createEmptyManifest();

		await store.saveManifest(manifest, null);

		expect(s3Provider.uploadFile).toHaveBeenCalledWith(
			'vault/.obsidian-s3-sync/manifest.json',
			JSON.stringify(manifest, null, 2),
			{
				contentType: 'application/json',
				ifMatch: undefined,
				ifNoneMatch: '*',
			},
		);
	});

	it('creates an empty manifest with the expected shape', () => {
		const store = new RemoteSyncStore(createMockS3Provider() as never, 'vault');

		expect(store.createEmptyManifest()).toEqual({
			version: 1,
			generation: 0,
			updatedAt: 0,
			updatedBy: '',
			files: {},
			tombstones: {},
		});
	});

	it('maps HTTP 412 manifest writes to a manifest changed error', async () => {
		const s3Provider = createMockS3Provider();
		s3Provider.uploadFile.mockRejectedValue({
			name: 'PreconditionFailed',
			$metadata: { httpStatusCode: 412 },
		});

		const store = new RemoteSyncStore(s3Provider as never, 'vault');

		await expect(store.saveManifest(store.createEmptyManifest(), 'etag-1')).rejects.toBeInstanceOf(RemoteSyncManifestChangedError);
	});

	it('maps HTTP 409 manifest writes to a manifest changed error', async () => {
		const s3Provider = createMockS3Provider();
		s3Provider.uploadFile.mockRejectedValue({
			name: 'ConditionalRequestConflict',
			$metadata: { httpStatusCode: 409 },
		});

		const store = new RemoteSyncStore(s3Provider as never, 'vault');

		await expect(store.saveManifest(store.createEmptyManifest(), 'etag-1')).rejects.toBeInstanceOf(RemoteSyncManifestChangedError);
	});

	describe('loadManifest', () => {
		it('uses downloadFileAsTextWithEtag instead of separate head+get calls (M6 fix)', async () => {
			const s3Provider = createMockS3Provider();
			const manifestData = {
				version: 1,
				generation: 5,
				updatedAt: 1000,
				updatedBy: 'device-a',
				files: {},
				tombstones: {},
			};
			s3Provider.downloadFileAsTextWithEtag.mockResolvedValue({
				text: JSON.stringify(manifestData),
				etag: 'etag-123',
			});

			const store = new RemoteSyncStore(s3Provider as never, 'vault');
			const result = await store.loadManifest();

			expect(s3Provider.downloadFileAsTextWithEtag).toHaveBeenCalledTimes(1);
			expect(s3Provider.downloadFileAsTextWithEtag).toHaveBeenCalledWith(
				'vault/.obsidian-s3-sync/manifest.json',
			);
			expect(s3Provider.getFileMetadata).not.toHaveBeenCalled();
			expect(s3Provider.downloadFileAsText).not.toHaveBeenCalled();
			expect(result.existed).toBe(true);
			expect(result.etag).toBe('etag-123');
			expect(result.manifest.generation).toBe(5);
		});

		it('returns empty manifest when downloadFileAsTextWithEtag returns null', async () => {
			const s3Provider = createMockS3Provider();
			s3Provider.downloadFileAsTextWithEtag.mockResolvedValue(null);

			const store = new RemoteSyncStore(s3Provider as never, 'vault');
			const result = await store.loadManifest();

			expect(result.existed).toBe(false);
			expect(result.etag).toBeNull();
			expect(result.manifest.generation).toBe(0);
		});

		it('normalizes partial manifest from S3', async () => {
			const s3Provider = createMockS3Provider();
			s3Provider.downloadFileAsTextWithEtag.mockResolvedValue({
				text: JSON.stringify({
					files: { 'a.md': { path: 'a.md', contentHash: 'h1' } },
				}),
				etag: 'etag-x',
			});

			const store = new RemoteSyncStore(s3Provider as never, 'vault');
			const result = await store.loadManifest();

			expect(result.manifest.version).toBe(1);
			expect(result.manifest.generation).toBe(0);
			expect(result.manifest.tombstones).toEqual({});
			expect(result.manifest.files['a.md']).toEqual({ path: 'a.md', contentHash: 'h1' });
		});
	});
});
