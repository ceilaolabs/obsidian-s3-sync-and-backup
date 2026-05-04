/**
 * S3 Configuration Module
 *
 * Provides configuration utilities for different S3-compatible providers.
 * Supports AWS S3, Cloudflare R2, RustFS, and other S3-compatible endpoints.
 *
 * The main export is `buildS3ClientConfig`, which assembles a complete
 * `S3ClientConfig` from plugin settings.  Provider-specific concerns
 * (endpoint URL selection, path-style addressing, region defaults) are
 * encapsulated in the helpers below so that `S3Provider` and tests can
 * inspect or override them independently.
 *
 * **Why a custom HTTP handler** — Obsidian plugins run in a browser-like
 * Electron context where `fetch()` is subject to CORS restrictions.
 * S3-compatible endpoints rarely serve the `Access-Control-Allow-Origin`
 * header for arbitrary origins, so native `fetch` would be blocked.
 * Every `S3Client` built here receives an `ObsidianHttpHandler` instance
 * as its `requestHandler`, routing all HTTP traffic through Obsidian's
 * `requestUrl` API which operates outside the browser sandbox.
 */

import { S3ClientConfig } from '@aws-sdk/client-s3';
import { S3ProviderType, S3SyncBackupSettings, S3_PROVIDER_NAMES } from '../types';
import { ObsidianHttpHandler } from './ObsidianHttpHandler';

// Provider endpoints are determined dynamically based on settings

/**
 * Get the S3 endpoint URL for a given provider.
 *
 * AWS S3 does not require an explicit endpoint — the SDK constructs it from
 * the region.  All other providers require the user to supply one.
 *
 * @param settings - Plugin settings containing provider info and optional
 *   `endpoint` override.
 * @returns Endpoint URL string, or `undefined` for AWS (SDK uses the default).
 * @throws {Error} If a non-AWS provider is selected but no endpoint has been
 *   configured in settings.
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

        case 'rustfs':
            // RustFS is self-hosted and always requires a custom endpoint URL
            // (e.g., http://localhost:9000 for a local deployment).
            if (settings.endpoint) {
                return settings.endpoint;
            }
            throw new Error('RustFS requires an endpoint URL');

        case 'custom':
            if (settings.endpoint) {
                return settings.endpoint;
            }
            throw new Error('Other S3-compatible provider requires an endpoint URL');

        default:
            return settings.endpoint || undefined;
    }
}

/**
 * Determine if path-style addressing should be used for a given provider.
 *
 * Path-style: `https://s3.region.amazonaws.com/bucket/key`
 * Virtual-hosted: `https://bucket.s3.region.amazonaws.com/key`
 *
 * RustFS and some other self-hosted providers require path-style addressing
 * because they do not support virtual-hosted-style (the bucket name is not a
 * valid DNS sub-domain on self-hosted instances).  Cloudflare R2 supports both
 * modes but path-style is more reliable across different R2 account
 * configurations and avoids potential wildcard certificate issues.
 *
 * @param settings - Plugin settings containing the provider type and the
 *   user's `forcePathStyle` preference for AWS/custom providers.
 * @returns `true` if `PutObject` and other requests should use path-style
 *   bucket addressing.
 */
export function shouldForcePathStyle(settings: S3SyncBackupSettings): boolean {
    switch (settings.provider) {
        case 'rustfs':
            // RustFS requires path-style (per RustFS S3 client docs)
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
 * Build a complete `S3ClientConfig` object from plugin settings.
 *
 * This is the single factory that `S3Provider.getClient()` calls to
 * initialise (or re-initialise after a settings change) the underlying
 * `S3Client`.  All provider-specific knobs (endpoint, path-style, region)
 * are resolved here via the helper functions above.
 *
 * @param settings - Full plugin settings object.
 * @returns A ready-to-use `S3ClientConfig` for the `S3Client` constructor.
 * @throws {Error} If the selected provider requires an endpoint but none is
 *   configured (forwarded from `getEndpointForProvider`).
 */
export function buildS3ClientConfig(settings: S3SyncBackupSettings): S3ClientConfig {
    const endpoint = getEndpointForProvider(settings);

    const config: S3ClientConfig = {
        // The AWS SDK requires a region even for non-AWS providers.  `'auto'`
        // is Cloudflare R2's documented value and is a harmless default for
        // RustFS and other S3-compatible endpoints which ignore the region
        // header entirely.
        region: settings.region || 'auto',
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
        },
        forcePathStyle: shouldForcePathStyle(settings),
        // Route all HTTP traffic through Obsidian's requestUrl API.  This is
        // required because the plugin runs in a browser-like Electron context
        // where native fetch() is blocked by CORS for S3-compatible origins.
        // ObsidianHttpHandler uses Electron's main-process IPC channel which
        // is not subject to browser CORS policy.
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
 * Validate that all required connection settings are present and consistent.
 *
 * Performs client-side validation before attempting a network request, so
 * that users receive clear, actionable error messages without incurring an
 * unnecessary round-trip to S3.
 *
 * @param settings - Plugin settings to validate.
 * @returns Array of human-readable validation error messages.  An empty
 *   array means settings are valid and a connection attempt is safe.
 */
export function validateConnectionSettings(settings: S3SyncBackupSettings): string[] {
    const errors: string[] = [];

    // Provider must be one of the supported types. TypeScript's `S3ProviderType`
    // only narrows at compile time — at runtime, persisted `data.json` files
    // from earlier plugin versions can carry stale provider strings (e.g. the
    // removed `'minio'` value) that would silently fall through every switch
    // in this module. Catch those here before any S3 client is constructed.
    if (!Object.prototype.hasOwnProperty.call(S3_PROVIDER_NAMES, settings.provider)) {
        errors.push(
            `Unsupported provider "${settings.provider}". Re-select a provider in Settings.`,
        );
    }

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

    if (settings.provider === 'rustfs' && !settings.endpoint) {
        errors.push('RustFS requires an endpoint URL');
    }

    if (settings.provider === 'custom' && !settings.endpoint) {
        errors.push('Other S3-compatible provider requires an endpoint URL');
    }

    // AWS requires region
    if (settings.provider === 'aws' && !settings.region) {
        errors.push('AWS S3 requires a region');
    }

    return errors;
}

/**
 * Return a human-readable display name for a provider type.
 *
 * Used in settings UI labels, log messages, and error strings where the raw
 * `S3ProviderType` literal (`'r2'`, `'rustfs'`, etc.) would be confusing to
 * non-technical users.
 *
 * @param provider - Provider type identifier.
 * @returns Display-friendly name string (e.g. `"Cloudflare R2"`).
 */
export function getProviderDisplayName(provider: S3ProviderType): string {
    switch (provider) {
        case 'aws':
            return 'AWS S3';
        case 'r2':
            return 'Cloudflare R2';
        case 'rustfs':
            return 'RustFS';
        case 'custom':
            return 'Other S3-compatible';
        default:
            return 'Unknown';
    }
}
