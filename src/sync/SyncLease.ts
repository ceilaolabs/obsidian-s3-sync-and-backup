/**
 * Remote lease lock for coordinating exclusive operations across devices.
 *
 * Stored at `{syncPrefix}/.obsidian-s3-sync/.sync.lock.json` in S3. Used by
 * the EncryptionCoordinator to prevent concurrent migrations from multiple
 * devices, and can be extended for any operation that requires cluster-wide
 * mutual exclusion (e.g. schema migrations).
 *
 * The lock is advisory — it relies on all participating clients checking
 * before proceeding. It includes a TTL (`expiresAt`) so that a crashed
 * device's lock is automatically considered stale after expiry.
 */

import { S3Provider } from '../storage/S3Provider';

/** Default lease duration for migrations: 10 minutes. */
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;

/** Path to the lock file relative to the sync prefix. */
const LOCK_PATH = '.obsidian-s3-sync/.sync.lock.json';

/**
 * Lease kinds — determines TTL behavior and who can break the lock.
 *
 * - `sync`      — short-lived lock for normal sync operations (future use).
 * - `migration` — long-lived lock for encryption enable/disable migrations.
 */
export type LeaseKind = 'sync' | 'migration';

/**
 * JSON structure persisted in S3 as the lock file.
 */
export interface LeaseLockData {
	/** Device ID that holds the lock. */
	ownerDeviceId: string;
	/** What operation is holding the lock. */
	kind: LeaseKind;
	/** Unique ID for this lease (UUID v4). Used for compare-and-swap on release. */
	leaseId: string;
	/** Epoch ms when the lease expires and can be considered stale by other devices. */
	expiresAt: number;
	/** Epoch ms when the lease was first acquired. */
	acquiredAt: number;
}

/**
 * Manages a remote advisory lock in S3 for exclusive operations.
 *
 * Usage pattern:
 * 1. `acquire(deviceId, kind)` — attempts to take the lock.
 * 2. Periodically call `renew()` to extend the TTL during long operations.
 * 3. `release()` — removes the lock when done.
 *
 * If another device holds an unexpired lock, `acquire` throws. If the existing
 * lock is expired, `acquire` overwrites it (stale lock recovery).
 */
export class SyncLease {
	private s3Provider: S3Provider;
	private syncPrefix: string;
	private currentLease: LeaseLockData | null = null;

	constructor(s3Provider: S3Provider, syncPrefix: string) {
		this.s3Provider = s3Provider;
		this.syncPrefix = syncPrefix;
	}

	private getLockKey(): string {
		return `${this.syncPrefix}/${LOCK_PATH}`;
	}

	/**
	 * Attempt to acquire the remote lock.
	 *
	 * @throws {Error} If another device holds a non-expired lock.
	 */
	async acquire(deviceId: string, kind: LeaseKind, ttlMs = DEFAULT_LEASE_TTL_MS): Promise<LeaseLockData> {
		const existing = await this.read();

		if (existing && existing.expiresAt > Date.now() && existing.ownerDeviceId !== deviceId) {
			throw new Error(
				`Lock held by device ${existing.ownerDeviceId} for ${existing.kind} ` +
				`(expires ${new Date(existing.expiresAt).toISOString()}). Cannot acquire.`,
			);
		}

		const lease: LeaseLockData = {
			ownerDeviceId: deviceId,
			kind,
			leaseId: crypto.randomUUID(),
			expiresAt: Date.now() + ttlMs,
			acquiredAt: Date.now(),
		};

		await this.write(lease);
		this.currentLease = lease;
		return lease;
	}

	/**
	 * Extend the TTL of the currently held lock.
	 *
	 * @throws {Error} If no lock is currently held by this instance, or if
	 *   the remote lock was stolen by another device.
	 */
	async renew(ttlMs = DEFAULT_LEASE_TTL_MS): Promise<void> {
		if (!this.currentLease) {
			throw new Error('No active lease to renew');
		}

		const remote = await this.read();
		if (!remote || remote.leaseId !== this.currentLease.leaseId) {
			this.currentLease = null;
			throw new Error('Lease was overwritten by another device');
		}

		this.currentLease.expiresAt = Date.now() + ttlMs;
		await this.write(this.currentLease);
	}

	/**
	 * Release the currently held lock by deleting the lock file from S3.
	 *
	 * Safe to call even if no lock is held (no-op). Verifies the remote
	 * lock's `leaseId` matches before deleting to avoid releasing someone
	 * else's lock.
	 */
	async release(): Promise<void> {
		if (!this.currentLease) return;

		try {
			const remote = await this.read();
			if (remote && remote.leaseId === this.currentLease.leaseId) {
				await this.s3Provider.deleteFile(this.getLockKey());
			}
		} finally {
			this.currentLease = null;
		}
	}

	/**
	 * Check if another device holds an active (non-expired) lock.
	 */
	async isHeldByOther(deviceId: string): Promise<boolean> {
		const existing = await this.read();
		if (!existing) return false;
		if (existing.expiresAt <= Date.now()) return false;
		return existing.ownerDeviceId !== deviceId;
	}

	/** Returns the current in-memory lease, or null if not held. */
	getCurrentLease(): LeaseLockData | null {
		return this.currentLease;
	}

	private async read(): Promise<LeaseLockData | null> {
		try {
			const result = await this.s3Provider.downloadFileAsTextWithEtag(this.getLockKey());
			if (!result) return null;
			return JSON.parse(result.text) as LeaseLockData;
		} catch {
			return null;
		}
	}

	private async write(lease: LeaseLockData): Promise<void> {
		const json = JSON.stringify(lease, null, 2);
		await this.s3Provider.uploadFile(this.getLockKey(), json, 'application/json');
	}
}
