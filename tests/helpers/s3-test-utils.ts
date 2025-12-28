/**
 * Test utilities for S3 integration tests
 *
 * Provides S3 client configuration that works in Node.js test environment
 * (bypassing Obsidian-specific HTTP handler)
 */

import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { S3SyncBackupSettings } from '../../src/types';

require('dotenv').config();

/**
 * Check if S3 credentials are configured
 */
export function hasS3Credentials(): boolean {
    return !!(
        process.env.S3_URL &&
        process.env.S3_BUCKET_NAME &&
        process.env.S3_ACCESS_KEY &&
        process.env.S3_SECRET_ACCESS_KEY
    );
}

/**
 * Get S3 configuration from environment variables
 */
export function getS3Config(): {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
} {
    return {
        endpoint: process.env.S3_URL || '',
        bucket: process.env.S3_BUCKET_NAME || '',
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        region: process.env.S3_REGION || 'auto',
    };
}

/**
 * Creates a test S3 client that works in Node.js environment
 * (Uses NodeHttpHandler instead of Obsidian's requestUrl)
 */
export function createTestS3Client(): S3Client {
    const config = getS3Config();

    return new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: true,
        // Use Node.js-compatible HTTP handler for tests
        requestHandler: new NodeHttpHandler({
            connectionTimeout: 5000,
            socketTimeout: 30000,
        }),
    });
}

/**
 * Creates test settings from environment variables
 */
export function createTestSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
    const config = getS3Config();

    // Determine provider from endpoint
    let provider: 'aws' | 'r2' | 'minio' | 'custom';
    if (config.endpoint.includes('r2.cloudflarestorage.com')) {
        provider = 'r2';
    } else if (config.endpoint.includes('amazonaws.com') || !config.endpoint) {
        provider = 'aws';
    } else if (config.endpoint.includes('minio') || config.endpoint.includes('localhost')) {
        provider = 'minio';
    } else {
        provider = 'custom';
    }

    return {
        provider,
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        forcePathStyle: provider !== 'aws',
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

/**
 * Generate unique test prefix to avoid conflicts
 */
export function getTestPrefix(testName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `__test__/${testName}-${timestamp}-${random}`;
}
