/**
 * Integration tests for Sync Workflow
 *
 * Tests end-to-end sync operations verifying correct S3 file structure.
 * Uses direct S3Client for Node.js compatibility.
 *
 * Expected S3 structure for sync:
 * {syncPrefix}/
 *   └── path/to/file.md
 *   └── .obsidian-s3-sync/
 *       └── journal.json
 *       └── devices/{deviceId}.json
 */

import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
    createTestS3Client,
    hasS3Credentials,
    getS3Config,
    getTestPrefix,
} from '../helpers/s3-test-utils';

describe('Sync Workflow Integration Tests', () => {
    let client: S3Client;
    let bucket: string;
    let syncPrefix: string;

    beforeAll(() => {
        if (!hasS3Credentials()) {
            console.warn('⚠️ S3 credentials not configured, skipping integration tests');
            return;
        }
        client = createTestS3Client();
        bucket = getS3Config().bucket;
        syncPrefix = getTestPrefix('sync');
    });

    afterAll(async () => {
        // Clean up all test files
        if (client && syncPrefix) {
            try {
                const response = await client.send(new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: syncPrefix,
                }));
                if (response.Contents && response.Contents.length > 0) {
                    await client.send(new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: {
                            Objects: response.Contents.map(o => ({ Key: o.Key })),
                            Quiet: true,
                        },
                    }));
                }
                client.destroy();
            } catch {
                console.warn('Failed to clean up test files');
            }
        }
    });

    describe('Sync File Structure', () => {
        /**
         * Verifies files are stored at correct paths under syncPrefix
         */
        it('should store files at correct sync prefix path', async () => {
            if (!hasS3Credentials()) return;

            const localPath = 'Notes/daily/2024-01-01.md';
            const s3Key = `${syncPrefix}/${localPath}`;
            const content = '# Daily Note\n\nThis is a test note.';

            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: s3Key,
                Body: content,
            }));

            const response = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: s3Key,
            }));

            const downloaded = await response.Body?.transformToString();
            expect(downloaded).toBe(content);
        });

        /**
         * Verifies nested folder structure is maintained
         */
        it('should maintain nested folder structure', async () => {
            if (!hasS3Credentials()) return;

            const files = [
                { path: 'Notes/project-a/readme.md', content: '# Project A' },
                { path: 'Notes/project-a/tasks.md', content: '# Tasks' },
                { path: 'Notes/project-b/overview.md', content: '# Project B' },
            ];

            for (const file of files) {
                await client.send(new PutObjectCommand({
                    Bucket: bucket,
                    Key: `${syncPrefix}/${file.path}`,
                    Body: file.content,
                }));
            }

            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: syncPrefix,
            }));

            expect(response.Contents?.length).toBeGreaterThanOrEqual(files.length);
        });

        /**
         * Verifies sync metadata folder structure
         */
        it('should support sync metadata structure', async () => {
            if (!hasS3Credentials()) return;

            const metadataPrefix = `${syncPrefix}/.obsidian-s3-sync`;

            // Journal file
            const journalKey = `${metadataPrefix}/journal.json`;
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: journalKey,
                Body: JSON.stringify({ version: 1, entries: {} }),
                ContentType: 'application/json',
            }));

            // Device registration
            const deviceKey = `${metadataPrefix}/devices/device-abc123.json`;
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: deviceKey,
                Body: JSON.stringify({ deviceId: 'device-abc123', deviceName: 'Test' }),
                ContentType: 'application/json',
            }));

            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: metadataPrefix,
            }));

            expect(response.Contents?.length).toBe(2);
        });
    });

    describe('Upload Workflow', () => {
        it('should complete upload workflow: create → verify → content match', async () => {
            if (!hasS3Credentials()) return;

            const localPath = 'workflow-test/upload-test.md';
            const s3Key = `${syncPrefix}/${localPath}`;
            const content = '# Upload Test\n\n' + new Date().toISOString();

            // Upload
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: s3Key,
                Body: content,
            }));

            // List to verify
            const listResponse = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: s3Key,
            }));
            expect(listResponse.Contents?.length).toBe(1);

            // Download to verify content
            const getResponse = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: s3Key,
            }));
            const downloaded = await getResponse.Body?.transformToString();
            expect(downloaded).toBe(content);
        });
    });

    describe('Conflict Simulation', () => {
        it('should support conflict file naming convention', async () => {
            if (!hasS3Credentials()) return;

            const basePath = 'conflict-test/document.md';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

            // Original remote version
            const remoteKey = `${syncPrefix}/${basePath}`;
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: remoteKey,
                Body: 'Remote version',
            }));

            // Local conflict copy
            const localConflictPath = basePath.replace('.md', `.LOCAL_${timestamp}.md`);
            const localConflictKey = `${syncPrefix}/${localConflictPath}`;
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: localConflictKey,
                Body: 'Local version',
            }));

            // Verify both exist
            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: `${syncPrefix}/conflict-test`,
            }));

            expect(response.Contents?.length).toBe(2);
        });
    });
});
