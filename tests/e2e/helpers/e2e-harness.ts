/**
 * E2E Test Harness — wires up real plugin modules with mock vault and real S3.
 *
 * Creates fully functional SyncEngine, SnapshotCreator, and supporting modules
 * that operate against a real S3 bucket but use an in-memory vault (E2EVault)
 * and fake-indexeddb (SyncJournal) instead of the Obsidian runtime.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { App } from 'obsidian';

import { S3SyncBackupSettings } from '../../../src/types';
import { S3Provider } from '../../../src/storage/S3Provider';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { SyncJournal } from '../../../src/sync/SyncJournal';
import { SyncPathCodec } from '../../../src/sync/SyncPathCodec';
import { SyncPayloadCodec } from '../../../src/sync/SyncPayloadCodec';
import { ChangeTracker } from '../../../src/sync/ChangeTracker';
import { SnapshotCreator } from '../../../src/backup/SnapshotCreator';
import { RetentionManager } from '../../../src/backup/RetentionManager';
import { E2EVault, E2EApp } from './mock-vault';
import {
	hasS3Credentials,
	getS3Config,
	getTestPrefix,
	createTestSettings,
} from '../../helpers/s3-test-utils';

export { hasS3Credentials };

/** All modules wired up for a single simulated device. */
export interface E2EDevice {
	app: E2EApp;
	vault: E2EVault;
	s3Provider: S3Provider;
	journal: SyncJournal;
	pathCodec: SyncPathCodec;
	payloadCodec: SyncPayloadCodec;
	changeTracker: ChangeTracker;
	syncEngine: SyncEngine;
	snapshotCreator: SnapshotCreator;
	retentionManager: RetentionManager;
	settings: S3SyncBackupSettings;
	deviceId: string;
}

/** Options for creating an E2E device. */
export interface CreateDeviceOptions {
	deviceId?: string;
	encryptionKey?: Uint8Array | null;
	settingsOverrides?: Partial<S3SyncBackupSettings>;
	/** S3 prefix for test isolation. All devices in a test share the same prefix. */
	testPrefix: string;
}

/**
 * Creates a fully wired E2E device — real plugin modules backed by in-memory
 * vault, fake-indexeddb journal, and real S3.
 */
export function createDevice(options: CreateDeviceOptions): E2EDevice {
	const deviceId = options.deviceId ?? `e2e-device-${Math.random().toString(36).substring(7)}`;
	const config = getS3Config();

	const nodeClient = new S3Client({
		endpoint: config.endpoint,
		region: config.region,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
		forcePathStyle: true,
		requestHandler: new NodeHttpHandler({
			connectionTimeout: 5000,
			socketTimeout: 30000,
		}),
	});

	const settings = createTestSettings({
		syncPrefix: options.testPrefix,
		backupPrefix: `${options.testPrefix}-backups`,
		debugLogging: true,
		...options.settingsOverrides,
	});

	const s3Provider = new S3Provider(settings, nodeClient);
	const vault = new E2EVault();
	const app = new E2EApp(vault);

	const journal = new SyncJournal(`e2e-${deviceId}-${Date.now()}`);
	const pathCodec = new SyncPathCodec(settings.syncPrefix);
	const payloadCodec = new SyncPayloadCodec(options.encryptionKey ?? null);
	const changeTracker = new ChangeTracker(app as unknown as App);

	const syncEngine = new SyncEngine(
		app as unknown as App,
		s3Provider,
		journal,
		pathCodec,
		payloadCodec,
		changeTracker,
		settings,
		deviceId,
	);

	const snapshotCreator = new SnapshotCreator(
		app as unknown as App,
		s3Provider,
		settings,
	);
	if (options.encryptionKey) {
		snapshotCreator.setEncryptionKey(options.encryptionKey);
	}

	const retentionManager = new RetentionManager(s3Provider, settings);

	return {
		app,
		vault,
		s3Provider,
		journal,
		pathCodec,
		payloadCodec,
		changeTracker,
		syncEngine,
		snapshotCreator,
		retentionManager,
		settings,
		deviceId,
	};
}

/**
 * Generates a unique test prefix for S3 isolation between test runs.
 * All objects are created under this prefix and cleaned up in afterAll.
 */
export function generateTestPrefix(suiteName: string): string {
	return getTestPrefix(`e2e-${suiteName}`);
}

/**
 * Cleans up all S3 objects under a given prefix. Call in afterAll().
 */
export async function cleanupS3Prefix(s3Provider: S3Provider, prefix: string): Promise<void> {
	const objects = await s3Provider.listObjects(prefix);
	if (objects.length > 0) {
		await s3Provider.deleteFiles(objects.map(o => o.key));
	}
}

/**
 * Initialize device journal. Must be called before any sync operations.
 */
export async function initDevice(device: E2EDevice): Promise<void> {
	await device.journal.initialize();
}

/**
 * Tear down device: close journal.
 */
export async function teardownDevice(device: E2EDevice): Promise<void> {
	device.journal.close();
}
