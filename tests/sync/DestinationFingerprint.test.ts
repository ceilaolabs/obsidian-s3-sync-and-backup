/**
 * Unit tests for the destination fingerprint utility.
 *
 * The fingerprint is a deterministic identifier for the S3 destination a journal
 * was built against. SyncEngine uses it to detect when the configured destination
 * has changed (bucket / endpoint / region / sync prefix / provider) and to
 * invalidate stale baselines that would otherwise drive a destructive sync plan.
 */

import { computeDestinationFingerprint } from '../../src/sync/DestinationFingerprint';
import { S3SyncBackupSettings } from '../../src/types';

function createSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		provider: 'aws',
		endpoint: '',
		region: 'us-east-1',
		bucket: 'my-bucket',
		accessKeyId: 'ignored-key',
		secretAccessKey: 'ignored-secret',
		forcePathStyle: false,
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
 * Covers the pure-function destination fingerprint used by SyncEngine's Phase 0
 * reconciliation: stability for identical settings, sensitivity to each
 * destination-affecting field, prefix normalisation, delimiter-collision
 * resistance, and credential-field exclusion.
 */
describe('computeDestinationFingerprint', () => {
	it('returns the same string for two identical destinations', () => {
		const a = computeDestinationFingerprint(createSettings());
		const b = computeDestinationFingerprint(createSettings());

		expect(a).toBe(b);
	});

	it('changes when the bucket changes', () => {
		const a = computeDestinationFingerprint(createSettings({ bucket: 'bucket-a' }));
		const b = computeDestinationFingerprint(createSettings({ bucket: 'bucket-b' }));

		expect(a).not.toBe(b);
	});

	it('changes when the sync prefix changes', () => {
		const a = computeDestinationFingerprint(createSettings({ syncPrefix: 'vault' }));
		const b = computeDestinationFingerprint(createSettings({ syncPrefix: 'archive' }));

		expect(a).not.toBe(b);
	});

	it('treats equivalent prefix spellings as the same destination', () => {
		// `normalizePrefix` strips surrounding slashes and collapses doubled slashes,
		// so `"/vault/"` and `"vault"` point at the same S3 location.
		const a = computeDestinationFingerprint(createSettings({ syncPrefix: 'vault' }));
		const b = computeDestinationFingerprint(createSettings({ syncPrefix: '/vault/' }));

		expect(a).toBe(b);
	});

	it('changes when the endpoint changes', () => {
		const a = computeDestinationFingerprint(createSettings({ endpoint: 'https://s3.example.com' }));
		const b = computeDestinationFingerprint(createSettings({ endpoint: 'https://s3.other.com' }));

		expect(a).not.toBe(b);
	});

	it('changes when the region changes', () => {
		const a = computeDestinationFingerprint(createSettings({ region: 'us-east-1' }));
		const b = computeDestinationFingerprint(createSettings({ region: 'eu-west-1' }));

		expect(a).not.toBe(b);
	});

	it('changes when the provider changes', () => {
		const a = computeDestinationFingerprint(createSettings({ provider: 'aws' }));
		const b = computeDestinationFingerprint(createSettings({ provider: 'r2' }));

		expect(a).not.toBe(b);
	});

	it('does not collide when a field value contains the delimiter or key characters', () => {
		// Naive `key=value|key=value` concatenation collides when a user-supplied
		// field (e.g. syncPrefix) embeds `|` or `=`.  Two distinct destinations
		// constructed below would otherwise produce identical fingerprints.
		const a = computeDestinationFingerprint(createSettings({
			endpoint: 'https://e|bucket=my-bucket|prefix=one',
			bucket: 'my-bucket',
			syncPrefix: 'two',
		}));
		const b = computeDestinationFingerprint(createSettings({
			endpoint: 'https://e',
			bucket: 'my-bucket',
			syncPrefix: 'one|bucket=my-bucket|prefix=two',
		}));

		expect(a).not.toBe(b);
	});

	it('ignores credential fields that do not affect data location', () => {
		// Swapping IAM keys / passphrase settings does not move the data; the
		// journal baselines remain valid and must not be invalidated.
		const a = computeDestinationFingerprint(createSettings({
			accessKeyId: 'key-a',
			secretAccessKey: 'secret-a',
			rememberPassphrase: false,
			savedPassphrase: '',
		}));
		const b = computeDestinationFingerprint(createSettings({
			accessKeyId: 'key-b',
			secretAccessKey: 'secret-b',
			rememberPassphrase: true,
			savedPassphrase: 'changed',
		}));

		expect(a).toBe(b);
	});
});
