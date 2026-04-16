/**
 * Discovers local + remote state, classifies each path, and feeds the
 * {@link decide} function to produce an ordered list of {@link SyncPlanItem}s.
 *
 * Lazy hashing: the planner uses mtime+size fast-path comparisons first
 * and only computes SHA-256 fingerprints when the fast-path is ambiguous.
 */

import { App, TFile } from 'obsidian';
import {
	ConflictRecord,
	DecisionInput,
	LocalClassification,
	RemoteClassification,
	S3HeadResult,
	S3ObjectInfo,
	S3SyncBackupSettings,
	SyncPlanItem,
	SyncStateRecord,
} from '../types';
import { isConflictFile, matchesAnyGlob, getFilename } from '../utils/paths';
import { readVaultFile } from '../utils/vaultFiles';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';
import { SyncPayloadCodec } from './SyncPayloadCodec';
import { S3Provider } from '../storage/S3Provider';
import { decide } from './SyncDecisionTable';

/**
 * Immutable snapshot of a single local vault file captured during state discovery.
 *
 * Holding a reference to the `TFile` object avoids a second vault lookup when the
 * executor later needs to read file contents.  `mtime` and `size` are copied out of
 * `file.stat` at discovery time so the planner can compare them against the baseline
 * without re-reading the file system.
 */
interface LocalSnapshot {
	/** Obsidian vault handle for this file; used to read content when hashing is needed. */
	file: TFile;
	/** Last-modified timestamp in epoch milliseconds as reported by the vault. */
	mtime: number;
	/** File size in bytes as reported by the vault. */
	size: number;
}

/**
 * Immutable snapshot of a single S3 object captured during state discovery.
 *
 * `objectInfo` is always populated from the list-objects response (cheap).  `head` is
 * lazily populated only when the ETag fast-path is insufficient and the SHA-256 fingerprint
 * stored in custom S3 metadata is needed for classification.
 */
interface RemoteSnapshot {
	/** Metadata returned by the S3 list-objects call (key, etag, size, lastModified). */
	objectInfo: S3ObjectInfo;
	/**
	 * Lazily fetched HeadObject result.  Populated by {@link SyncPlanner.ensureRemoteFingerprint}
	 * when the ETag comparison is ambiguous.  Contains the SHA-256 fingerprint stored in
	 * the `obsidian-fingerprint` custom S3 metadata header if present.
	 */
	head?: S3HeadResult;
}

/**
 * Aggregates all known state for a single vault-relative file path.
 *
 * This is the central data structure of the planner.  One `PathContext` is created per
 * unique path encountered across local files, S3 objects, journal baselines, and conflict
 * records.  The planner then classifies each side independently and passes the result to
 * {@link decide} to get the concrete {@link SyncPlanItem} action.
 *
 * Fields that are `undefined` signal absence: no `local` means the file does not exist
 * locally; no `baseline` means the file has never been successfully synced before.
 */
interface PathContext {
	/** Vault-relative normalized file path (e.g. `"Notes/daily.md"`). */
	path: string;
	/** Local file snapshot, or `undefined` if the file does not exist locally. */
	local?: LocalSnapshot;
	/** Remote S3 object snapshot, or `undefined` if no object exists in S3. */
	remote?: RemoteSnapshot;
	/** Last-known-good sync baseline from the journal, or `undefined` for new files. */
	baseline?: SyncStateRecord;
	/** Unresolved conflict record from the journal, or `undefined` if none. */
	conflict?: ConflictRecord;
	/**
	 * `true` when a `LOCAL_` or `REMOTE_` conflict artifact for this path was found on disk.
	 * Used by the decision table to suppress further action until the user resolves the conflict.
	 */
	hasConflictArtifacts: boolean;
	/**
	 * SHA-256 fingerprint of the local file's plaintext content.
	 * Populated lazily by {@link SyncPlanner.computeLocalFingerprint} only when the
	 * mtime+size fast-path is insufficient.
	 */
	localFingerprint?: string;
	/**
	 * SHA-256 fingerprint of the remote object's plaintext content.
	 * Populated lazily by {@link SyncPlanner.ensureRemoteFingerprint} via HeadObject metadata
	 * or, as a last resort, a full object download + decrypt.
	 */
	remoteFingerprint?: string;
}

/**
 * Produces an ordered {@link SyncPlanItem} list by discovering local+remote state,
 * classifying each path, and delegating decisions to {@link decide}.
 *
 * The planner is the second stage of the sync pipeline:
 * `SyncEngine` → **`SyncPlanner`** → `SyncExecutor`
 *
 * It deliberately contains no side effects — it reads from the vault, S3, and journal
 * but never writes.  All mutations are deferred to `SyncExecutor`.
 */
export class SyncPlanner {
	/**
	 * @param app          - Obsidian application instance; used to enumerate local vault files.
	 * @param s3Provider   - S3 operations wrapper; used to list and (lazily) head/download remote objects.
	 * @param journal      - IndexedDB journal; used to read per-file baselines and conflict records.
	 * @param pathCodec    - Translates between local vault paths and S3 object keys.
	 * @param payloadCodec - Handles encryption-aware content encoding and SHA-256 fingerprinting.
	 * @param settings     - Plugin settings; used to read `excludePatterns` for path filtering.
	 */
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		private payloadCodec: SyncPayloadCodec,
		private settings: S3SyncBackupSettings,
	) {}

	/**
	 * Main entry point.  Discovers the full local+remote state, classifies every path, and
	 * returns an ordered list of actions for the executor to carry out.
	 *
	 * `skip` actions are intentionally filtered out before returning — the executor does not
	 * need to process no-ops.  The returned list is sorted by {@link sortPlan} so that
	 * metadata-only actions (`adopt`, `forget`) run before data-transfer actions, and
	 * conflict actions run last to avoid interfering with in-flight transfers.
	 *
	 * @returns Ordered array of {@link SyncPlanItem}s ready for execution. Never contains `skip` items.
	 */
	async buildPlan(): Promise<SyncPlanItem[]> {
		const contexts = await this.discoverState();
		const plan: SyncPlanItem[] = [];

		for (const ctx of contexts.values()) {
			const localClass = await this.classifyLocal(ctx);
			const remoteClass = await this.classifyRemote(ctx);

			const input: DecisionInput = {
				path: ctx.path,
				local: localClass,
				remote: remoteClass,
				hasUnresolvedConflict: ctx.conflict !== undefined,
				hasConflictArtifacts: ctx.hasConflictArtifacts,
				localExists: ctx.local !== undefined,
				remoteExists: ctx.remote !== undefined,
				hasBaseline: ctx.baseline !== undefined,
				localFingerprint: ctx.localFingerprint,
				remoteFingerprint: ctx.remoteFingerprint,
			};

			const item = decide(input);

			if (item.action !== 'skip') {
				if (ctx.remote?.objectInfo.etag) {
					item.expectedRemoteEtag = ctx.remote.objectInfo.etag.replace(/"/g, '');
				}
				if (!ctx.remote) {
					item.expectRemoteAbsent = true;
				}
				plan.push(item);
			}
		}

		return this.sortPlan(plan);
	}

	/**
	 * Aggregates all observable state into a map of {@link PathContext} objects, one per unique path.
	 *
	 * Performs four sequential passes:
	 * 1. **Local files** — enumerates vault files; conflict artifacts (`LOCAL_`/`REMOTE_` prefixed)
	 *    are skipped as data paths but their original path is flagged with `hasConflictArtifacts`.
	 * 2. **Remote objects** — lists S3 objects under the sync prefix; metadata keys and excluded
	 *    paths are skipped.
	 * 3. **Journal baselines** — reads all stored `SyncStateRecord`s so the classifier can
	 *    determine whether each side changed since the last successful sync.
	 * 4. **Conflict records** — attaches any persisted unresolved-conflict records to their path.
	 *
	 * Using `getOrCreate` across all four passes ensures that a path encountered only remotely
	 * (e.g. a file deleted locally) still gets a context entry so the planner can schedule a
	 * delete-local action.
	 *
	 * @returns A map from vault-relative path to its fully populated {@link PathContext}.
	 */
	private async discoverState(): Promise<Map<string, PathContext>> {
		const contexts = new Map<string, PathContext>();
		const conflictOriginalPaths = new Set<string>();

		const localFiles = this.app.vault.getFiles();
		for (const file of localFiles) {
			if (isConflictFile(file.path)) {
				const original = this.getOriginalFromConflictFilename(file.path);
				if (original) {
					conflictOriginalPaths.add(original);
				}
				continue;
			}

			if (this.shouldExclude(file.path)) continue;

			const ctx = this.getOrCreate(contexts, file.path);
			ctx.local = { file, mtime: file.stat.mtime, size: file.stat.size };
		}

		const remoteObjects = await this.s3Provider.listObjects(this.pathCodec.getListPrefix());
		for (const obj of remoteObjects) {
			if (this.pathCodec.isMetadataKey(obj.key)) continue;

			const localPath = this.pathCodec.remoteToLocal(obj.key);
			if (!localPath || this.shouldExclude(localPath)) continue;

			const ctx = this.getOrCreate(contexts, localPath);
			ctx.remote = {
				objectInfo: { ...obj, etag: obj.etag?.replace(/"/g, '') },
			};
		}

		const allBaselines = await this.journal.getAllStateRecords();
		for (const baseline of allBaselines) {
			if (this.shouldExclude(baseline.path)) continue;
			const ctx = this.getOrCreate(contexts, baseline.path);
			ctx.baseline = baseline;
		}

		const allConflicts = await this.journal.getAllConflicts();
		for (const conflict of allConflicts) {
			if (this.shouldExclude(conflict.path)) continue;
			const ctx = this.getOrCreate(contexts, conflict.path);
			ctx.conflict = conflict;
		}

		for (const path of conflictOriginalPaths) {
			this.getOrCreate(contexts, path).hasConflictArtifacts = true;
		}

		return contexts;
	}

	/**
	 * Classifies the local side of a path using the L0/L+/L=/LΔ taxonomy.
	 *
	 * Classification logic (evaluated in order):
	 * - **L0**: No local file exists.
	 * - **L+**: Local file exists but no baseline — file is new, never synced before.
	 * - **L=**: mtime and size match the baseline exactly → fast-path, no SHA-256 needed.
	 * - **L=**: mtime or size differ but SHA-256 fingerprint matches baseline → content unchanged
	 *           (mtime-only touches, e.g. from a text editor on save, don't count as a change).
	 * - **LΔ**: SHA-256 fingerprint differs → file was genuinely modified locally.
	 *
	 * @param ctx - Path context populated by {@link discoverState}.
	 * @returns The local classification label consumed by {@link decide}.
	 */
	private async classifyLocal(ctx: PathContext): Promise<LocalClassification> {
		if (!ctx.local) return 'L0';
		if (!ctx.baseline) return 'L+';

		if (ctx.local.mtime === ctx.baseline.localMtime && ctx.local.size === ctx.baseline.localSize) {
			return 'L=';
		}

		const fp = await this.computeLocalFingerprint(ctx);
		return fp === ctx.baseline.contentFingerprint ? 'L=' : 'LΔ';
	}

	/**
	 * Classifies the remote side of a path using the R0/R+/R=/RΔ taxonomy.
	 *
	 * Classification logic (evaluated in order):
	 * - **R0**: No remote object exists.
	 * - **R+**: Remote object exists but no baseline — object is new from this device's perspective.
	 * - **R=**: ETag matches baseline exactly → fast-path, the object has not been replaced in S3.
	 * - **R=**: Size differs from baseline → SHA-256 is fetched; fingerprint matches baseline
	 *           → same content re-uploaded (e.g. after a forced re-upload).
	 * - **RΔ**: SHA-256 fingerprint differs → remote object was genuinely modified on another device.
	 *
	 * Note: ETags are used as cheap revision tokens only, not as content identity (they are
	 * S3-provider-specific and may change for identical content across providers or upload methods).
	 * SHA-256 of plaintext is the authoritative content identity.
	 *
	 * @param ctx - Path context populated by {@link discoverState}.
	 * @returns The remote classification label consumed by {@link decide}.
	 */
	private async classifyRemote(ctx: PathContext): Promise<RemoteClassification> {
		if (!ctx.remote) return 'R0';
		if (!ctx.baseline) return 'R+';

		const remoteEtag = ctx.remote.objectInfo.etag;
		if (remoteEtag && ctx.baseline.remoteEtag && remoteEtag === ctx.baseline.remoteEtag) {
			return 'R=';
		}

		const remoteSize = ctx.remote.objectInfo.size;
		if (remoteSize !== ctx.baseline.remoteObjectSize) {
			await this.ensureRemoteFingerprint(ctx);
			return ctx.remoteFingerprint === ctx.baseline.contentFingerprint ? 'R=' : 'RΔ';
		}

		await this.ensureRemoteFingerprint(ctx);
		return ctx.remoteFingerprint === ctx.baseline.contentFingerprint ? 'R=' : 'RΔ';
	}

	/**
	 * Computes and caches the SHA-256 fingerprint of the local file's plaintext content.
	 *
	 * Results are memoized on `ctx.localFingerprint` so repeated calls within the same
	 * planning cycle do not re-read or re-hash the file.
	 *
	 * @param ctx - Path context; must have a populated `local` field.
	 * @returns SHA-256 hex fingerprint of the plaintext file content.
	 * @throws {Error} If `ctx.local` is undefined (caller contract violation).
	 */
	private async computeLocalFingerprint(ctx: PathContext): Promise<string> {
		if (ctx.localFingerprint) return ctx.localFingerprint;

		const file = ctx.local?.file;
		if (!file) throw new Error(`No local file for ${ctx.path}`);

		const content = await readVaultFile(this.app.vault, file);
		ctx.localFingerprint = await this.payloadCodec.fingerprint(content);
		return ctx.localFingerprint;
	}

	/**
	 * Ensures `ctx.remoteFingerprint` is populated, performing the minimum S3 API calls needed.
	 *
	 * Resolution strategy (laziest-first):
	 * 1. Already cached on `ctx.remoteFingerprint` → no-op.
	 * 2. HeadObject metadata contains `obsidian-fingerprint` → use it directly (no download).
	 * 3. No fingerprint in metadata → download the full object, decrypt it, and compute SHA-256.
	 *    This is the most expensive path and only occurs for objects uploaded by older plugin
	 *    versions that did not store the fingerprint in custom metadata.
	 *
	 * @param ctx - Path context; must have a populated `remote` field (no-op if absent).
	 */
	private async ensureRemoteFingerprint(ctx: PathContext): Promise<void> {
		if (ctx.remoteFingerprint) return;

		if (!ctx.remote) return;

		if (!ctx.remote.head) {
			const remoteKey = this.pathCodec.localToRemote(ctx.path);
			ctx.remote.head = (await this.s3Provider.headObject(remoteKey)) ?? undefined;
		}

		if (ctx.remote.head?.fingerprint) {
			ctx.remoteFingerprint = ctx.remote.head.fingerprint;
			return;
		}

		const remoteKey = this.pathCodec.localToRemote(ctx.path);
		const downloaded = await this.s3Provider.downloadFileWithMetadata(remoteKey);
		if (!downloaded) return;

		const plaintext = this.payloadCodec.decodeAfterDownload(downloaded.content, downloaded.payloadFormat);
		ctx.remoteFingerprint = await this.payloadCodec.fingerprint(plaintext);
	}

	/**
	 * Sorts a plan so that actions are executed in a safe, dependency-respecting order.
	 *
	 * Ordering rationale:
	 * - `adopt` / `forget` (0/1): Pure journal updates — no file I/O, no risk.
	 * - `delete-local` / `delete-remote` (2/3): Deletions before transfers to avoid
	 *   overwriting a deleted file with a stale copy.
	 * - `download` / `upload` (4/5): Data transfers after bookkeeping.
	 * - `conflict` (6): Conflict resolution after all clean operations complete so that
	 *   conflict artifact creation cannot shadow a legitimate download/upload.
	 * - `skip` (7): Filtered out before `buildPlan` returns, included here for completeness.
	 *
	 * Within the same action tier, paths are sorted lexicographically for deterministic output.
	 *
	 * @param plan - Unsorted array of plan items (no `skip` items expected).
	 * @returns A new sorted array; the input array is mutated in place and also returned.
	 */
	private sortPlan(plan: SyncPlanItem[]): SyncPlanItem[] {
		const order: Record<string, number> = {
			'adopt': 0,
			'forget': 1,
			'delete-local': 2,
			'delete-remote': 3,
			'download': 4,
			'upload': 5,
			'conflict': 6,
			'skip': 7,
		};

		return plan.sort((a, b) => {
			const ao = order[a.action] ?? 99;
			const bo = order[b.action] ?? 99;
			if (ao !== bo) return ao - bo;
			return a.path.localeCompare(b.path);
		});
	}

	/**
	 * Returns the existing {@link PathContext} for `path`, or creates and registers a new one.
	 *
	 * Using a lazy-create helper ensures that the four discovery passes in {@link discoverState}
	 * can each contribute to the same context object without needing to pre-populate the map.
	 *
	 * @param map  - The shared path → context registry.
	 * @param path - Vault-relative file path.
	 * @returns The existing or newly created context for `path`.
	 */
	private getOrCreate(map: Map<string, PathContext>, path: string): PathContext {
		const existing = map.get(path);
		if (existing) return existing;

		const created: PathContext = {
			path,
			hasConflictArtifacts: false,
		};
		map.set(path, created);
		return created;
	}

	/**
	 * Extracts the original (pre-conflict) vault path from a `LOCAL_` or `REMOTE_` artifact filename.
	 *
	 * Conflict artifacts are created with the prefix prepended to the filename portion only
	 * (not the directory), so stripping `LOCAL_` (6 chars) or `REMOTE_` (7 chars) from the
	 * filename and re-joining with the original directory yields the canonical path.
	 *
	 * @param conflictPath - Vault-relative path of the conflict artifact (e.g. `"Notes/LOCAL_daily.md"`).
	 * @returns The original vault path (e.g. `"Notes/daily.md"`), or `null` if the path is not
	 *          a recognized conflict artifact format.
	 */
	private getOriginalFromConflictFilename(conflictPath: string): string | null {
		const filename = getFilename(conflictPath);
		const dir = conflictPath.includes('/')
			? conflictPath.substring(0, conflictPath.lastIndexOf('/'))
			: '';

		let originalName: string;
		if (filename.startsWith('LOCAL_')) {
			originalName = filename.substring(6);
		} else if (filename.startsWith('REMOTE_')) {
			originalName = filename.substring(7);
		} else {
			return null;
		}

		return dir ? `${dir}/${originalName}` : originalName;
	}

	/**
	 * Determines whether a path should be excluded from sync consideration.
	 *
	 * A path is excluded when any of the following is true:
	 * - It is a conflict artifact (`LOCAL_` or `REMOTE_` prefixed filename) — already handled
	 *   separately in {@link discoverState} and must not appear as a sync target.
	 * - Its filename starts with `.obsidian-s3-sync` — internal plugin metadata files that
	 *   must never be synced as ordinary vault content (e.g. the `.vault.enc` marker).
	 * - It matches any pattern in `settings.excludePatterns` — user-configured glob exclusions.
	 *
	 * @param path - Vault-relative file path to evaluate.
	 * @returns `true` if the path should be skipped entirely; `false` if it should be planned.
	 */
	private shouldExclude(path: string): boolean {
		if (isConflictFile(path)) return true;

		const filename = getFilename(path);
		if (filename.startsWith('.obsidian-s3-sync')) return true;

		return matchesAnyGlob(path, this.settings.excludePatterns);
	}
}
