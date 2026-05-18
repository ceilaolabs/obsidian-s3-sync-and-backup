/**
 * Sync Engine Module (v2)
 *
 * Thin orchestrator that coordinates the three-way reconciliation sync:
 *   1. Acquire mutex (prevent concurrent syncs)
 *   2. Signal ChangeTracker that sync is active
 *   3. Phase 0 — Reconcile destination fingerprint: detect when the configured
 *      S3 destination differs from the journal's last-known destination and
 *      clear stale baselines so they cannot drive a destructive plan
 *   4. Phase 1 — Build a plan via {@link SyncPlanner}
 *   5. Phase 1.4 — Re-check that the destination has not changed during planning;
 *      refuse the plan if the user mutated settings while the planner was
 *      awaiting S3
 *   6. Phase 1.5 — Refuse plans that would `delete-local` files against a
 *      destination with no prior successful sync (belt-and-braces safety net)
 *   7. Phase 2 — Execute the plan via {@link SyncExecutor}
 *   8. Phase 3 — Record `lastSuccessfulSyncAt` in journal metadata on success
 *   9. Release mutex and signal ChangeTracker
 *
 * All heavy lifting (state discovery, classification, decision-making,
 * file I/O, S3 operations) lives in the planner and executor modules.
 */

import { App } from 'obsidian';
import { S3SyncBackupSettings, SyncPlanItem, SyncResult } from '../types';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';
import { SyncPayloadCodec } from './SyncPayloadCodec';
import { SyncPlanner } from './SyncPlanner';
import { SyncExecutor } from './SyncExecutor';
import { ChangeTracker } from './ChangeTracker';
import { computeDestinationFingerprint } from './DestinationFingerprint';

/**
 * Journal metadata key under which the destination fingerprint is persisted.
 *
 * The fingerprint identifies the S3 destination (bucket / endpoint / region /
 * prefix / provider) the journal's baselines were built against. A mismatch
 * between the stored value and the current settings means the baselines refer
 * to a different remote and must be discarded before they can drive a
 * destructive plan.
 */
const DESTINATION_FINGERPRINT_KEY = 'destinationFingerprint';

/** Journal metadata key holding the epoch-ms time of the last successful sync. */
const LAST_SUCCESSFUL_SYNC_KEY = 'lastSuccessfulSyncAt';

/**
 * Run a journal operation and rewrap any thrown error with a phase description.
 *
 * The outer `sync()` catch logs only the final message, so without a phase
 * description an IndexedDB failure surfaces as a bare "Sync failed: <message>"
 * with no indication of which journal touchpoint failed.  Wrapping each step
 * preserves the underlying error message while making the operation visible.
 *
 * @param phase     - Short human description of what was being attempted.
 * @param operation - Thunk producing the journal call to await.
 * @returns The operation's resolved value.
 * @throws An `Error` whose message includes the phase and the underlying message.
 */
async function withJournalContext<T>(phase: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed ${phase}: ${cause}`);
	}
}

/**
 * SyncEngine — orchestrates a complete sync cycle.
 *
 * Constructed once in `main.ts` and reused for every sync trigger
 * (scheduled, manual, or on-startup).
 */
export class SyncEngine {
	private isSyncing = false;
	private debugLogging: boolean;

	/**
	 * @param app           - The Obsidian App instance (vault, fileManager, etc.).
	 * @param s3Provider    - S3 abstraction layer; constructed from current settings.
	 * @param journal       - IndexedDB journal for per-file baseline persistence.
	 * @param pathCodec     - Converts vault-relative paths ↔ S3 object keys.
	 * @param payloadCodec  - Handles optional encryption of file content.
	 * @param changeTracker - Dirty-path tracker; suppressed during active syncs.
	 * @param settings      - Full plugin settings snapshot used to configure
	 *   the planner (e.g. exclude patterns, sync prefix) and executor (debug logging).
	 * @param deviceId      - Stable per-device identifier embedded in S3 metadata
	 *   so other devices can attribute the last write.
	 */
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		private payloadCodec: SyncPayloadCodec,
		private changeTracker: ChangeTracker,
		private settings: S3SyncBackupSettings,
		private deviceId: string,
	) {
		this.debugLogging = settings.debugLogging;
	}

	/**
	 * Update runtime settings (e.g. after the user changes them in the settings tab).
	 *
	 * @param settings - The new settings snapshot.
	 */
	updateSettings(settings: S3SyncBackupSettings): void {
		this.settings = settings;
		this.debugLogging = settings.debugLogging;
		this.pathCodec.updatePrefix(settings.syncPrefix);
	}

	/**
	 * Check whether a sync cycle is currently in progress.
	 *
	 * @returns `true` while {@link sync} is executing.
	 */
	isInProgress(): boolean {
		return this.isSyncing;
	}

	/**
	 * Run a full sync cycle: plan → execute → persist metadata.
	 *
	 * @returns A {@link SyncResult} summarising what happened.
	 * @throws If called while another sync is already running.
	 */
	async sync(): Promise<SyncResult> {
		if (this.isSyncing) {
			throw new Error('Sync already in progress');
		}

		this.isSyncing = true;
		this.changeTracker.setSyncInProgress(true);

		try {
			this.log('Starting sync');

			// Phase 0 — Destination guard.  The journal is keyed by vault name only, so a
			// vault pointed at a new bucket/prefix would otherwise reuse baselines from the
			// previous destination and trigger a destructive plan (untouched local files
			// classified as "remotely deleted").  Detect the mismatch and clear stale
			// baselines before the planner runs.  The fingerprint captured here is also
			// the snapshot we re-validate against after planning to close the
			// settings-mutated-mid-sync race.
			const startFingerprint = computeDestinationFingerprint(this.settings);
			await this.reconcileDestinationFingerprint(startFingerprint);

			// Phase 1 — Plan
			const planner = new SyncPlanner(
				this.app,
				this.s3Provider,
				this.journal,
				this.pathCodec,
				this.payloadCodec,
				this.settings,
			);
			const plan = await planner.buildPlan();
			this.log(`Plan contains ${plan.length} action(s)`);

			// Phase 1.4 — Destination re-check.  The planner does async S3 I/O during
			// which `updateSettings` could mutate this.settings / pathCodec / s3Provider
			// to point at a different destination.  If that happened, the plan was built
			// against a destination we never validated.  Refuse to execute it.
			if (computeDestinationFingerprint(this.settings) !== startFingerprint) {
				return this.buildBlockedResult(
					'Aborted: destination changed during sync — settings were updated while the planner was running. ' +
					'The pending sync was discarded; the next cycle will re-plan against the new destination.',
				);
			}

			// Phase 1.5 — Safety guard.  Refuse any plan that wants to mass-delete local
			// files when this destination has never completed a successful sync.  This is a
			// belt-and-braces backstop against future bugs that would otherwise drive a
			// destructive plan past the destination-fingerprint check.
			const guardError = await this.checkDestructivePlan(plan);
			if (guardError) {
				return this.buildBlockedResult(guardError);
			}

			// Phase 2 — Execute
			const executor = new SyncExecutor(
				this.app,
				this.s3Provider,
				this.journal,
				this.pathCodec,
				this.payloadCodec,
				this.changeTracker,
				this.deviceId,
				this.debugLogging,
			);
			const result = await executor.execute(plan);

			// Phase 3 — Persist metadata
			if (result.success) {
				await this.journal.setMetadata(LAST_SUCCESSFUL_SYNC_KEY, Date.now());
			}

			this.log(`Sync completed with ${result.errors.length} error(s)`);
			return result;
		} catch (error) {
			// Unexpected top-level failure (e.g. SyncPlanner threw, network
			// unavailable before any item started).  Wrap as a SyncResult so
			// callers always receive a uniform return type and can surface the
			// error via the status bar without crashing the plugin.
			const message = error instanceof Error ? error.message : 'Unknown error';
			console.error(`[S3 Sync] Sync failed: ${message}`);

			return {
				success: false,
				startedAt: Date.now(),
				completedAt: Date.now(),
				filesUploaded: 0,
				filesDownloaded: 0,
				filesDeleted: 0,
				filesAdopted: 0,
				filesForgotten: 0,
				conflicts: [],
				errors: [{ path: '', action: 'skip', message, recoverable: false }],
			};
		} finally {
			this.isSyncing = false;
			this.changeTracker.setSyncInProgress(false);
		}
	}

	/**
	 * Compare the journal's stored destination fingerprint to the one derived from
	 * current settings.  When they differ, wipe the journal so stale baselines from a
	 * previous destination cannot drive a destructive plan, then record the new value.
	 *
	 * The new fingerprint is also recorded on a true first sync (no stored value) so
	 * subsequent destination changes are detectable.
	 *
	 * @param current - Fingerprint of the destination we are about to sync against,
	 *   pre-computed by the caller so it can be reused as the snapshot for the
	 *   post-plan recheck (avoids recomputing and avoids reading mutated settings).
	 */
	private async reconcileDestinationFingerprint(current: string): Promise<void> {
		const stored = await withJournalContext('reading stored destination fingerprint',
			() => this.journal.getMetadata(DESTINATION_FINGERPRINT_KEY),
		);

		if (stored === current) {
			return;
		}

		if (stored !== undefined) {
			this.log('Destination changed — clearing stale journal baselines');
			await withJournalContext('clearing stale journal baselines',
				() => this.journal.clear(),
			);
		}

		await withJournalContext('recording new destination fingerprint',
			() => this.journal.setMetadata(DESTINATION_FINGERPRINT_KEY, current),
		);
	}

	/**
	 * Inspect a freshly built plan and return an error message when it would delete
	 * local files against a destination that has no prior successful sync recorded.
	 *
	 * Rationale: a destination with no `lastSuccessfulSyncAt` either has an empty
	 * journal (true first sync, or freshly cleared by Phase 0) or a journal that
	 * could not be confirmed against any prior successful run.  In both cases the
	 * decision table cannot legitimately emit `delete-local` — that action requires
	 * a matching baseline, which a never-synced destination does not have.  Any
	 * `delete-local` on such a destination is therefore a bug and is refused.
	 *
	 * @param plan - Planner output to inspect.
	 * @returns A human-readable error message when the plan should be blocked, or `null` to proceed.
	 */
	private async checkDestructivePlan(plan: SyncPlanItem[]): Promise<string | null> {
		const deleteCount = plan.reduce((count, item) => item.action === 'delete-local' ? count + 1 : count, 0);
		if (deleteCount === 0) return null;

		const hasPriorSuccess = (await withJournalContext('reading prior successful sync timestamp',
			() => this.journal.getMetadata(LAST_SUCCESSFUL_SYNC_KEY),
		)) !== undefined;
		if (hasPriorSuccess) return null;

		return (
			`Aborted: destructive plan blocked — ${deleteCount} of ${plan.length} action(s) would trash local files ` +
			'against a destination that has no prior successful sync. ' +
			'Verify the configured bucket and sync prefix point to the expected location, ' +
			'then use "Reset sync journal" in Advanced settings if a fresh re-upload is intended.'
		);
	}

	/**
	 * Construct a `SyncResult` representing a plan that was refused by the safety guard.
	 *
	 * The error is marked non-recoverable because retrying the same sync would re-trigger
	 * the same guard; the user must take an explicit action (fix settings or reset the
	 * journal) before another attempt makes sense.
	 *
	 * @param message - Human-readable explanation of why the plan was blocked.
	 * @returns A populated `SyncResult` with `success: false` and a single error.
	 */
	private buildBlockedResult(message: string): SyncResult {
		const now = Date.now();
		console.error(`[S3 Sync] ${message}`);
		return {
			success: false,
			startedAt: now,
			completedAt: now,
			filesUploaded: 0,
			filesDownloaded: 0,
			filesDeleted: 0,
			filesAdopted: 0,
			filesForgotten: 0,
			conflicts: [],
			errors: [{ path: '', action: 'delete-local', message, recoverable: false }],
		};
	}

	/**
	 * Emit a debug log when debug logging is enabled.
	 *
	 * @param message - Log message.
	 */
	private log(message: string): void {
		if (this.debugLogging) {
			console.debug(`[S3 Sync] ${message}`);
		}
	}
}
