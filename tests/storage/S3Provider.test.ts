/**
 * Unit tests for S3Provider request shaping.
 */

import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3Provider } from '../../src/storage/S3Provider';
import { S3SyncBackupSettings } from '../../src/types';

function createSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		provider: 'aws',
		endpoint: '',
		region: 'us-east-1',
		bucket: 'test-bucket',
		accessKeyId: 'test-key',
		secretAccessKey: 'test-secret',
		forcePathStyle: false,
		encryptionEnabled: false,
		syncEnabled: true,
		syncPrefix: 'vault',
		autoSyncEnabled: false,
		syncIntervalMinutes: 5,
		syncOnStartup: false,
		backupEnabled: false,
		backupPrefix: 'backups',
		backupInterval: '1day',
		retentionEnabled: false,
		retentionMode: 'copies',
		retentionDays: 30,
		retentionCopies: 30,
		excludePatterns: [],
		debugLogging: false,
		...overrides,
	};
}

describe('S3Provider', () => {
	it('quotes If-Match ETags for conditional uploads', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({ ETag: '"returned-etag"' });
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		const etag = await provider.uploadFile('vault/test.md', 'hello', {
			ifMatch: 'abc123',
			ifNoneMatch: '*',
		});

		const command = send.mock.calls[0][0] as PutObjectCommand;
		expect(command).toBeInstanceOf(PutObjectCommand);
		expect(command.input.IfMatch).toBe('"abc123"');
		expect(command.input.IfNoneMatch).toBe('*');
		expect(etag).toBe('returned-etag');
	});

	it('preserves already quoted conditional ETags', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({ ETag: '"returned-etag"' });
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		await provider.uploadFile('vault/test.md', 'hello', {
			ifMatch: '"abc123"',
		});

		const command = send.mock.calls[0][0] as PutObjectCommand;
		expect(command.input.IfMatch).toBe('"abc123"');
	});

	describe('downloadFileAsTextWithEtag', () => {
		it('returns text content and cleaned ETag', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({
				Body: new TextEncoder().encode('hello world'),
				ETag: '"abc123"',
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/test.md');

			expect(result).toEqual({ text: 'hello world', etag: 'abc123' });
		});

		it('returns null for NoSuchKey errors', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockRejectedValue({ name: 'NoSuchKey' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/missing.md');

			expect(result).toBeNull();
		});

		it('returns null for NotFound errors', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockRejectedValue({ name: 'NotFound' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/missing.md');

			expect(result).toBeNull();
		});

		it('re-throws non-not-found errors', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockRejectedValue(new Error('Network error'));
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			await expect(provider.downloadFileAsTextWithEtag('vault/test.md')).rejects.toThrow('Network error');
		});

		it('handles string body response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({ Body: 'plain text', ETag: '"etag-str"' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/test.md');

			expect(result).toEqual({ text: 'plain text', etag: 'etag-str' });
		});
	});

	/**
	 * Regression coverage for the ETag normalization contract. S3-compatible
	 * storage (notably Cloudflare R2) can return weak entity-tags of the form
	 * `W/"abc"`. Every S3Provider method that surfaces an ETag to callers must
	 * strip both the `W/` weak-tag prefix and surrounding double-quotes so the
	 * sync engine can compare ETags against its own bare-form baselines.
	 */
	describe('ETag normalization', () => {
		it('strips W/ weak prefix from getFileEtag response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({ ETag: 'W/"weak-etag"' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const etag = await provider.getFileEtag('vault/test.md');

			expect(etag).toBe('weak-etag');
		});

		it('strips W/ weak prefix from downloadFileAsTextWithEtag response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({
				Body: new TextEncoder().encode('payload'),
				ETag: 'W/"weak-etag"',
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/test.md');

			expect(result).toEqual({ text: 'payload', etag: 'weak-etag' });
		});

		it('strips W/ weak prefix from listObjects entries', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({
				Contents: [
					{ Key: 'vault/a.md', Size: 1, LastModified: new Date(0), ETag: 'W/"weak-a"' },
					{ Key: 'vault/b.md', Size: 2, LastModified: new Date(0), ETag: '"strong-b"' },
				],
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const objects = await provider.listObjects('vault/');

			expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
			expect(objects.map((o) => o.etag)).toEqual(['weak-a', 'strong-b']);
		});

		it('strips W/ weak prefix from uploadFile response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({ ETag: 'W/"weak-uploaded"' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const etag = await provider.uploadFile('vault/test.md', 'hello');

			expect(etag).toBe('weak-uploaded');
		});

		it('strips W/ weak prefix from getFileMetadata response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({
				ETag: 'W/"weak-meta"',
				ContentLength: 42,
				LastModified: new Date(0),
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const info = await provider.getFileMetadata('vault/test.md');

			expect(info?.etag).toBe('weak-meta');
		});

		it('returns null from getFileEtag when the response ETag is missing', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({ ETag: undefined });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const etag = await provider.getFileEtag('vault/test.md');

			expect(etag).toBeNull();
		});
	});
});
