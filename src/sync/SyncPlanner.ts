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

interface LocalSnapshot {
	file: TFile;
	mtime: number;
	size: number;
}

interface RemoteSnapshot {
	objectInfo: S3ObjectInfo;
	head?: S3HeadResult;
}

interface PathContext {
	path: string;
	local?: LocalSnapshot;
	remote?: RemoteSnapshot;
	baseline?: SyncStateRecord;
	conflict?: ConflictRecord;
	hasConflictArtifacts: boolean;
	localFingerprint?: string;
	remoteFingerprint?: string;
}

export class SyncPlanner {
	constructor(
		private app: App,
		private s3Provider: S3Provider,
		private journal: SyncJournal,
		private pathCodec: SyncPathCodec,
		private payloadCodec: SyncPayloadCodec,
		private settings: S3SyncBackupSettings,
	) {}

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

	private async classifyLocal(ctx: PathContext): Promise<LocalClassification> {
		if (!ctx.local) return 'L0';
		if (!ctx.baseline) return 'L+';

		if (ctx.local.mtime === ctx.baseline.localMtime && ctx.local.size === ctx.baseline.localSize) {
			return 'L=';
		}

		const fp = await this.computeLocalFingerprint(ctx);
		return fp === ctx.baseline.contentFingerprint ? 'L=' : 'LΔ';
	}

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

	private async computeLocalFingerprint(ctx: PathContext): Promise<string> {
		if (ctx.localFingerprint) return ctx.localFingerprint;

		const file = ctx.local?.file;
		if (!file) throw new Error(`No local file for ${ctx.path}`);

		const content = await readVaultFile(this.app.vault, file);
		ctx.localFingerprint = await this.payloadCodec.fingerprint(content);
		return ctx.localFingerprint;
	}

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

		const plaintext = this.payloadCodec.decodeAfterDownload(downloaded.content);
		ctx.remoteFingerprint = await this.payloadCodec.fingerprint(plaintext);
	}

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

	private shouldExclude(path: string): boolean {
		if (isConflictFile(path)) return true;

		const filename = getFilename(path);
		if (filename.startsWith('.obsidian-s3-sync')) return true;

		return matchesAnyGlob(path, this.settings.excludePatterns);
	}
}
