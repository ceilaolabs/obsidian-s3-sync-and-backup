/**
 * Provider-compatibility matrix — REAL S3 operations against every configured provider.
 *
 * This is the definitive cross-provider suite: it exercises the plugin's *actual*
 * {@link S3Provider} methods (not raw SDK commands) against each provider whose
 * credentials are configured (Cloudflare R2, Backblaze B2, and any future
 * providers added to `TEST_PROVIDERS`). The `S3Provider` is constructed with a
 * Node-compatible client built via {@link createTestS3Client}, which routes
 * through the plugin's production `buildS3ClientConfig` — so these tests validate
 * the exact wire behaviour end users get, including the checksum fix for issue #78.
 *
 * Issue #78 ("not compatible with Backblaze B2") had two distinct causes, both
 * exercised here:
 *   1. The **conditional-write** tests are the true B2 regression — B2's S3 API
 *      does not implement `If-Match`/`If-None-Match` on `PutObject` and returns
 *      `NotImplemented`. They pass only because `S3Provider.uploadFile` emulates
 *      the guard with a `HeadObject` pre-check for providers that lack it.
 *   2. The upload tests also cover the AWS-SDK checksum-portability path (some
 *      S3-compatible providers reject the default `x-amz-checksum-*` headers).
 *
 * Each provider run isolates its objects under a unique `__test__/` prefix and
 * cleans them up in `afterAll`. Requires credentials in `.env` (see `.env.sample`);
 * providers without credentials are skipped automatically.
 */

import { S3Provider } from '../../src/storage/S3Provider';
import {
    TestProvider,
    createTestS3Client,
    createTestSettings,
    describeEachProvider,
    getS3Config,
    getTestPrefix,
} from '../helpers/s3-test-utils';

describeEachProvider()('Provider compatibility [$name]', (provider: TestProvider) => {
    let s3: S3Provider;
    let bucket: string;
    let testPrefix: string;
    const createdKeys: string[] = [];

    beforeAll(() => {
        // Inject the faithful Node client so the real S3Provider talks to the
        // provider's endpoint with the plugin's production client config.
        s3 = new S3Provider(createTestSettings(provider), createTestS3Client(provider));
        bucket = getS3Config(provider).bucket;
        testPrefix = getTestPrefix(`compat-${provider.id}`);
    });

    afterAll(async () => {
        if (createdKeys.length > 0) {
            try {
                await s3.deleteFiles(createdKeys);
            } catch {
                console.warn(`Failed to clean up some test files for ${provider.name}`);
            }
        }
        s3.destroy();
    });

    /** Track a key for afterAll cleanup and return it for inline use. */
    function trackKey(key: string): string {
        createdKeys.push(key);
        return key;
    }

    /**
     * Connectivity: the same operation the settings "Test connection" button runs.
     * Uses bodyless HeadBucket, so it never carried the checksum header that
     * issue #78 tripped over — it succeeded even on B2 before the fix.
     */
    describe('Connection', () => {
        it('connects to the configured bucket', async () => {
            const message = await s3.testConnection();
            expect(message).toContain(bucket);
        });
    });

    /**
     * Upload/download round-trips. These cover the checksum-portability path:
     * PutObject carries a body, so the SDK's default `x-amz-checksum-*` headers
     * are attached unless suppressed — some S3-compatible providers reject them.
     */
    describe('Upload and download', () => {
        it('round-trips UTF-8 text', async () => {
            const key = trackKey(`${testPrefix}/text.md`);
            const content = 'Hello from the provider matrix — issue #78 regression check.';

            await s3.uploadFile(key, content, 'text/markdown');
            const result = await s3.downloadFileAsTextWithEtag(key);

            expect(result?.text).toBe(content);
        });

        it('round-trips binary content', async () => {
            const key = trackKey(`${testPrefix}/binary.bin`);
            const content = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16, 8, 4]);

            await s3.uploadFile(key, content, 'application/octet-stream');
            const downloaded = await s3.downloadFile(key);

            expect(downloaded).toEqual(content);
        });

        it('round-trips a large file (256 KB)', async () => {
            const key = trackKey(`${testPrefix}/large.bin`);
            const content = new Uint8Array(256 * 1024);
            for (let i = 0; i < content.length; i++) {
                content[i] = i % 256;
            }

            await s3.uploadFile(key, content, 'application/octet-stream');
            const downloaded = await s3.downloadFile(key);

            expect(downloaded.length).toBe(content.length);
            expect(downloaded).toEqual(content);
        });

        it('round-trips Unicode content', async () => {
            const key = trackKey(`${testPrefix}/unicode.md`);
            const content = '# 日本語テスト\n\nこんにちは世界 🌍';

            await s3.uploadFile(key, content, 'text/markdown');
            const result = await s3.downloadFileAsTextWithEtag(key);

            expect(result?.text).toBe(content);
        });
    });

    /**
     * Custom object metadata round-trip. The sync engine stores content identity
     * and timing in S3 custom metadata (`obsidian-mtime`, `obsidian-fingerprint`,
     * `obsidian-device-id`); if a provider drops or mangles these, sync breaks.
     */
    describe('Object metadata', () => {
        it('round-trips plugin custom metadata', async () => {
            const key = trackKey(`${testPrefix}/with-metadata.md`);

            await s3.uploadFile(key, 'body with metadata', {
                contentType: 'text/markdown',
                metadata: {
                    'obsidian-mtime': '1717171717000',
                    'obsidian-fingerprint': 'deadbeefcafe',
                    'obsidian-device-id': 'matrix-device',
                },
            });

            const head = await s3.headObject(key);

            expect(head).not.toBeNull();
            expect(head?.clientMtime).toBe(1717171717000);
            expect(head?.fingerprint).toBe('deadbeefcafe');
            expect(head?.deviceId).toBe('matrix-device');
        });
    });

    /**
     * Listing: prefix scoping and empty results. Sync's discovery phase depends
     * on ListObjectsV2 returning every key under the sync prefix.
     */
    describe('List objects', () => {
        it('lists objects under a prefix', async () => {
            const listPrefix = `${testPrefix}/list`;
            await s3.uploadFile(trackKey(`${listPrefix}/a.txt`), 'a');
            await s3.uploadFile(trackKey(`${listPrefix}/b.txt`), 'b');
            await s3.uploadFile(trackKey(`${listPrefix}/nested/c.txt`), 'c');

            const objects = await s3.listObjects(listPrefix);

            expect(objects.length).toBe(3);
            expect(objects.some(o => o.key.endsWith('a.txt'))).toBe(true);
            expect(objects.some(o => o.key.endsWith('b.txt'))).toBe(true);
            expect(objects.some(o => o.key.endsWith('nested/c.txt'))).toBe(true);
        });

        it('returns empty for a non-existent prefix', async () => {
            const objects = await s3.listObjects(`${testPrefix}/does-not-exist`);
            expect(objects).toEqual([]);
        });
    });

    /**
     * Conditional writes back the sync engine's optimistic-concurrency guards
     * (`uploadFile` with `ifNoneMatch: '*'` for create-only, `ifMatch` for
     * update-only). **This is the true issue #78 regression for Backblaze B2**:
     * B2 rejects native conditional `PutObject` with `NotImplemented`, so these
     * pass only because `S3Provider.uploadFile` emulates the guard via a
     * `HeadObject` pre-check for providers that lack native support. Providers
     * with native support (R2/AWS) exercise the real headers.
     */
    describe('Conditional writes', () => {
        it('create-only (If-None-Match: *) rejects an already-existing key', async () => {
            const key = trackKey(`${testPrefix}/cond-create.md`);

            await s3.uploadFile(key, 'first write', { ifNoneMatch: '*' });

            await expect(
                s3.uploadFile(key, 'second write', { ifNoneMatch: '*' }),
            ).rejects.toThrow();
        });

        it('update-only (If-Match) succeeds on the current ETag and fails on a stale one', async () => {
            const key = trackKey(`${testPrefix}/cond-update.md`);

            const firstEtag = await s3.uploadFile(key, 'v1');
            const secondEtag = await s3.uploadFile(key, 'v2', { ifMatch: firstEtag });

            expect(secondEtag).toBeTruthy();
            expect(secondEtag).not.toBe(firstEtag);

            // The first ETag is now stale — an If-Match against it must be rejected.
            await expect(
                s3.uploadFile(key, 'v3', { ifMatch: firstEtag }),
            ).rejects.toThrow();
        });
    });

    /**
     * Deletion. Single-object delete has no required checksum; batch delete
     * (DeleteObjects) is the one operation still checksummed even after the
     * issue #78 fix, so it is the "decide by test" case for B2 compatibility.
     */
    describe('Delete operations', () => {
        it('deletes a single object', async () => {
            const key = `${testPrefix}/delete-single.txt`;
            await s3.uploadFile(key, 'to delete');

            const deleted = await s3.deleteFiles([key]);
            expect(deleted).toBe(1);

            const objects = await s3.listObjects(key);
            expect(objects).toEqual([]);
        });

        it('batch-deletes multiple objects', async () => {
            const batchPrefix = `${testPrefix}/batch-delete`;
            const keys = [
                `${batchPrefix}/file1.txt`,
                `${batchPrefix}/file2.txt`,
                `${batchPrefix}/file3.txt`,
            ];
            for (const key of keys) {
                await s3.uploadFile(key, 'content');
            }

            const deleted = await s3.deleteFiles(keys);
            expect(deleted).toBe(keys.length);

            const objects = await s3.listObjects(batchPrefix);
            expect(objects).toEqual([]);
        });
    });
});
