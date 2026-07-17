/**
 * Test utilities for S3 integration & E2E tests — multi-provider aware.
 *
 * Integration/E2E tests exercise REAL S3 operations. To catch provider-specific
 * regressions (e.g. Backblaze B2's rejection of modern checksum headers — issue
 * #78), the suite runs against every provider whose credentials are configured,
 * not just one. Each provider's credentials live under a distinct env-var prefix
 * (`CF_`, `BB_`, …) so several providers can be tested in a single run.
 *
 * Env-var scheme (per provider `<PREFIX>`):
 *   <PREFIX>URL                — S3-compatible endpoint URL
 *   <PREFIX>BUCKET_NAME        — bucket to run tests against
 *   <PREFIX>ACCESS_KEY         — access key id
 *   <PREFIX>SECRET_ACCESS_KEY  — secret access key
 *   <PREFIX>REGION             — region (defaults to "auto")
 *
 * Example: `CF_URL`, `CF_BUCKET_NAME`, … for Cloudflare R2; `BB_URL`, … for B2.
 *
 * Note: environment variables are loaded via Node.js `--env-file=.env` in the
 * `test:integration` / `test:e2e` npm scripts (no dotenv dependency).
 */

import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { S3ProviderType, S3SyncBackupSettings } from '../../src/types';
import { buildS3ClientConfig } from '../../src/storage/S3Config';

/**
 * A provider entry in the test matrix.
 *
 * @property id        Short slug used in `describe` titles and object logs (e.g. `'cf'`).
 * @property name      Human-readable provider name shown in test output (e.g. `'Cloudflare R2'`).
 * @property envPrefix Env-var prefix carrying this provider's credentials (e.g. `'CF_'`).
 * @property provider  Plugin `S3ProviderType` this maps to, so tests build the
 *                     same client config the plugin would in production.
 */
export interface TestProvider {
    id: string;
    name: string;
    envPrefix: string;
    provider: S3ProviderType;
}

/**
 * The provider test matrix. A provider is included in a run only when its
 * credentials are present (see {@link getConfiguredProviders}), so this list can
 * grow ahead of the credentials being available in any given environment.
 *
 * To add a provider: append an entry here and document its env vars in
 * `.env.sample` — no other test code changes are required.
 */
export const TEST_PROVIDERS: TestProvider[] = [
    { id: 'cf', name: 'Cloudflare R2', envPrefix: 'CF_', provider: 'r2' },
    { id: 'bb', name: 'Backblaze B2', envPrefix: 'BB_', provider: 'b2' },
    // Future providers (add credentials + uncomment):
    // { id: 'aws', name: 'AWS S3', envPrefix: 'AWS_', provider: 'aws' },
    // { id: 'rustfs', name: 'RustFS', envPrefix: 'RUSTFS_', provider: 'rustfs' },
];

/**
 * A placeholder provider used only to keep `describe.skip.each` non-empty when no
 * real providers are configured — Jest errors on a test file containing zero tests.
 */
const PLACEHOLDER_PROVIDER: TestProvider = {
    id: 'none',
    name: 'no providers configured',
    envPrefix: '',
    provider: 'custom',
};

/** Read a prefixed env var for a provider, returning `''` when unset. */
function readEnv(provider: TestProvider, key: string): string {
    return process.env[`${provider.envPrefix}${key}`] || '';
}

/**
 * Check whether the given provider has the minimum credentials configured.
 *
 * @param provider - Provider matrix entry.
 * @returns `true` when URL, bucket, access key, and secret are all present.
 */
export function hasS3Credentials(provider: TestProvider): boolean {
    return !!(
        readEnv(provider, 'URL') &&
        readEnv(provider, 'BUCKET_NAME') &&
        readEnv(provider, 'ACCESS_KEY') &&
        readEnv(provider, 'SECRET_ACCESS_KEY')
    );
}

/**
 * Get raw S3 configuration for a provider from its prefixed env vars.
 *
 * @param provider - Provider matrix entry.
 * @returns Connection fields; `region` defaults to `'auto'` when unset.
 */
export function getS3Config(provider: TestProvider): {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
} {
    return {
        endpoint: readEnv(provider, 'URL'),
        bucket: readEnv(provider, 'BUCKET_NAME'),
        accessKeyId: readEnv(provider, 'ACCESS_KEY'),
        secretAccessKey: readEnv(provider, 'SECRET_ACCESS_KEY'),
        region: readEnv(provider, 'REGION') || 'auto',
    };
}

/**
 * Return every provider in {@link TEST_PROVIDERS} that has credentials configured.
 * This is the driver for `describe.each` so only reachable providers are tested.
 *
 * @returns Filtered list of configured providers (possibly empty).
 */
export function getConfiguredProviders(): TestProvider[] {
    return TEST_PROVIDERS.filter(hasS3Credentials);
}

/** Signature of a `describe.each`-style runner bound to the provider matrix. */
type ProviderDescribe = (name: string, fn: (provider: TestProvider) => void) => void;

/**
 * Return a `describe.each` runner over all configured providers.
 *
 * Usage:
 * ```ts
 * describeEachProvider()('S3 ops [$name]', (provider) => { ... });
 * ```
 * The `$name` token interpolates the provider's display name into the suite title.
 * When no providers are configured, returns a **skipped** runner over a single
 * placeholder so the file still registers (skipped) tests instead of erroring.
 *
 * @returns A function accepting a title template and a per-provider suite body.
 */
export function describeEachProvider(): ProviderDescribe {
    const providers = getConfiguredProviders();
    if (providers.length === 0) {
        console.warn(
            '⚠️ No S3 providers configured (set CF_*/BB_* env vars in .env); skipping provider tests.',
        );
        return describe.skip.each([PLACEHOLDER_PROVIDER]);
    }
    return describe.each(providers);
}

/**
 * Create a test S3 client for a provider that works in the Node.js test runtime.
 *
 * Crucially, this routes through the plugin's production {@link buildS3ClientConfig}
 * so tests exercise the *exact* client configuration the plugin uses — including
 * the checksum settings that fix issue #78 — and only swaps the Obsidian
 * `requestHandler` for a Node-compatible `NodeHttpHandler` (Obsidian's
 * `requestUrl` is unavailable outside the app).
 *
 * @param provider - Provider matrix entry.
 * @returns A configured `S3Client` talking to the provider's real endpoint.
 */
export function createTestS3Client(provider: TestProvider): S3Client {
    const config: S3ClientConfig = buildS3ClientConfig(createTestSettings(provider));
    config.requestHandler = new NodeHttpHandler({
        connectionTimeout: 5000,
        socketTimeout: 30000,
    });
    return new S3Client(config);
}

/**
 * Build a full plugin settings object for a provider from its env vars.
 *
 * The plugin `provider` type comes straight from the matrix entry (no hostname
 * inference), so it always matches the credentials being used.
 *
 * @param provider  - Provider matrix entry.
 * @param overrides - Partial settings to merge over the env-derived defaults.
 * @returns A complete {@link S3SyncBackupSettings} for use with `S3Provider`.
 */
export function createTestSettings(
    provider: TestProvider,
    overrides: Partial<S3SyncBackupSettings> = {},
): S3SyncBackupSettings {
    const config = getS3Config(provider);

    return {
        provider: provider.provider,
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        forcePathStyle: provider.provider !== 'aws',
        encryptionEnabled: false,
        rememberPassphrase: false,
        savedPassphrase: '',
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
 * Generate a unique S3 prefix to isolate a test run from concurrent/previous runs.
 *
 * @param testName - Short label included in the prefix for debuggability.
 * @returns A prefix of the form `__test__/{name}-{timestamp}-{random}`.
 */
export function getTestPrefix(testName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `__test__/${testName}-${timestamp}-${random}`;
}
