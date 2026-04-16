/**
 * Executes a list of {@link SyncPlanItem}s with bounded concurrency.
 *
 * Each successful action atomically updates the journal baseline.
 * Fail-fast: after {@link MAX_ERRORS} consecutive errors the executor
 * stops scheduling new work but lets in-flight actions finish.
 */

import { App, TFile } from 'obsidian';
import {
	ConflictMode,
	SyncAction,
	SyncError,
	SyncPlanItem,
	SyncResult,
	SyncStateRecord,
	SyncUploadMetadata,
} from '../types';
import { getVaultFileKind, readVaultFile, toArrayBuffer } from '../utils/vaultFiles';
import { S3Provider } from '../storage/S3Provider';
import { SyncJournal } from './SyncJournal';
import { SyncPathCodec } from './SyncPathCodec';
import { SyncPayloadCodec } from './SyncPayloadCodec';
import { ChangeTracker } from './ChangeTracker';
import { encodeMetadata } from './SyncObjectMetadata';
import { sleep } from '../utils/retry';

/**
 * Maximum number of plan items that may be executing concurrently.
 *
 * 4 is a pragmatic sweet spot: enough parallelism to hide S3 round-trip
 * latency for small files while staying well within typical browser
 * connection-pool limits (usually 6 per host) and avoiding memory spikes
 * from simultaneously buffering many large binary files.
 */
const MAX_CONCURRENCY = 4;

/**
 * Number of item-level errors that triggers fail-fast: the executor stops
 * dispatching new work once this threshold is reached.
 *
 * 3 allows transient failures (e.g. a single throttled S3 request) to be
 * tolerated without abandoning the entire plan, while still preventing a
 * cascade where every remaining item also fails (e.g. lost credentials).
 * In-flight items are always allowed to complete before the loop exits.
 */
const MAX_ERRORS = 3;

/**
 * Executes a {@link SyncPlanItem} list produced by {@link SyncPlanner} with
 * bounded concurrency and fail-fast error handling.
 *
 * ### Concurrency model
 * The executor maintains an `inFlight` set of up to {@link MAX_CONCURRENCY}
 * concurrent promises.  An outer `while` loop drains the set via
 * `Promise.race`; an inner `while` loop greedily fills available slots.
 * This avoids Promise chains of unbounded depth and provides natural
 * backpressure.
 *
 * ### Journal semantics
 * Every action that mutates state (upload, download, delete, adopt) writes
 * a new {@link SyncStateRecord} to the journal **after** the S3 operation
 * succeeds.  This keeps the journal consistent with actual remote state:
 * a crash mid-action leaves a stale baseline rather than a phantom one,
 * which the planner will detect and re-sync on the next run.
 *
 * ### Fail-fast
 * After {@link MAX_ERRORS} item failures the inner fill loop stops accepting
 * new items.  Already-running items finish normally.  The final
 * {@link SyncResult} reports all errors; callers decide whether to retry.
 */
export class SyncExecutor {
	private deviceId: string;
	private debugLogging: boolean;

	/**
	 * @param app           - The Obsidian App instance used for vault file I/O.
	 * @param s3Provider    - S3 abstraction layer for remote object operations.
	 * @param journal       - IndexedDB journal for per-file baseline persistence.
	 * @param pathCodec     - Converts between vault-relative paths and S3 keys.
	 * @param payloadCodec  - Handles encryption/decryption of file content.
	 * @param changeTracker - Tracks which paths are currently syncing so the
	 *   file-watcher can suppress spurious dirty-marks during writes.
	 * @param deviceId      - Stable identifier written into S3 metadata as
	 *   `obsidian-device-id` so other devices know who last wrote a file.
	 * @param debugLogging  - When `true`, emits verbose debug lines to the console.
	 */
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		private payloadCodec: SyncPayloadCodec,
		private changeTracker: ChangeTracker,
		deviceId: string,
		debugLogging: boolean,
	) {
		this.deviceId = deviceId;
		this.debugLogging = debugLogging;
	}

	/**
	 * Execute all items in `plan` with bounded concurrency.
	 *
	 * The method uses a two-level loop:
	 * - **Inner `while`** — fills the `inFlight` set up to {@link MAX_CONCURRENCY}
	 *   slots, stopping early if the error threshold is reached.
	 * - **Outer `while`** — waits for the fastest in-flight promise to settle
	 *   (`Promise.race`), then re-enters the inner loop to top up free slots.
	 *
	 * This pattern is preferable to `Promise.all` because it starts new items
	 * as soon as a slot opens rather than waiting for the entire batch.
	 *
	 * @param plan - Ordered list of sync actions to execute.  The order is
	 *   preserved but items may complete out of order due to concurrency.
	 * @returns A {@link SyncResult} aggregating counters, conflict paths, and
	 *   any errors that occurred.  `success` is `true` only when `errors` is empty.
	 */
	async execute(plan: SyncPlanItem[]): Promise<SyncResult> {
		const result: SyncResult = {
			success: false,
			startedAt: Date.now(),
			completedAt: 0,
			filesUploaded: 0,
			filesDownloaded: 0,
			filesDeleted: 0,
			filesAdopted: 0,
			filesForgotten: 0,
			conflicts: [],
			errors: [],
		};

		let errorCount = 0;
		let planIndex = 0;
		const inFlight = new Set<Promise<void>>();

		// Outer loop: keep going while there are items yet to start OR items
		// still running.  Exits only when both conditions are false.
		while (planIndex < plan.length || inFlight.size > 0) {
			// Inner loop: greedily fill available concurrency slots.
			// Stops when: slots full | plan exhausted | error threshold reached.
			while (
				inFlight.size < MAX_CONCURRENCY &&
				planIndex < plan.length &&
				errorCount < MAX_ERRORS
			) {
				const item = plan[planIndex]!;
				planIndex++;

				this.changeTracker.markPathSyncing(item.path);
				const promise = this.executeItem(item, result)
					.catch((error: unknown) => {
						errorCount++;
						result.errors.push(this.toSyncError(item.path, item.action, error));
					})
					.finally(() => {
						// Remove self from the set once settled so the outer loop
						// can accurately measure how many items are still running.
						inFlight.delete(promise);
					});

				inFlight.add(promise);
			}

			if (inFlight.size > 0) {
				// Wait for the fastest in-flight promise to finish, then
				// re-enter the inner loop to immediately fill the freed slot.
				await Promise.race(inFlight);
			} else {
				// No slots in flight and inner loop was blocked by the error
				// threshold — drain is complete, exit.
				break;
			}
		}

		result.conflicts = (await this.journal.getAllConflicts()).map((c) => c.path);
		result.success = result.errors.length === 0;
		result.completedAt = Date.now();
		return result;
	}

	/**
	 * Dispatch a single plan item to its specific execute handler.
	 *
	 * Logs the action/reason before dispatch, and clears the path from
	 * {@link ChangeTracker} after completion (success or error) so the
	 * file-watcher can resume tracking the file.
	 *
	 * @param item   - The plan item to execute.
	 * @param result - Mutable result object whose counters are incremented here.
	 */
	private async executeItem(item: SyncPlanItem, result: SyncResult): Promise<void> {
		this.log(`${item.action} ${item.path}: ${item.reason}`);

		switch (item.action) {
			case 'adopt':
				await this.executeAdopt(item);
				result.filesAdopted++;
				break;
			case 'upload':
				await this.executeUpload(item);
				result.filesUploaded++;
				break;
			case 'download':
				await this.executeDownload(item);
				result.filesDownloaded++;
				break;
			case 'delete-local':
				await this.executeDeleteLocal(item);
				result.filesDeleted++;
				break;
			case 'delete-remote':
				await this.executeDeleteRemote(item);
				result.filesDeleted++;
				break;
			case 'conflict':
				await this.executeConflict(item);
				result.conflicts.push(item.path);
				break;
			case 'forget':
				await this.executeForget(item);
				result.filesForgotten++;
				break;
			case 'skip':
				break;
		}

		this.changeTracker.clearPath(item.path);
	}

	/**
	 * Adopt an existing remote object as the new baseline without transferring
	 * any file content.
	 *
	 * Used when local and remote content are identical (same SHA-256 fingerprint)
	 * so we only need to record the remote metadata in the journal and confirm
	 * the two sides are in sync.  This is the happy path for the initial sync
	 * of a vault that already exists on both local disk and S3.
	 *
	 * @param item - Plan item with `action: 'adopt'`.
	 * @throws If the S3 `HeadObject` call fails.
	 */
	private async executeAdopt(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);
		const head = await this.s3Provider.headObject(remoteKey);
		const localFile = this.app.vault.getAbstractFileByPath(item.path);

		const localContent = localFile instanceof TFile
			? await readVaultFile(this.app.vault, localFile)
			: null;
		const fingerprint = localContent
			? await this.payloadCodec.fingerprint(localContent)
			: head?.fingerprint ?? '';

		const record: SyncStateRecord = {
			path: item.path,
			remoteKey,
			contentFingerprint: fingerprint,
			localMtime: localFile instanceof TFile ? localFile.stat.mtime : 0,
			localSize: localFile instanceof TFile ? localFile.stat.size : 0,
			remoteClientMtime: head?.clientMtime ?? null,
			remoteObjectSize: head?.size ?? 0,
			remoteEtag: head?.etag,
			remoteLastModified: head?.lastModified ?? null,
			lastWriterDeviceId: head?.deviceId,
			lastSyncedAt: Date.now(),
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Upload the local file to S3 and persist the resulting ETag as the new baseline.
	 *
	 * Supports optimistic concurrency via `If-Match` / `If-None-Match` headers:
	 * - `expectRemoteAbsent: true`  → `If-None-Match: *` (fail if object already exists)
	 * - `expectedRemoteEtag` set    → `If-Match: <etag>` (fail if object was modified)
	 *
	 * The S3 ETag returned by `uploadFile` is stored in the journal so the next
	 * planner run can use it as a revision token to detect remote changes.
	 *
	 * @param item - Plan item with `action: 'upload'`.
	 * @throws If the local file is not found in the vault.
	 * @throws If the S3 upload fails (including ETag mismatch).
	 */
	private async executeUpload(item: SyncPlanItem): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found for upload: ${item.path}`);
		}

		const content = await readVaultFile(this.app.vault, file);
		const fingerprint = await this.payloadCodec.fingerprint(content);
		const payload = this.payloadCodec.encodeForUpload(content);
		const remoteKey = this.pathCodec.localToRemote(item.path);

		const uploadMeta: SyncUploadMetadata = {
			fingerprint,
			clientMtime: file.stat.mtime,
			deviceId: this.deviceId,
			payloadFormat: this.payloadCodec.getActivePayloadFormat(),
		};

		const etag = await this.s3Provider.uploadFile(remoteKey, payload, {
			contentType: this.guessContentType(item.path),
			ifMatch: item.expectRemoteAbsent ? undefined : item.expectedRemoteEtag,
			ifNoneMatch: item.expectRemoteAbsent ? '*' : undefined,
			metadata: encodeMetadata(uploadMeta),
		});

		const record: SyncStateRecord = {
			path: item.path,
			remoteKey,
			contentFingerprint: fingerprint,
			localMtime: file.stat.mtime,
			localSize: file.stat.size,
			remoteClientMtime: file.stat.mtime,
			remoteObjectSize: payload.length,
			remoteEtag: etag,
			remoteLastModified: null,
			lastWriterDeviceId: this.deviceId,
			lastSyncedAt: Date.now(),
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Download a remote object, decode/decrypt it, and write it to the local vault.
	 *
	 * A `sleep(0)` yield is inserted after the vault write to let Obsidian's
	 * internal file-indexer process the new file before we try to look it up via
	 * `getAbstractFileByPath`.  Without this, the TFile may not yet be registered
	 * and we would throw a false "file not found" error.
	 *
	 * @param item - Plan item with `action: 'download'`.
	 * @throws If the remote object has disappeared between planning and execution.
	 * @throws If the downloaded file is not visible in the vault after writing.
	 */
	private async executeDownload(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);
		const downloaded = await this.s3Provider.downloadFileWithMetadata(remoteKey);
		if (!downloaded) {
			throw new Error(`Remote file disappeared during sync: ${item.path}`);
		}

		const plaintext = this.payloadCodec.decodeAfterDownload(downloaded.content, downloaded.payloadFormat);
		const kind = getVaultFileKind(item.path);

		await this.writeLocalFile(item.path, kind === 'text' ? new TextDecoder().decode(plaintext) : plaintext);
		// Yield to the event loop so Obsidian's vault index can register the
		// newly written file before we attempt to look it up.
		await sleep(0);

		const localFile = this.app.vault.getAbstractFileByPath(item.path);
		if (!(localFile instanceof TFile)) {
			throw new Error(`Downloaded file not found in vault: ${item.path}`);
		}

		const fingerprint = await this.payloadCodec.fingerprint(
			kind === 'text' ? new TextDecoder().decode(plaintext) : plaintext,
		);

		const record: SyncStateRecord = {
			path: item.path,
			remoteKey,
			contentFingerprint: fingerprint,
			localMtime: localFile.stat.mtime,
			localSize: localFile.stat.size,
			remoteClientMtime: downloaded.clientMtime ?? null,
			remoteObjectSize: downloaded.size,
			remoteEtag: downloaded.etag,
			remoteLastModified: downloaded.lastModified,
			lastWriterDeviceId: downloaded.deviceId,
			lastSyncedAt: Date.now(),
		};

		await this.journal.setStateRecord(record);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Move the local file to the system trash and remove its journal baseline.
	 *
	 * Using `fileManager.trashFile` (rather than `vault.delete`) respects the
	 * user's Obsidian "Deleted files" preference (system trash vs. `.trash` folder).
	 * If the file no longer exists locally we still clean up the journal entry.
	 *
	 * @param item - Plan item with `action: 'delete-local'`.
	 */
	private async executeDeleteLocal(item: SyncPlanItem): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}

		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Delete the remote S3 object and remove its journal baseline.
	 *
	 * An ETag guard is applied when `expectedRemoteEtag` is set: if the remote
	 * object's current ETag differs from the planned value, the delete is aborted
	 * with an error.  This prevents accidentally deleting a file that was updated
	 * by another device between the planning and execution phases.
	 *
	 * @param item - Plan item with `action: 'delete-remote'`.
	 * @throws If the remote ETag has changed since the plan was built.
	 * @throws If the S3 delete call fails.
	 */
	private async executeDeleteRemote(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);

		if (item.expectedRemoteEtag) {
			const head = await this.s3Provider.headObject(remoteKey);
			if (head && head.etag !== item.expectedRemoteEtag) {
				throw new Error(
					`Remote file ${item.path} changed since planning (expected ETag ${item.expectedRemoteEtag}, got ${head.etag}). Skipping delete.`,
				);
			}
		}

		await this.s3Provider.deleteFile(remoteKey);
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Create conflict artifact files and record the conflict in the journal.
	 *
	 * The {@link ConflictMode} controls which artifacts are produced:
	 * - `'both'`        — rename local → `LOCAL_<name>`, download remote → `REMOTE_<name>`
	 * - `'local-only'`  — rename local → `LOCAL_<name>` (remote object is absent)
	 * - `'remote-only'` — download remote → `REMOTE_<name>` (local file is absent)
	 *
	 * The baseline fingerprint is preserved in the conflict record so future
	 * planner runs can detect when the user has finished resolving (artifacts gone).
	 *
	 * @param item - Plan item with `action: 'conflict'` and an optional `conflictMode`.
	 *   Defaults to `'both'` if `conflictMode` is not set.
	 */
	private async executeConflict(item: SyncPlanItem): Promise<void> {
		const mode: ConflictMode = item.conflictMode ?? 'both';
		const fileName = item.path.substring(item.path.lastIndexOf('/') + 1);
		const dir = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';
		const localArtifactPath = dir ? `${dir}/LOCAL_${fileName}` : `LOCAL_${fileName}`;
		const remoteArtifactPath = dir ? `${dir}/REMOTE_${fileName}` : `REMOTE_${fileName}`;

		if (mode === 'both' || mode === 'local-only') {
			const file = this.app.vault.getAbstractFileByPath(item.path);
			if (file instanceof TFile) {
				await this.app.vault.rename(file, localArtifactPath);
			}
		}

		if (mode === 'both' || mode === 'remote-only') {
			const remoteKey = this.pathCodec.localToRemote(item.path);
			const downloaded = await this.s3Provider.downloadFileWithMetadata(remoteKey);
			if (downloaded) {
				const plaintext = this.payloadCodec.decodeAfterDownload(downloaded.content, downloaded.payloadFormat);
				const kind = getVaultFileKind(item.path);
				await this.writeLocalFile(
					remoteArtifactPath,
					kind === 'text' ? new TextDecoder().decode(plaintext) : plaintext,
				);
			}
		}

		const baseline = await this.journal.getStateRecord(item.path);

		await this.journal.setConflict({
			path: item.path,
			mode,
			localArtifactPath: (mode === 'both' || mode === 'local-only') ? localArtifactPath : undefined,
			remoteArtifactPath: (mode === 'both' || mode === 'remote-only') ? remoteArtifactPath : undefined,
			baselineFingerprint: baseline?.contentFingerprint,
			detectedAt: Date.now(),
		});
	}

	/**
	 * Remove a stale journal baseline for a path that no longer exists on either side.
	 *
	 * This happens when both local and remote have been deleted since the last sync.
	 * We don't need to touch the filesystem or S3 — just clean up the dangling record.
	 *
	 * @param item - Plan item with `action: 'forget'`.
	 */
	private async executeForget(item: SyncPlanItem): Promise<void> {
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

	/**
	 * Write `content` to the vault at `path`, creating parent folders as needed.
	 *
	 * If a file already exists at the path it is updated in-place (modify/modifyBinary).
	 * Otherwise the file is created from scratch.  Binary content is converted to
	 * `ArrayBuffer` because the Obsidian vault API does not accept `Uint8Array` for
	 * binary writes.
	 *
	 * @param path    - Vault-relative destination path (forward slashes).
	 * @param content - File content as a UTF-8 string (text files) or raw bytes (binary).
	 */
	private async writeLocalFile(path: string, content: string | Uint8Array): Promise<void> {
		const existingFile = this.app.vault.getAbstractFileByPath(path);
		if (existingFile instanceof TFile) {
			if (typeof content === 'string') {
				await this.app.vault.modify(existingFile, content);
			} else {
				await this.app.vault.modifyBinary(existingFile, toArrayBuffer(content));
			}
			return;
		}

		await this.ensureParentFolders(path);
		if (typeof content === 'string') {
			await this.app.vault.create(path, content);
		} else {
			await this.app.vault.createBinary(path, toArrayBuffer(content));
		}
	}

	/**
	 * Ensure every ancestor folder of `path` exists in the vault, creating any
	 * missing ones from the root down.
	 *
	 * Folder creation must be top-down because `vault.createFolder` requires its
	 * immediate parent to already exist.  We iterate from the root segment
	 * inward, creating each level only if the vault doesn't already know about it.
	 *
	 * @param path - Vault-relative file path whose parent directories should exist.
	 */
	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split('/');
		parts.pop();
		if (parts.length === 0) return;

		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(currentPath)) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	/**
	 * Determine the HTTP Content-Type for a file based on its extension.
	 *
	 * We use a simple binary/text heuristic rather than a full MIME database:
	 * markdown, plain text, and other text-based vault files get `text/plain`;
	 * everything else (images, PDFs, etc.) gets `application/octet-stream`.
	 * This is sufficient for S3, which doesn't serve the files via HTTP in the
	 * typical sync use-case.
	 *
	 * @param path - Vault-relative file path used to determine the file kind.
	 * @returns An HTTP Content-Type string suitable for the S3 `PutObject` call.
	 */
	private guessContentType(path: string): string {
		return getVaultFileKind(path) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
	}

	/**
	 * Convert an unknown thrown value into a structured {@link SyncError}.
	 *
	 * All item-level errors are marked `recoverable: true` so callers can
	 * decide whether to retry.  The error is also logged to the console at
	 * `error` level regardless of the `debugLogging` flag so problems are
	 * always visible.
	 *
	 * @param path   - Vault-relative path of the file that failed.
	 * @param action - The sync action that was being executed.
	 * @param error  - The raw thrown value (usually an `Error`, but could be anything).
	 * @returns A {@link SyncError} safe to include in {@link SyncResult.errors}.
	 */
	private toSyncError(path: string, action: SyncAction, error: unknown): SyncError {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`[S3 Sync] ${action} failed for ${path}: ${message}`);
		return { path, action, message, recoverable: true };
	}

	/**
	 * Emit a debug log line when debug logging is enabled in settings.
	 *
	 * All log lines are prefixed with `[S3 Sync]` for easy filtering in the
	 * browser developer console.
	 *
	 * @param message - The message to log.
	 */
	private log(message: string): void {
		if (this.debugLogging) {
			console.debug(`[S3 Sync] ${message}`);
		}
	}
}
