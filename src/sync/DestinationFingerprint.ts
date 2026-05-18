/**
 * Deterministic fingerprint of the S3 destination a sync journal was built against.
 *
 * The journal (IndexedDB at `obsidian-s3-sync-journal-{vaultName}`) is keyed by
 * vault name only, so the same vault pointed at different remotes shares the same
 * journal. Without a way to detect that the remote has changed, baselines from a
 * previous destination would drive a destructive sync plan against a new
 * (effectively empty) one — see the regression that motivated this module.
 *
 * The fingerprint covers every settings field that affects *where the data lives*:
 * provider, region, endpoint, bucket, and the normalised sync prefix. Credential
 * fields (access keys, passphrase storage) are intentionally excluded — rotating
 * keys does not move the data, so the journal remains valid.
 */

import { S3SyncBackupSettings } from '../types';
import { normalizePrefix } from '../utils/paths';

/**
 * Compute a stable, comparable string representation of the destination a sync
 * journal was built against.
 *
 * Two settings objects produce the same fingerprint exactly when they describe
 * the same physical S3 location. The fingerprint is meant for equality
 * comparison only; it is not cryptographically secure and should not be parsed.
 *
 * @param settings - Plugin settings whose destination fields will be hashed.
 * @returns A deterministic string suitable for storage in the journal metadata.
 */
export function computeDestinationFingerprint(settings: S3SyncBackupSettings): string {
	const parts = [
		`provider=${settings.provider}`,
		`region=${settings.region}`,
		`endpoint=${settings.endpoint}`,
		`bucket=${settings.bucket}`,
		`prefix=${normalizePrefix(settings.syncPrefix)}`,
	];
	return parts.join('|');
}
