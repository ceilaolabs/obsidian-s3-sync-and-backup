/**
 * Integration tests for raw S3 operations — per provider.
 *
 * These tests perform REAL S3 operations against every configured S3-compatible
 * bucket (Cloudflare R2, Backblaze B2, …). They use a direct `S3Client` (built
 * via the plugin's production config through `createTestS3Client`) rather than
 * `S3Provider`, to validate wire-level SDK behaviour independently of the
 * higher-level provider wrapper. For plugin-method coverage see
 * `ProviderCompatibility.integration.test.ts`.
 *
 * Test files are created under a unique `__test__/` prefix and cleaned up after
 * the run. Providers without credentials are skipped automatically
 * (see `.env.sample`).
 */

import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
    TestProvider,
    createTestS3Client,
    getS3Config,
    getTestPrefix,
    describeEachProvider,
} from '../helpers/s3-test-utils';

describeEachProvider()('S3 Integration Tests [$name]', (provider: TestProvider) => {
    let client: S3Client;
    let bucket: string;
    let testPrefix: string;
    const createdKeys: string[] = [];

    beforeAll(() => {
        client = createTestS3Client(provider);
        bucket = getS3Config(provider).bucket;
        testPrefix = getTestPrefix('s3');
    });

    afterAll(async () => {
        // Clean up all created test files
        if (client && createdKeys.length > 0) {
            try {
                await client.send(new DeleteObjectsCommand({
                    Bucket: bucket,
                    Delete: {
                        Objects: createdKeys.map(key => ({ Key: key })),
                        Quiet: true,
                    },
                }));
            } catch {
                console.warn(`Failed to clean up some test files for ${provider.name}`);
            }
            client.destroy();
        }
    });

    function trackKey(key: string): string {
        createdKeys.push(key);
        return key;
    }

    describe('Connection', () => {
        it('should successfully connect to configured bucket', async () => {
            const response = await client.send(new HeadBucketCommand({
                Bucket: bucket,
            }));

            expect(response.$metadata.httpStatusCode).toBe(200);
        });
    });

    describe('Upload and Download', () => {
        it('should upload and download text content', async () => {
            const key = trackKey(`${testPrefix}/test-text.txt`);
            const content = 'Hello, S3 Integration Test!';

            // Upload
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: content,
            }));

            // Download
            const response = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key,
            }));

            const downloaded = await response.Body?.transformToString();
            expect(downloaded).toBe(content);
        });

        it('should upload and download binary content', async () => {
            const key = trackKey(`${testPrefix}/test-binary.bin`);
            const content = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16, 8, 4]);

            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: content,
            }));

            const response = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key,
            }));

            const downloaded = await response.Body?.transformToByteArray();
            expect(downloaded).toEqual(content);
        });

        it('should handle large files (100KB)', async () => {
            const key = trackKey(`${testPrefix}/test-large.bin`);
            const content = new Uint8Array(100 * 1024);
            for (let i = 0; i < content.length; i++) {
                content[i] = i % 256;
            }

            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: content,
            }));

            const response = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key,
            }));

            const downloaded = await response.Body?.transformToByteArray();
            expect(downloaded?.length).toBe(content.length);
        });

        it('should handle Unicode content', async () => {
            const key = trackKey(`${testPrefix}/test-unicode.md`);
            const content = '# 日本語テスト\n\nこんにちは世界 🌍';

            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: content,
            }));

            const response = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key,
            }));

            const downloaded = await response.Body?.transformToString();
            expect(downloaded).toBe(content);
        });
    });

    describe('List Objects', () => {
        it('should list objects under a prefix', async () => {
            const listPrefix = `${testPrefix}/list-test`;

            // Create test files
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: trackKey(`${listPrefix}/file1.txt`),
                Body: 'content1',
            }));
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: trackKey(`${listPrefix}/file2.txt`),
                Body: 'content2',
            }));
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: trackKey(`${listPrefix}/subdir/file3.txt`),
                Body: 'content3',
            }));

            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: listPrefix,
            }));

            expect(response.Contents?.length).toBe(3);
            expect(response.Contents?.some(o => o.Key?.endsWith('file1.txt'))).toBe(true);
            expect(response.Contents?.some(o => o.Key?.endsWith('file2.txt'))).toBe(true);
            expect(response.Contents?.some(o => o.Key?.endsWith('file3.txt'))).toBe(true);
        });

        it('should return empty for non-existent prefix', async () => {
            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: `${testPrefix}/non-existent-${Date.now()}`,
            }));

            expect(response.Contents || []).toEqual([]);
        });
    });

    describe('Delete Operations', () => {
        it('should delete a single file', async () => {
            const key = `${testPrefix}/delete-single.txt`;

            // Create
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: 'to delete',
            }));

            // Delete
            await client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: key,
            }));

            // Verify deleted (list should not include it)
            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: key,
            }));

            expect(response.Contents || []).toHaveLength(0);
        });

        it('should delete multiple files', async () => {
            const keys = [
                `${testPrefix}/batch-delete/file1.txt`,
                `${testPrefix}/batch-delete/file2.txt`,
                `${testPrefix}/batch-delete/file3.txt`,
            ];

            // Create files
            for (const key of keys) {
                await client.send(new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: 'content',
                }));
            }

            // Batch delete
            await client.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: keys.map(Key => ({ Key })),
                    Quiet: true,
                },
            }));

            // Verify all deleted
            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: `${testPrefix}/batch-delete`,
            }));

            expect(response.Contents || []).toHaveLength(0);
        });
    });
});
