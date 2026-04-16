/**
 * @jest-environment node
 */

import { App, TFile } from 'obsidian';
import {
	EncryptionCoordinator,
	EncryptionCoordinatorCallbacks,
} from '../../src/crypto/EncryptionCoordinator';
import { VaultMarker } from '../../src/crypto/VaultMarker';
import { validatePassphrase } from '../../src/crypto/KeyDerivation';
import { encrypt } from '../../src/crypto/FileEncryptor';
import { hashContent } from '../../src/crypto/Hasher';
import { encodeMetadata } from '../../src/sync/SyncObjectMetadata';
import { matchesAnyGlob } from '../../src/utils/paths';
import { readVaultFile } from '../../src/utils/vaultFiles';
import { SyncLease } from '../../src/sync/SyncLease';
import {
	DEFAULT_SETTINGS,
	EncryptionMarkerState,
	S3SyncBackupSettings,
	VaultEncryptionMarker,
} from '../../src/types';
import { S3Provider } from '../../src/storage/S3Provider';
import { SyncPayloadCodec } from '../../src/sync/SyncPayloadCodec';
import { SyncPathCodec } from '../../src/sync/SyncPathCodec';
import { SnapshotCreator } from '../../src/backup/SnapshotCreator';
import { BackupDownloader } from '../../src/backup/BackupDownloader';

jest.mock('../../src/crypto/VaultMarker');
jest.mock('../../src/crypto/KeyDerivation');
jest.mock('../../src/crypto/FileEncryptor');
jest.mock('../../src/crypto/Hasher');
jest.mock('../../src/sync/SyncObjectMetadata');
jest.mock('../../src/utils/paths');
jest.mock('../../src/utils/vaultFiles');
jest.mock('../../src/sync/SyncLease');

type MarkerMetadata = Omit<VaultEncryptionMarker, 'verificationToken'>;

type MockVaultMarkerInstance = {
	exists: jest.Mock<Promise<boolean>, []>;
	getMetadata: jest.Mock<Promise<MarkerMetadata | null>, []>;
	create: jest.Mock<Promise<Uint8Array>, [string, string]>;
	verify: jest.Mock<Promise<Uint8Array | null>, [string]>;
	delete: jest.Mock<Promise<void>, []>;
	updateState: jest.Mock<Promise<void>, [EncryptionMarkerState, string, unknown?]>;
};

type MockSyncLeaseInstance = {
	acquire: jest.Mock<Promise<void>, [string, 'migration']>;
	renew: jest.Mock<Promise<void>, []>;
	release: jest.Mock<Promise<void>, []>;
};

class MockVaultFile extends TFile {
	constructor(path: string, mtime = 1234, size = 1) {
		super();
		this.path = path;
		this.name = path.split('/').pop() ?? path;
		this.basename = this.name.replace(/\.[^.]+$/, '');
		this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
		this.stat = {
			ctime: mtime,
			mtime,
			size,
		};
	}
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		...DEFAULT_SETTINGS,
		syncPrefix: 'vault',
		encryptionEnabled: false,
		excludePatterns: [],
		debugLogging: false,
		...overrides,
	};
}

function createMarkerMetadata(state: EncryptionMarkerState): MarkerMetadata {
	return {
		version: 3,
		salt: 'salt',
		state,
		createdAt: '2024-01-01T00:00:00.000Z',
		createdBy: 'device-1',
		updatedAt: '2024-01-01T00:00:00.000Z',
		updatedBy: 'device-1',
	};
}

function createCallbacks(): EncryptionCoordinatorCallbacks {
	return {
		saveSettings: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
		pauseSchedulers: jest.fn(),
		resumeSchedulers: jest.fn(),
	};
}

describe('EncryptionCoordinator', () => {
	const deviceId = 'device-123';
	const derivedKey = new Uint8Array([1, 2, 3, 4]);

	const mockS3Provider = {
		uploadFile: jest.fn(),
	} as unknown as S3Provider;

	const mockPayloadCodec = {
		updateKey: jest.fn(),
	} as unknown as SyncPayloadCodec;

	const mockPathCodec = {
		localToRemote: jest.fn(),
	} as unknown as SyncPathCodec;

	const mockSnapshotCreator = {
		setEncryptionKey: jest.fn(),
	} as unknown as SnapshotCreator;

	const mockBackupDownloader = {
		setEncryptionKey: jest.fn(),
	} as unknown as BackupDownloader;

	const mockApp = {
		vault: {
			getFiles: jest.fn(),
		},
	} as unknown as App;

	const mockedVaultMarker = VaultMarker as jest.MockedClass<typeof VaultMarker>;
	const mockedSyncLease = SyncLease as jest.MockedClass<typeof SyncLease>;
	const mockedValidatePassphrase = validatePassphrase as jest.MockedFunction<typeof validatePassphrase>;
	const mockedEncrypt = encrypt as jest.MockedFunction<typeof encrypt>;
	const mockedHashContent = hashContent as jest.MockedFunction<typeof hashContent>;
	const mockedEncodeMetadata = encodeMetadata as jest.MockedFunction<typeof encodeMetadata>;
	const mockedMatchesAnyGlob = matchesAnyGlob as jest.MockedFunction<typeof matchesAnyGlob>;
	const mockedReadVaultFile = readVaultFile as jest.MockedFunction<typeof readVaultFile>;

	let settings: S3SyncBackupSettings;
	let callbacks: EncryptionCoordinatorCallbacks;
	let coordinator: EncryptionCoordinator;
	let markerInstances: MockVaultMarkerInstance[];
	let leaseInstances: MockSyncLeaseInstance[];
	let consoleErrorSpy: jest.SpyInstance;
	let consoleDebugSpy: jest.SpyInstance;
	let originalCrypto: Crypto | undefined;

	function createMarkerInstance(): MockVaultMarkerInstance {
		return {
			exists: jest.fn<Promise<boolean>, []>(),
			getMetadata: jest.fn<Promise<MarkerMetadata | null>, []>(),
			create: jest.fn<Promise<Uint8Array>, [string, string]>(),
			verify: jest.fn<Promise<Uint8Array | null>, [string]>(),
			delete: jest.fn<Promise<void>, []>(),
			updateState: jest.fn<Promise<void>, [EncryptionMarkerState, string, unknown?]>(),
		};
	}

	function createLeaseInstance(): MockSyncLeaseInstance {
		return {
			acquire: jest.fn<Promise<void>, [string, 'migration']>().mockResolvedValue(undefined),
			renew: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
			release: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
		};
	}

	function currentMarker(): MockVaultMarkerInstance {
		return markerInstances[markerInstances.length - 1];
	}

	function currentLease(): MockSyncLeaseInstance {
		return leaseInstances[leaseInstances.length - 1];
	}

	async function setEncryptedRemoteAndUnlock(): Promise<void> {
		currentMarker().exists.mockResolvedValue(true);
		currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
		currentMarker().verify.mockResolvedValue(derivedKey);
		await coordinator.refreshRemoteMode(callbacks.saveSettings);
		await coordinator.unlock('correct-passphrase');
	}

	beforeEach(() => {
		jest.clearAllMocks();

		settings = createSettings();
		callbacks = createCallbacks();
		markerInstances = [];
		leaseInstances = [];
		originalCrypto = globalThis.crypto;
		Object.defineProperty(globalThis, 'crypto', {
			value: {
				...originalCrypto,
				randomUUID: jest.fn(() => 'migration-uuid'),
			},
			configurable: true,
		});

		mockedVaultMarker.mockImplementation(() => {
			const instance = createMarkerInstance();
			markerInstances.push(instance);
			return instance as unknown as VaultMarker;
		});

		mockedSyncLease.mockImplementation(() => {
			const instance = createLeaseInstance();
			leaseInstances.push(instance);
			return instance as unknown as SyncLease;
		});

		mockedValidatePassphrase.mockReturnValue({ valid: true, strength: 'strong', message: 'OK' });
		mockedEncrypt.mockImplementation((content: string | Uint8Array) => {
			const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
			return new Uint8Array([255, ...bytes]);
		});
		mockedHashContent.mockResolvedValue('deadbeef');
		mockedEncodeMetadata.mockImplementation((metadata) => ({
			fingerprint: metadata.fingerprint,
			clientMtime: String(metadata.clientMtime),
			deviceId: metadata.deviceId,
			payloadFormat: metadata.payloadFormat,
		}));
		mockedMatchesAnyGlob.mockReturnValue(false);
		mockedReadVaultFile.mockResolvedValue('default content');

		(mockS3Provider.uploadFile as jest.Mock).mockResolvedValue(undefined);
		(mockPathCodec.localToRemote as jest.Mock).mockImplementation((path: string) => `vault/${path}`);
		(mockApp.vault.getFiles as jest.Mock).mockReturnValue([]);

		coordinator = new EncryptionCoordinator(
			mockApp,
			mockS3Provider,
			mockPayloadCodec,
			mockPathCodec,
			mockSnapshotCreator,
			mockBackupDownloader,
			settings,
			deviceId,
		);

		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
	});

	afterEach(() => {
		Object.defineProperty(globalThis, 'crypto', {
			value: originalCrypto,
			configurable: true,
		});
		consoleErrorSpy.mockRestore();
		consoleDebugSpy.mockRestore();
	});

	/** Verifies public runtime state snapshots exposed to the UI and guards. */
	describe('getState()', () => {
		it('returns plaintext state when no remote marker or key is present', () => {
			expect(coordinator.getState()).toEqual({
				remoteMode: 'plaintext',
				hasKey: false,
				isBusy: false,
			});
		});

		it('returns encrypted state without a loaded key after remote marker refresh', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getState()).toEqual({
				remoteMode: 'encrypted',
				hasKey: false,
				isBusy: false,
			});
		});

		it('returns encrypted state with a loaded key after unlock succeeds', async () => {
			await setEncryptedRemoteAndUnlock();

			expect(coordinator.getState()).toEqual({
				remoteMode: 'encrypted',
				hasKey: true,
				isBusy: false,
			});
		});

		it('returns busy state while enabling migration is in progress', async () => {
			const acquireDeferred = createDeferred<void>();
			currentLease().acquire.mockReturnValue(acquireDeferred.promise);
			currentMarker().create.mockResolvedValue(derivedKey);

			const pendingEnable = coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(coordinator.getState()).toEqual({
				remoteMode: 'plaintext',
				hasKey: false,
				isBusy: true,
			});

			acquireDeferred.resolve(undefined);
			await pendingEnable;
		});
	});

	/** Covers the main operational guard used by sync and backup entry points. */
	describe('shouldBlock()', () => {
		it('returns true while a local enable migration is running', async () => {
			const acquireDeferred = createDeferred<void>();
			currentLease().acquire.mockReturnValue(acquireDeferred.promise);
			currentMarker().create.mockResolvedValue(derivedKey);

			const pendingEnable = coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(coordinator.shouldBlock()).toBe(true);

			acquireDeferred.resolve(undefined);
			await pendingEnable;
		});

		it('returns true when remote mode is transitioning', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('transitioning'));

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
		});

		it('returns true when the vault is encrypted remotely and no key is loaded', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
		});

		it('returns false for plaintext vaults', () => {
			expect(coordinator.shouldBlock()).toBe(false);
		});

		it('returns false when the vault is encrypted and a key is loaded', async () => {
			await setEncryptedRemoteAndUnlock();

			expect(coordinator.shouldBlock()).toBe(false);
		});
	});

	/** Explains why sync or backup operations are currently blocked. */
	describe('getBlockReason()', () => {
		it('returns the busy reason while a local migration is running', async () => {
			const acquireDeferred = createDeferred<void>();
			currentLease().acquire.mockReturnValue(acquireDeferred.promise);
			currentMarker().create.mockResolvedValue(derivedKey);

			const pendingEnable = coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(coordinator.getBlockReason()).toBe('Encryption migration in progress');

			acquireDeferred.resolve(undefined);
			await pendingEnable;
		});

		it('returns the transitioning reason when another device is changing encryption state', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('transitioning'));

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getBlockReason()).toBe('Encryption state transition in progress on another device');
		});

		it('returns the unlock reason when the vault is encrypted and locked', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getBlockReason()).toBe('Vault is encrypted — enter passphrase in settings to unlock');
		});

		it('returns null when operations are not blocked', async () => {
			await setEncryptedRemoteAndUnlock();

			expect(coordinator.getBlockReason()).toBeNull();
		});
	});

	/** Reads the remote vault marker and reconciles local settings with it. */
	describe('refreshRemoteMode(saveSettings)', () => {
		it('sets plaintext mode and disables the local setting when no marker exists', async () => {
			settings.encryptionEnabled = true;
			currentMarker().exists.mockResolvedValue(false);

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getState().remoteMode).toBe('plaintext');
			expect(settings.encryptionEnabled).toBe(false);
			expect(callbacks.saveSettings).toHaveBeenCalledTimes(1);
		});

		it('does not save settings when no marker exists and local encryption is already disabled', async () => {
			currentMarker().exists.mockResolvedValue(false);

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getState().remoteMode).toBe('plaintext');
			expect(callbacks.saveSettings).not.toHaveBeenCalled();
		});

		it('sets encrypted mode and enables the local setting when the remote marker is enabled', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getState().remoteMode).toBe('encrypted');
			expect(settings.encryptionEnabled).toBe(true);
			expect(callbacks.saveSettings).toHaveBeenCalledTimes(1);
		});

		it('does not save settings when the remote marker is enabled and local settings already match', async () => {
			settings.encryptionEnabled = true;
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getState().remoteMode).toBe('encrypted');
			expect(callbacks.saveSettings).not.toHaveBeenCalled();
		});

		it('maps a transitioning marker state to transitioning remote mode', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('transitioning'));

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getState().remoteMode).toBe('transitioning');
			expect(callbacks.saveSettings).not.toHaveBeenCalled();
		});

		it('falls back to plaintext mode when marker metadata cannot be loaded', async () => {
			settings.encryptionEnabled = true;
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(null);

			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.getState().remoteMode).toBe('plaintext');
			expect(settings.encryptionEnabled).toBe(true);
			expect(callbacks.saveSettings).not.toHaveBeenCalled();
		});

		it('keeps the current state and does not throw on marker read errors', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			currentMarker().exists.mockRejectedValue(new Error('network down'));

			await expect(coordinator.refreshRemoteMode(callbacks.saveSettings)).resolves.toBeUndefined();
			expect(coordinator.getState().remoteMode).toBe('encrypted');
		});
	});

	/** Verifies passphrase unlock behavior for already-encrypted vaults. */
	describe('unlock(passphrase)', () => {
		it('returns true and propagates the key when the passphrase is correct', async () => {
			currentMarker().verify.mockResolvedValue(derivedKey);

			await expect(coordinator.unlock('correct-passphrase')).resolves.toBe(true);

			expect(mockPayloadCodec.updateKey).toHaveBeenCalledWith(derivedKey);
			expect(mockSnapshotCreator.setEncryptionKey).toHaveBeenCalledWith(derivedKey);
			expect(mockBackupDownloader.setEncryptionKey).toHaveBeenCalledWith(derivedKey);
			expect(coordinator.getState().hasKey).toBe(true);
		});

		it('returns false and leaves the key unset when the passphrase is wrong', async () => {
			currentMarker().verify.mockResolvedValue(null);

			await expect(coordinator.unlock('wrong-passphrase')).resolves.toBe(false);

			expect(mockPayloadCodec.updateKey).not.toHaveBeenCalled();
			expect(mockSnapshotCreator.setEncryptionKey).not.toHaveBeenCalled();
			expect(mockBackupDownloader.setEncryptionKey).not.toHaveBeenCalled();
			expect(coordinator.getState().hasKey).toBe(false);
		});
	});

	/** Exercises the plaintext-to-encrypted migration path driven from local vault files. */
	describe('enableEncryption(passphrase, callbacks)', () => {
		it('returns a validation error when the passphrase is too short', async () => {
			mockedValidatePassphrase.mockReturnValue({
				valid: false,
				strength: 'weak',
				message: 'Passphrase too short',
			});

			await expect(coordinator.enableEncryption('short', callbacks)).resolves.toEqual({
				success: false,
				error: 'Passphrase too short',
			});

			expect(callbacks.pauseSchedulers).not.toHaveBeenCalled();
			expect(currentLease().acquire).not.toHaveBeenCalled();
			expect(currentMarker().create).not.toHaveBeenCalled();
		});

		it('returns a busy error when another enable migration is already running', async () => {
			const acquireDeferred = createDeferred<void>();
			currentLease().acquire.mockReturnValue(acquireDeferred.promise);
			currentMarker().create.mockResolvedValue(derivedKey);

			const pendingEnable = coordinator.enableEncryption('correct-passphrase', callbacks);
			const secondEnable = await coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(secondEnable).toEqual({
				success: false,
				error: 'Migration already in progress',
			});

			acquireDeferred.resolve(undefined);
			await pendingEnable;
		});

		it('creates the marker, encrypts eligible local files, updates metadata, and flips to enabled on success', async () => {
			const fileA = new MockVaultFile('notes/a.md', 1111);
			const fileB = new MockVaultFile('images/b.png', 2222, 2);
			(mockApp.vault.getFiles as jest.Mock).mockReturnValue([fileA, fileB]);
			currentMarker().create.mockResolvedValue(derivedKey);
			mockedReadVaultFile
				.mockResolvedValueOnce('hello')
				.mockResolvedValueOnce(new Uint8Array([20, 21]));
			mockedHashContent
				.mockResolvedValueOnce('hash-a')
				.mockResolvedValueOnce('hash-b');
			mockedEncrypt
				.mockReturnValueOnce(new Uint8Array([255, 104, 101, 108, 108, 111]))
				.mockReturnValueOnce(new Uint8Array([255, 20, 21]));

			const result = await coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(result).toEqual({ success: true });
			expect(callbacks.pauseSchedulers).toHaveBeenCalledTimes(1);
			expect(callbacks.resumeSchedulers).toHaveBeenCalledTimes(1);
			expect(currentLease().acquire).toHaveBeenCalledWith(deviceId, 'migration');
			expect(currentLease().release).toHaveBeenCalledTimes(1);
			expect(currentMarker().create).toHaveBeenCalledWith('correct-passphrase', deviceId);
			expect(currentMarker().updateState).toHaveBeenCalledWith('enabled', deviceId);
			expect(mockPayloadCodec.updateKey).toHaveBeenCalledWith(derivedKey);
			expect(mockSnapshotCreator.setEncryptionKey).toHaveBeenCalledWith(derivedKey);
			expect(mockBackupDownloader.setEncryptionKey).toHaveBeenCalledWith(derivedKey);
			expect(settings.encryptionEnabled).toBe(true);
			expect(callbacks.saveSettings).toHaveBeenCalledTimes(1);
			expect(mockedReadVaultFile).toHaveBeenNthCalledWith(1, mockApp.vault, fileA);
			expect(mockedReadVaultFile).toHaveBeenNthCalledWith(2, mockApp.vault, fileB);
			expect(mockedEncrypt).toHaveBeenNthCalledWith(1, new TextEncoder().encode('hello'), derivedKey);
			expect(mockedEncrypt).toHaveBeenNthCalledWith(2, new Uint8Array([20, 21]), derivedKey);
			expect(mockedHashContent).toHaveBeenNthCalledWith(1, new TextEncoder().encode('hello'));
			expect(mockedHashContent).toHaveBeenNthCalledWith(2, new Uint8Array([20, 21]));
			expect(mockedEncodeMetadata).toHaveBeenNthCalledWith(1, {
				fingerprint: 'sha256:hash-a',
				clientMtime: 1111,
				deviceId,
				payloadFormat: 'xsalsa20poly1305-v1',
			});
			expect(mockedEncodeMetadata).toHaveBeenNthCalledWith(2, {
				fingerprint: 'sha256:hash-b',
				clientMtime: 2222,
				deviceId,
				payloadFormat: 'xsalsa20poly1305-v1',
			});
			expect(mockS3Provider.uploadFile).toHaveBeenNthCalledWith(1, 'vault/notes/a.md', new Uint8Array([255, 104, 101, 108, 108, 111]), {
				metadata: {
					fingerprint: 'sha256:hash-a',
					clientMtime: '1111',
					deviceId,
					payloadFormat: 'xsalsa20poly1305-v1',
				},
			});
			expect(mockS3Provider.uploadFile).toHaveBeenNthCalledWith(2, 'vault/images/b.png', new Uint8Array([255, 20, 21]), {
				metadata: {
					fingerprint: 'sha256:hash-b',
					clientMtime: '2222',
					deviceId,
					payloadFormat: 'xsalsa20poly1305-v1',
				},
			});
			expect(coordinator.getState()).toEqual({
				remoteMode: 'encrypted',
				hasKey: true,
				isBusy: false,
			});
		});

		it('skips excluded local files during enable migration', async () => {
			const skippedFile = new MockVaultFile('notes/skip.md', 3333);
			const keptFile = new MockVaultFile('notes/keep.md', 4444);
			(mockApp.vault.getFiles as jest.Mock).mockReturnValue([skippedFile, keptFile]);
			currentMarker().create.mockResolvedValue(derivedKey);
			mockedMatchesAnyGlob.mockImplementation((path) => path === 'notes/skip.md');
			mockedReadVaultFile.mockResolvedValueOnce('keep me');

			const result = await coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(result).toEqual({ success: true });
			expect(mockedReadVaultFile).toHaveBeenCalledTimes(1);
			expect(mockedReadVaultFile).toHaveBeenCalledWith(mockApp.vault, keptFile);
			expect(mockPathCodec.localToRemote).toHaveBeenCalledTimes(1);
			expect(mockPathCodec.localToRemote).toHaveBeenCalledWith('notes/keep.md');
			expect(mockS3Provider.uploadFile).toHaveBeenCalledTimes(1);
		});

		it('renews the sync lease every 50 migrated files', async () => {
			const files = Array.from({ length: 50 }, (_, index) => new MockVaultFile(`notes/${index}.md`, 1000 + index));
			(mockApp.vault.getFiles as jest.Mock).mockReturnValue(files);
			currentMarker().create.mockResolvedValue(derivedKey);
			mockedReadVaultFile.mockImplementation(async (_vault, file) => file.path);

			const result = await coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(result).toEqual({ success: true });
			expect(currentLease().renew).toHaveBeenCalledTimes(1);
		});

		it('returns an aggregated migration error when an individual file upload fails', async () => {
			const goodFile = new MockVaultFile('notes/good.md', 5555);
			const badFile = new MockVaultFile('notes/bad.md', 6666);
			(mockApp.vault.getFiles as jest.Mock).mockReturnValue([goodFile, badFile]);
			currentMarker().create.mockResolvedValue(derivedKey);
			mockedReadVaultFile
				.mockResolvedValueOnce('good')
				.mockResolvedValueOnce('bad');
			(mockS3Provider.uploadFile as jest.Mock)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('upload failed'));

			const result = await coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(result).toEqual({
				success: false,
				error: 'Migration incomplete: 1 file(s) failed. Marker left in transitioning state for retry.',
			});
			expect(currentMarker().updateState).not.toHaveBeenCalled();
			expect(callbacks.resumeSchedulers).toHaveBeenCalledTimes(1);
			expect(coordinator.getState()).toEqual({
				remoteMode: 'transitioning',
				hasKey: true,
				isBusy: false,
			});
		});

		it('returns the thrown error and resets busy state when setup fails before marker creation', async () => {
			currentLease().acquire.mockRejectedValue(new Error('lock failed'));

			const result = await coordinator.enableEncryption('correct-passphrase', callbacks);

			expect(result).toEqual({ success: false, error: 'lock failed' });
			expect(currentMarker().create).not.toHaveBeenCalled();
			expect(mockPayloadCodec.updateKey).not.toHaveBeenCalled();
			expect(currentLease().release).toHaveBeenCalledTimes(1);
			expect(callbacks.pauseSchedulers).toHaveBeenCalledTimes(1);
			expect(callbacks.resumeSchedulers).toHaveBeenCalledTimes(1);
			expect(coordinator.getState()).toEqual({
				remoteMode: 'plaintext',
				hasKey: false,
				isBusy: false,
			});
		});
	});

	/** Exercises the encrypted-to-plaintext migration path driven from local vault files. */
	describe('disableEncryption(callbacks)', () => {
		it('returns an error when no encryption key is loaded', async () => {
			await expect(coordinator.disableEncryption(callbacks)).resolves.toEqual({
				success: false,
				error: 'No encryption key loaded — unlock first',
			});

			expect(callbacks.pauseSchedulers).not.toHaveBeenCalled();
		});

		it('returns a busy error when another disable migration is already running', async () => {
			await setEncryptedRemoteAndUnlock();
			const acquireDeferred = createDeferred<void>();
			currentLease().acquire.mockReturnValue(acquireDeferred.promise);

			const pendingDisable = coordinator.disableEncryption(callbacks);
			const secondDisable = await coordinator.disableEncryption(callbacks);

			expect(secondDisable).toEqual({
				success: false,
				error: 'Migration already in progress',
			});

			acquireDeferred.resolve(undefined);
			await pendingDisable;
		});

		it('marks transitioning, uploads plaintext files, deletes the marker, clears the key, and updates settings on success', async () => {
			await setEncryptedRemoteAndUnlock();
			const file = new MockVaultFile('notes/encrypted.md', 7777);
			(mockApp.vault.getFiles as jest.Mock).mockReturnValue([file]);
			mockedReadVaultFile.mockResolvedValueOnce('plaintext content');
			mockedHashContent.mockResolvedValueOnce('plain-hash');

			const result = await coordinator.disableEncryption(callbacks);

			expect(result).toEqual({ success: true });
			expect(callbacks.pauseSchedulers).toHaveBeenCalledTimes(1);
			expect(callbacks.resumeSchedulers).toHaveBeenCalledTimes(1);
			expect(currentLease().acquire).toHaveBeenCalledWith(deviceId, 'migration');
			expect(currentMarker().updateState).toHaveBeenCalledWith(
				'transitioning',
				deviceId,
				expect.objectContaining({
					fromMode: 'xsalsa20poly1305-v1',
					targetMode: 'plaintext-v1',
					migrationId: expect.any(String),
				}),
			);
			expect(mockedReadVaultFile).toHaveBeenCalledWith(mockApp.vault, file);
			expect(mockedEncrypt).not.toHaveBeenCalled();
			expect(mockedEncodeMetadata).toHaveBeenCalledWith({
				fingerprint: 'sha256:plain-hash',
				clientMtime: 7777,
				deviceId,
				payloadFormat: 'plaintext-v1',
			});
			expect(mockS3Provider.uploadFile).toHaveBeenCalledWith('vault/notes/encrypted.md', new TextEncoder().encode('plaintext content'), {
				metadata: {
					fingerprint: 'sha256:plain-hash',
					clientMtime: '7777',
					deviceId,
					payloadFormat: 'plaintext-v1',
				},
			});
			expect(currentMarker().delete).toHaveBeenCalledTimes(1);
			expect(mockPayloadCodec.updateKey).toHaveBeenLastCalledWith(null);
			expect(mockSnapshotCreator.setEncryptionKey).toHaveBeenLastCalledWith(null);
			expect(mockBackupDownloader.setEncryptionKey).toHaveBeenLastCalledWith(null);
			expect(settings.encryptionEnabled).toBe(false);
			expect(coordinator.getState()).toEqual({
				remoteMode: 'plaintext',
				hasKey: false,
				isBusy: false,
			});
		});

		it('skips excluded local files during disable migration', async () => {
			await setEncryptedRemoteAndUnlock();
			const skippedFile = new MockVaultFile('notes/skip.md', 8888);
			const keptFile = new MockVaultFile('notes/keep.md', 9999);
			(mockApp.vault.getFiles as jest.Mock).mockReturnValue([skippedFile, keptFile]);
			mockedMatchesAnyGlob.mockImplementation((path) => path === 'notes/skip.md');
			mockedReadVaultFile.mockResolvedValueOnce('keep');

			const result = await coordinator.disableEncryption(callbacks);

			expect(result).toEqual({ success: true });
			expect(mockedReadVaultFile).toHaveBeenCalledTimes(1);
			expect(mockedReadVaultFile).toHaveBeenCalledWith(mockApp.vault, keptFile);
			expect(mockPathCodec.localToRemote).toHaveBeenCalledTimes(1);
			expect(mockPathCodec.localToRemote).toHaveBeenCalledWith('notes/keep.md');
		});

		it('returns a migration error and resets busy state when a file fails during disable migration', async () => {
			await setEncryptedRemoteAndUnlock();
			const file = new MockVaultFile('notes/bad.md', 8888);
			(mockApp.vault.getFiles as jest.Mock).mockReturnValue([file]);
			mockedReadVaultFile.mockResolvedValueOnce('bad');
			(mockS3Provider.uploadFile as jest.Mock).mockRejectedValue(new Error('upload failed'));

			const result = await coordinator.disableEncryption(callbacks);

			expect(result).toEqual({
				success: false,
				error: 'Migration incomplete: 1 file(s) failed. Marker left in transitioning state for retry.',
			});
			expect(currentMarker().delete).not.toHaveBeenCalled();
			expect(coordinator.getState()).toEqual({
				remoteMode: 'transitioning',
				hasKey: true,
				isBusy: false,
			});
		});

		it('returns the thrown error and leaves the key loaded when setup fails before marker update', async () => {
			await setEncryptedRemoteAndUnlock();
			currentLease().acquire.mockRejectedValue(new Error('lock failed'));

			const result = await coordinator.disableEncryption(callbacks);

			expect(result).toEqual({ success: false, error: 'lock failed' });
			expect(currentMarker().updateState).not.toHaveBeenCalled();
			expect(currentMarker().delete).not.toHaveBeenCalled();
			expect(currentLease().release).toHaveBeenCalledTimes(1);
			expect(coordinator.getState()).toEqual({
				remoteMode: 'encrypted',
				hasKey: true,
				isBusy: false,
			});
		});
	});

	/** Ensures dependencies are recreated when the sync prefix changes. */
	describe('updateSettings(settings)', () => {
		it('recreates the VaultMarker with the new sync prefix', () => {
			expect(mockedVaultMarker).toHaveBeenCalledTimes(1);

			const updatedSettings = createSettings({ syncPrefix: 'new-prefix' });
			coordinator.updateSettings(updatedSettings);

			expect(mockedVaultMarker).toHaveBeenCalledTimes(2);
			expect(mockedVaultMarker).toHaveBeenLastCalledWith(mockS3Provider, 'new-prefix');
		});

		it('recreates the SyncLease and exposes the latest instance', () => {
			const initialLease = coordinator.getSyncLease();

			coordinator.updateSettings(createSettings({ syncPrefix: 'new-prefix' }));

			expect(mockedSyncLease).toHaveBeenCalledTimes(2);
			expect(mockedSyncLease).toHaveBeenLastCalledWith(mockS3Provider, 'new-prefix');
			expect(coordinator.getSyncLease()).not.toBe(initialLease);
		});
	});

	/** Covers remote-state propagation across devices sharing the same bucket. */
	describe('multi-device scenarios', () => {
		it('blocks sync when another device is transitioning encryption state', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('transitioning'));
			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
			expect(coordinator.getBlockReason()).toContain('transition in progress');
			expect(coordinator.getState().remoteMode).toBe('transitioning');
		});

		it('blocks sync when remote vault is encrypted but no passphrase was entered', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
			expect(coordinator.getBlockReason()).toContain('enter passphrase');
			expect(coordinator.getState()).toEqual({
				remoteMode: 'encrypted',
				hasKey: false,
				isBusy: false,
			});
		});

		it('unblocks sync after the correct passphrase is entered on a second device', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);

			currentMarker().verify.mockResolvedValue(derivedKey);
			const unlocked = await coordinator.unlock('correct-passphrase');

			expect(unlocked).toBe(true);
			expect(coordinator.shouldBlock()).toBe(false);
			expect(coordinator.getState()).toEqual({
				remoteMode: 'encrypted',
				hasKey: true,
				isBusy: false,
			});
		});

		it('auto-aligns the local encryptionEnabled setting when a remote marker is detected', async () => {
			expect(settings.encryptionEnabled).toBe(false);

			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
			await coordinator.refreshRemoteMode(callbacks.saveSettings);

			expect(settings.encryptionEnabled).toBe(true);
			expect(callbacks.saveSettings).toHaveBeenCalled();
		});
	});
});
