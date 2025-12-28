/**
 * Integration tests for Backup Workflow
 *
 * Tests backup operations verifying correct S3 file structure.
 * Uses direct S3Client for Node.js compatibility.
 *
 * Expected S3 structure for backups:
 * {backupPrefix}/
 *   └── backup-{ISO_TIMESTAMP}/
 *       └── .backup-manifest.json
 *       └── path/to/file.md
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
import { BackupManifest } from '../../src/types';

describe('Backup Workflow Integration Tests', () => {
    let client: S3Client;
    let bucket: string;
    let backupPrefix: string;

    beforeAll(() => {
        if (!hasS3Credentials()) {
            console.warn('⚠️ S3 credentials not configured, skipping integration tests');
            return;
        }
        client = createTestS3Client();
        bucket = getS3Config().bucket;
        backupPrefix = getTestPrefix('backup');
    });

    afterAll(async () => {
        if (client && backupPrefix) {
            try {
                const response = await client.send(new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: backupPrefix,
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

    /**
     * Generate backup folder name matching SnapshotCreator
     */
    function generateBackupName(): string {
        const now = new Date();
        const isoString = now.toISOString()
            .replace(/:/g, '-')
            .replace(/\.\d{3}Z$/, '');
        return `backup-${isoString}`;
    }

    describe('Backup File Structure', () => {
        it('should create backup folder with timestamp naming', async () => {
            if (!hasS3Credentials()) return;

            const backupName = generateBackupName();
            const testFile = `${backupPrefix}/${backupName}/Notes/test.md`;

            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: testFile,
                Body: '# Test backup',
            }));

            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: `${backupPrefix}/${backupName}`,
            }));

            expect(response.Contents?.length).toBe(1);
            expect(response.Contents?.[0].Key).toContain(backupName);
        });

        it('should maintain complete backup structure with manifest', async () => {
            if (!hasS3Credentials()) return;

            const backupName = generateBackupName() + '-full';
            const files = [
                { path: 'Notes/readme.md', content: '# Readme' },
                { path: 'Notes/project/tasks.md', content: '# Tasks' },
            ];

            // Upload files
            for (const file of files) {
                await client.send(new PutObjectCommand({
                    Bucket: bucket,
                    Key: `${backupPrefix}/${backupName}/${file.path}`,
                    Body: file.content,
                }));
            }

            // Create manifest
            const manifest: BackupManifest = {
                version: 1,
                timestamp: new Date().toISOString(),
                deviceId: 'test-device',
                deviceName: 'Test Device',
                fileCount: files.length,
                totalSize: files.reduce((sum, f) => sum + f.content.length, 0),
                encrypted: false,
                checksums: {},
            };

            const manifestKey = `${backupPrefix}/${backupName}/.backup-manifest.json`;
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: manifestKey,
                Body: JSON.stringify(manifest, null, 2),
                ContentType: 'application/json',
            }));

            // Verify
            const response = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: `${backupPrefix}/${backupName}`,
            }));

            expect(response.Contents?.length).toBe(files.length + 1);
        });
    });

    describe('Backup Listing', () => {
        it('should read backup manifest for info display', async () => {
            if (!hasS3Credentials()) return;

            const backupName = generateBackupName() + '-info';
            const manifestKey = `${backupPrefix}/${backupName}/.backup-manifest.json`;

            const manifest: BackupManifest = {
                version: 1,
                timestamp: new Date().toISOString(),
                deviceId: 'device-123',
                deviceName: 'MacBook Pro',
                fileCount: 42,
                totalSize: 1048576,
                encrypted: true,
                checksums: {},
            };

            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: manifestKey,
                Body: JSON.stringify(manifest),
                ContentType: 'application/json',
            }));

            const response = await client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: manifestKey,
            }));

            const content = await response.Body?.transformToString();
            const parsed = JSON.parse(content || '{}') as BackupManifest;

            expect(parsed.deviceName).toBe('MacBook Pro');
            expect(parsed.fileCount).toBe(42);
            expect(parsed.encrypted).toBe(true);
        });
    });

    describe('Backup Cleanup (Retention)', () => {
        it('should delete entire backup folder', async () => {
            if (!hasS3Credentials()) return;

            const backupName = generateBackupName() + '-retention';
            const backupPath = `${backupPrefix}/${backupName}`;

            // Create backup
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: `${backupPath}/file1.md`,
                Body: 'content 1',
            }));
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: `${backupPath}/.backup-manifest.json`,
                Body: '{}',
            }));

            // Verify exists
            const before = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: backupPath,
            }));
            expect(before.Contents?.length).toBe(2);

            // Delete all
            await client.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: {
                    Objects: before.Contents?.map(o => ({ Key: o.Key })) || [],
                    Quiet: true,
                },
            }));

            // Verify deleted
            const after = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: backupPath,
            }));
            expect(after.Contents || []).toHaveLength(0);
        });
    });
});
