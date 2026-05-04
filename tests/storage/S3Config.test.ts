/**
 * Unit tests for S3Config module
 *
 * Tests S3 client configuration utilities including endpoint resolution,
 * path-style settings, and connection validation. These are pure function
 * tests that do not make actual S3 calls.
 */

import {
    getEndpointForProvider,
    shouldForcePathStyle,
    buildS3ClientConfig,
    validateConnectionSettings,
    getProviderDisplayName,
} from '../../src/storage/S3Config';
import { S3SyncBackupSettings, S3_PROVIDER_NAMES } from '../../src/types';

/**
 * Creates a minimal settings object for testing
 * Only required fields are set; optional fields can be overridden
 */
function createTestSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
    return {
        provider: 'aws',
        endpoint: '',
        region: 'us-east-1',
        bucket: 'test-bucket',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
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

describe('S3Config', () => {
    describe('getEndpointForProvider', () => {
        /**
         * AWS S3 uses SDK's built-in endpoint resolution
         * No custom endpoint should be returned
         */
        it('should return undefined for AWS provider', () => {
            const settings = createTestSettings({ provider: 'aws' });
            expect(getEndpointForProvider(settings)).toBeUndefined();
        });

        /**
         * Cloudflare R2 requires explicit endpoint URL
         */
        it('should return endpoint for R2 provider', () => {
            const settings = createTestSettings({
                provider: 'r2',
                endpoint: 'https://account.r2.cloudflarestorage.com',
            });
            expect(getEndpointForProvider(settings)).toBe('https://account.r2.cloudflarestorage.com');
        });

        /**
         * R2 without endpoint should throw error
         */
        it('should throw error for R2 without endpoint', () => {
            const settings = createTestSettings({
                provider: 'r2',
                endpoint: '',
            });
            expect(() => getEndpointForProvider(settings)).toThrow('Cloudflare R2 requires an endpoint URL');
        });

        /**
         * RustFS requires a custom endpoint URL (typically localhost:9000)
         */
        it('should return endpoint for RustFS provider', () => {
            const settings = createTestSettings({
                provider: 'rustfs',
                endpoint: 'http://localhost:9000',
            });
            expect(getEndpointForProvider(settings)).toBe('http://localhost:9000');
        });

        /**
         * RustFS without endpoint should throw error
         */
        it('should throw error for RustFS without endpoint', () => {
            const settings = createTestSettings({
                provider: 'rustfs',
                endpoint: '',
            });
            expect(() => getEndpointForProvider(settings)).toThrow('RustFS requires an endpoint URL');
        });

        /**
         * Other S3-compatible provider requires explicit endpoint
         */
        it('should return endpoint for other S3-compatible provider', () => {
            const settings = createTestSettings({
                provider: 'custom',
                endpoint: 'https://custom-s3.example.com',
            });
            expect(getEndpointForProvider(settings)).toBe('https://custom-s3.example.com');
        });

        /**
         * Other S3-compatible provider without endpoint should throw error
         */
        it('should throw error for other S3-compatible provider without endpoint', () => {
            const settings = createTestSettings({
                provider: 'custom',
                endpoint: '',
            });
            expect(() => getEndpointForProvider(settings)).toThrow('Other S3-compatible provider requires an endpoint URL');
        });
    });

    describe('shouldForcePathStyle', () => {
        /**
         * RustFS requires path-style addressing per RustFS S3 client docs
         */
        it('should return true for RustFS', () => {
            const settings = createTestSettings({ provider: 'rustfs' });
            expect(shouldForcePathStyle(settings)).toBe(true);
        });

        /**
         * R2 works better with path-style
         */
        it('should return true for R2', () => {
            const settings = createTestSettings({ provider: 'r2' });
            expect(shouldForcePathStyle(settings)).toBe(true);
        });

        /**
         * AWS prefers virtual-hosted style by default
         */
        it('should return false for AWS by default', () => {
            const settings = createTestSettings({
                provider: 'aws',
                forcePathStyle: false,
            });
            expect(shouldForcePathStyle(settings)).toBe(false);
        });

        /**
         * AWS should respect user's forcePathStyle setting
         */
        it('should respect forcePathStyle for AWS', () => {
            const settings = createTestSettings({
                provider: 'aws',
                forcePathStyle: true,
            });
            expect(shouldForcePathStyle(settings)).toBe(true);
        });

        /**
         * Custom providers should respect user setting
         */
        it('should respect forcePathStyle for custom provider', () => {
            const settings = createTestSettings({
                provider: 'custom',
                forcePathStyle: true,
            });
            expect(shouldForcePathStyle(settings)).toBe(true);
        });
    });

    describe('buildS3ClientConfig', () => {
        /**
         * Verifies complete config structure for AWS
         */
        it('should build config for AWS', () => {
            const settings = createTestSettings({
                provider: 'aws',
                region: 'us-west-2',
            });
            const config = buildS3ClientConfig(settings);

            expect(config.region).toBe('us-west-2');
            expect(config.credentials).toEqual({
                accessKeyId: settings.accessKeyId,
                secretAccessKey: settings.secretAccessKey,
            });
            expect(config.forcePathStyle).toBe(false);
            expect(config.endpoint).toBeUndefined();
        });

        /**
         * Verifies R2-specific config
         */
        it('should build config for R2 with endpoint', () => {
            const settings = createTestSettings({
                provider: 'r2',
                endpoint: 'https://account.r2.cloudflarestorage.com',
                region: 'auto',
            });
            const config = buildS3ClientConfig(settings);

            expect(config.region).toBe('auto');
            expect(config.endpoint).toBe('https://account.r2.cloudflarestorage.com');
            expect(config.forcePathStyle).toBe(true);
        });

        /**
         * Config should include custom request handler for Obsidian
         */
        it('should include requestHandler', () => {
            const settings = createTestSettings({ provider: 'aws' });
            const config = buildS3ClientConfig(settings);

            expect(config.requestHandler).toBeDefined();
        });

        /**
         * Default region should be 'auto' when empty
         */
        it('should default region to auto when empty', () => {
            const settings = createTestSettings({
                provider: 'aws',
                region: '',
            });
            const config = buildS3ClientConfig(settings);

            expect(config.region).toBe('auto');
        });
    });

    describe('validateConnectionSettings', () => {
        /**
         * Valid settings should return no errors
         */
        it('should return empty array for valid AWS settings', () => {
            const settings = createTestSettings({ provider: 'aws' });
            const errors = validateConnectionSettings(settings);
            expect(errors).toEqual([]);
        });

        /**
         * Missing bucket should be caught
         */
        it('should return error for missing bucket', () => {
            const settings = createTestSettings({ bucket: '' });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain('Bucket name is required');
        });

        /**
         * Missing accessKeyId should be caught
         */
        it('should return error for missing accessKeyId', () => {
            const settings = createTestSettings({ accessKeyId: '' });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain('Access Key ID is required');
        });

        /**
         * Missing secretAccessKey should be caught
         */
        it('should return error for missing secretAccessKey', () => {
            const settings = createTestSettings({ secretAccessKey: '' });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain('Secret Access Key is required');
        });

        /**
         * R2 without endpoint should be caught
         */
        it('should return error for R2 without endpoint', () => {
            const settings = createTestSettings({
                provider: 'r2',
                endpoint: '',
            });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain('Cloudflare R2 requires an endpoint URL');
        });

        /**
         * RustFS without endpoint should be caught
         */
        it('should return error for RustFS without endpoint', () => {
            const settings = createTestSettings({
                provider: 'rustfs',
                endpoint: '',
            });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain('RustFS requires an endpoint URL');
        });

        /**
         * Other S3-compatible provider without endpoint should be caught
         */
        it('should return error for other S3-compatible provider without endpoint', () => {
            const settings = createTestSettings({
                provider: 'custom',
                endpoint: '',
            });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain('Other S3-compatible provider requires an endpoint URL');
        });

        /**
         * AWS without region should be caught
         */
        it('should return error for AWS without region', () => {
            const settings = createTestSettings({
                provider: 'aws',
                region: '',
            });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain('AWS S3 requires a region');
        });

        /**
         * Multiple errors should all be reported
         */
        it('should return multiple errors when multiple fields are invalid', () => {
            const settings = createTestSettings({
                bucket: '',
                accessKeyId: '',
                secretAccessKey: '',
            });
            const errors = validateConnectionSettings(settings);

            expect(errors).toContain('Bucket name is required');
            expect(errors).toContain('Access Key ID is required');
            expect(errors).toContain('Secret Access Key is required');
            expect(errors.length).toBe(3);
        });

        /**
         * Legacy `'minio'` provider strings persisted in older `data.json`
         * files (the dropdown option was removed in favour of RustFS) must be
         * rejected at runtime rather than silently falling through every
         * provider switch in the module.
         */
        it('should reject legacy minio provider value', () => {
            const settings = createTestSettings({
                provider: 'minio' as unknown as S3SyncBackupSettings['provider'],
            });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain(
                'Unsupported provider "minio". Re-select a provider in Settings.',
            );
        });

        /**
         * Any unknown provider string (e.g. typo, future-removed value) must
         * also be rejected. Documents the validator's contract for callers.
         */
        it('should reject arbitrary unknown provider value', () => {
            const settings = createTestSettings({
                provider: 'unknown-vendor' as unknown as S3SyncBackupSettings['provider'],
            });
            const errors = validateConnectionSettings(settings);
            expect(errors).toContain(
                'Unsupported provider "unknown-vendor". Re-select a provider in Settings.',
            );
        });
    });

    describe('getProviderDisplayName', () => {
        /**
         * Verifies display names for all providers
         */
        it('should return correct display name for AWS', () => {
            expect(getProviderDisplayName('aws')).toBe('AWS S3');
        });

        it('should return correct display name for RustFS', () => {
            expect(getProviderDisplayName('rustfs')).toBe('RustFS');
        });

        it('should return correct display name for R2', () => {
            expect(getProviderDisplayName('r2')).toBe('Cloudflare R2');
        });

        it('should return correct display name for other S3-compatible', () => {
            expect(getProviderDisplayName('custom')).toBe('Other S3-compatible');
        });

        /**
         * Unknown providers should return 'Unknown'
         */
        it('should return Unknown for invalid provider', () => {
            // @ts-expect-error - testing invalid input
            expect(getProviderDisplayName('invalid')).toBe('Unknown');
        });
    });

    /**
     * The settings dropdown is rendered by iterating `Object.entries(S3_PROVIDER_NAMES)`
     * (see `src/settings.ts`). For non-integer string keys, JavaScript guarantees
     * iteration in insertion order, so the order in which entries are declared
     * in `types.ts` is the order users see in the UI. This test pins down the
     * intended order so accidental reordering surfaces as a test failure.
     */
    describe('S3_PROVIDER_NAMES dropdown order', () => {
        it('exposes providers in the documented dropdown order', () => {
            expect(Object.keys(S3_PROVIDER_NAMES)).toEqual(['aws', 'r2', 'rustfs', 'custom']);
        });
    });
});
