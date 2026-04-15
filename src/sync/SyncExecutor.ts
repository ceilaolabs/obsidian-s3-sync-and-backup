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

const MAX_CONCURRENCY = 4;
const MAX_ERRORS = 3;

export class SyncExecutor {
	private deviceId: string;
	private debugLogging: boolean;

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

		while (planIndex < plan.length || inFlight.size > 0) {
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
						inFlight.delete(promise);
					});

				inFlight.add(promise);
			}

			if (inFlight.size > 0) {
				await Promise.race(inFlight);
			} else {
				break;
			}
		}

		result.conflicts = (await this.journal.getAllConflicts()).map((c) => c.path);
		result.success = result.errors.length === 0;
		result.completedAt = Date.now();
		return result;
	}

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

	private async executeDownload(item: SyncPlanItem): Promise<void> {
		const remoteKey = this.pathCodec.localToRemote(item.path);
		const downloaded = await this.s3Provider.downloadFileWithMetadata(remoteKey);
		if (!downloaded) {
			throw new Error(`Remote file disappeared during sync: ${item.path}`);
		}

		const plaintext = this.payloadCodec.decodeAfterDownload(downloaded.content);
		const kind = getVaultFileKind(item.path);

		await this.writeLocalFile(item.path, kind === 'text' ? new TextDecoder().decode(plaintext) : plaintext);
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

	private async executeDeleteLocal(item: SyncPlanItem): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}

		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

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
				const plaintext = this.payloadCodec.decodeAfterDownload(downloaded.content);
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

	private async executeForget(item: SyncPlanItem): Promise<void> {
		await this.journal.deleteStateRecord(item.path);
		await this.journal.deleteConflict(item.path);
	}

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

	private guessContentType(path: string): string {
		return getVaultFileKind(path) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
	}

	private toSyncError(path: string, action: SyncAction, error: unknown): SyncError {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(`[S3 Sync] ${action} failed for ${path}: ${message}`);
		return { path, action, message, recoverable: true };
	}

	private log(message: string): void {
		if (this.debugLogging) {
			console.debug(`[S3 Sync] ${message}`);
		}
	}
}
