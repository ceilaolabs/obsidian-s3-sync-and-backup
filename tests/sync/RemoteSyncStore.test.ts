/**
 * Unit tests for RemoteSyncStore manifest conflict handling.
 */

import { RemoteSyncManifestChangedError, RemoteSyncStore } from '../../src/sync/RemoteSyncStore';

function createMockS3Provider() {
	return {
		getFileMetadata: jest.fn(),
		downloadFileAsText: jest.fn(),
		uploadFile: jest.fn(),
	};
}

describe('RemoteSyncStore', () => {
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
});
