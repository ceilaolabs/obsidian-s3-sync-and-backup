/**
 * S3 Configuration Module
 *
 * Provides configuration utilities for different S3-compatible providers.
 * Supports AWS S3, MinIO, Cloudflare R2, and custom endpoints.
 */

import { S3ClientConfig } from '@aws-sdk/client-s3';
import { S3ProviderType, S3SyncBackupSettings } from '../types';
import { ObsidianHttpHandler } from './ObsidianHttpHandler';

/**
 * Default endpoints for known providers
 * Custom providers require user-provided endpoint
 */
const PROVIDER_ENDPOINTS: Partial<Record<S3ProviderType, string>> = {
    // AWS S3 uses region-based endpoints (handled dynamically)
    // MinIO requires custom endpoint from user
    // r2 uses accountId-based endpoint
};

/**
 * Get the S3 endpoint URL for a given provider
 *
 * @param settings - Plugin settings containing provider info
 * @returns Endpoint URL or undefined for AWS default
 */
export function getEndpointForProvider(settings: S3SyncBackupSettings): string | undefined {
    switch (settings.provider) {
        case 'aws':
            // AWS S3 doesn't need explicit endpoint - SDK handles it
            return undefined;

        case 'r2':
            // Cloudflare R2 endpoint format
            // User provides the account ID in the endpoint field
            // Format: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
            if (settings.endpoint) {
                return settings.endpoint;
            }
            throw new Error('Cloudflare R2 requires an endpoint URL (https://<ACCOUNT_ID>.r2.cloudflarestorage.com)');

        case 'minio':
            // MinIO requires custom endpoint
            if (settings.endpoint) {
                return settings.endpoint;
            }
            throw new Error('MinIO requires an endpoint URL');

        case 'custom':
            if (settings.endpoint) {
                return settings.endpoint;
            }
            throw new Error('Custom provider requires an endpoint URL');

        default:
            return settings.endpoint || undefined;
    }
}

/**
 * Determine if path-style addressing should be used
 *
 * Path-style: https://s3.region.amazonaws.com/bucket/key
 * Virtual-hosted: https://bucket.s3.region.amazonaws.com/key
 *
 * MinIO and some other providers require path-style
 *
 * @param settings - Plugin settings
 * @returns Whether to force path style
 */
export function shouldForcePathStyle(settings: S3SyncBackupSettings): boolean {
    switch (settings.provider) {
        case 'minio':
            // MinIO typically requires path-style
            return true;

        case 'r2':
            // R2 works with both, but path-style is more reliable
            return true;

        case 'aws':
            // AWS prefers virtual-hosted, but respect user setting
            return settings.forcePathStyle;

        case 'custom':
            // Respect user setting for custom providers
            return settings.forcePathStyle;

        default:
            return settings.forcePathStyle;
    }
}

/**
 * Build complete S3ClientConfig from plugin settings
 *
 * @param settings - Plugin settings
 * @returns S3ClientConfig ready for S3Client constructor
 */
export function buildS3ClientConfig(settings: S3SyncBackupSettings): S3ClientConfig {
    const endpoint = getEndpointForProvider(settings);

    const config: S3ClientConfig = {
        region: settings.region || 'auto',
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
        },
        forcePathStyle: shouldForcePathStyle(settings),
        // Use Obsidian's requestUrl to bypass CORS restrictions
        requestHandler: new ObsidianHttpHandler({
            requestTimeout: 30000,
        }),
    };

    // Add endpoint if specified
    if (endpoint) {
        config.endpoint = endpoint;
    }

    return config;
}

/**
 * Validate that all required connection settings are present
 *
 * @param settings - Plugin settings
 * @returns Array of validation error messages (empty if valid)
 */
export function validateConnectionSettings(settings: S3SyncBackupSettings): string[] {
    const errors: string[] = [];

    if (!settings.bucket) {
        errors.push('Bucket name is required');
    }

    if (!settings.accessKeyId) {
        errors.push('Access Key ID is required');
    }

    if (!settings.secretAccessKey) {
        errors.push('Secret Access Key is required');
    }

    // Provider-specific validation
    if (settings.provider === 'r2' && !settings.endpoint) {
        errors.push('Cloudflare R2 requires an endpoint URL');
    }

    if (settings.provider === 'minio' && !settings.endpoint) {
        errors.push('MinIO requires an endpoint URL');
    }

    if (settings.provider === 'custom' && !settings.endpoint) {
        errors.push('Custom provider requires an endpoint URL');
    }

    // AWS requires region
    if (settings.provider === 'aws' && !settings.region) {
        errors.push('AWS S3 requires a region');
    }

    return errors;
}

/**
 * Get user-friendly provider name for display
 *
 * @param provider - Provider type
 * @returns Display name
 */
export function getProviderDisplayName(provider: S3ProviderType): string {
    switch (provider) {
        case 'aws':
            return 'AWS S3';
        case 'minio':
            return 'MinIO';
        case 'r2':
            return 'Cloudflare R2';
        case 'custom':
            return 'Custom S3-compatible';
        default:
            return 'Unknown';
    }
}
