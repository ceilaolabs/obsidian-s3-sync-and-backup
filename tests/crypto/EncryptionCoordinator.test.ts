/**
 * @jest-environment node
 */

import { App, TFile } from 'obsidian';
import { EncryptionCoordinator } from '../../src/crypto/EncryptionCoordinator';
import { VaultMarker } from '../../src/crypto/VaultMarker';
import { validatePassphrase } from '../../src/crypto/KeyDerivation';
import { decrypt, encrypt, isLikelyEncrypted } from '../../src/crypto/FileEncryptor';
import { hashContent } from '../../src/crypto/Hasher';
import { encodeMetadata } from '../../src/sync/SyncObjectMetadata';
import { matchesAnyGlob } from '../../src/utils/paths';
import {
	DEFAULT_SETTINGS,
	EncryptionMarkerState,
	S3ObjectInfo,
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

type MarkerMetadata = Omit<VaultEncryptionMarker, 'verificationToken'>;

type MockVaultMarkerInstance = {
	exists: jest.Mock<Promise<boolean>, []>;
	getMetadata: jest.Mock<Promise<MarkerMetadata | null>, []>;
	create: jest.Mock<Promise<Uint8Array>, [string, string]>;
	verify: jest.Mock<Promise<Uint8Array | null>, [string]>;
	delete: jest.Mock<Promise<void>, []>;
	updateState: jest.Mock<Promise<void>, [EncryptionMarkerState, string]>;
};

class MockVaultFile extends TFile {
	constructor(path: string, mtime = 1234) {
		super();
		this.path = path;
		this.name = path.split('/').pop() ?? path;
		this.basename = this.name.replace(/\.[^.]+$/, '');
		this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
		this.stat = {
			ctime: mtime,
			mtime,
			size: 1,
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
		version: 2,
		salt: 'salt',
		state,
		createdAt: '2024-01-01T00:00:00.000Z',
		createdBy: 'device-1',
		updatedAt: '2024-01-01T00:00:00.000Z',
		updatedBy: 'device-1',
	};
}

describe('EncryptionCoordinator', () => {
	const deviceId = 'device-123';
	const derivedKey = new Uint8Array([1, 2, 3, 4]);
	const encryptedPayload = new Uint8Array([255, 10, 11]);
	const plaintextPayload = new Uint8Array([10, 11]);

	const mockS3Provider = {
		listObjects: jest.fn(),
		downloadFile: jest.fn(),
		uploadFile: jest.fn(),
	} as unknown as S3Provider;

	const mockPayloadCodec = {
		updateKey: jest.fn(),
	} as unknown as SyncPayloadCodec;

	const mockPathCodec = {
		remoteToLocal: jest.fn(),
	} as unknown as SyncPathCodec;

	const mockSnapshotCreator = {
		setEncryptionKey: jest.fn(),
	} as unknown as SnapshotCreator;

	const mockBackupDownloader = {
		setEncryptionKey: jest.fn(),
	} as unknown as BackupDownloader;

	const mockApp = {
		vault: {
			getAbstractFileByPath: jest.fn(),
		},
	} as unknown as App;

	const saveSettings = jest.fn<Promise<void>, []>();
	const mockedVaultMarker = VaultMarker as jest.MockedClass<typeof VaultMarker>;
	const mockedValidatePassphrase = validatePassphrase as jest.MockedFunction<typeof validatePassphrase>;
	const mockedEncrypt = encrypt as jest.MockedFunction<typeof encrypt>;
	const mockedDecrypt = decrypt as jest.MockedFunction<typeof decrypt>;
	const mockedIsLikelyEncrypted = isLikelyEncrypted as jest.MockedFunction<typeof isLikelyEncrypted>;
	const mockedHashContent = hashContent as jest.MockedFunction<typeof hashContent>;
	const mockedEncodeMetadata = encodeMetadata as jest.MockedFunction<typeof encodeMetadata>;
	const mockedMatchesAnyGlob = matchesAnyGlob as jest.MockedFunction<typeof matchesAnyGlob>;

	let settings: S3SyncBackupSettings;
	let coordinator: EncryptionCoordinator;
	let markerInstances: MockVaultMarkerInstance[];
	let consoleErrorSpy: jest.SpyInstance;
	let consoleDebugSpy: jest.SpyInstance;

	function createMarkerInstance(): MockVaultMarkerInstance {
		return {
			exists: jest.fn<Promise<boolean>, []>(),
			getMetadata: jest.fn<Promise<MarkerMetadata | null>, []>(),
			create: jest.fn<Promise<Uint8Array>, [string, string]>(),
			verify: jest.fn<Promise<Uint8Array | null>, [string]>(),
			delete: jest.fn<Promise<void>, []>(),
			updateState: jest.fn<Promise<void>, [EncryptionMarkerState, string]>(),
		};
	}

	function currentMarker(): MockVaultMarkerInstance {
		return markerInstances[markerInstances.length - 1];
	}

	function setListObjects(objects: S3ObjectInfo[]): void {
		(mockS3Provider.listObjects as jest.MockedFunction<
			(prefix: string, recursive?: boolean) => Promise<S3ObjectInfo[]>
		>).mockResolvedValue(objects);
	}

	async function setEncryptedRemoteAndUnlock(): Promise<void> {
		currentMarker().exists.mockResolvedValue(true);
		currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
		currentMarker().verify.mockResolvedValue(derivedKey);
		await coordinator.refreshRemoteMode(saveSettings);
		await coordinator.unlock('correct-passphrase');
	}

	beforeEach(() => {
		jest.clearAllMocks();

		settings = createSettings();
		markerInstances = [];

		mockedVaultMarker.mockImplementation(() => {
			const instance = createMarkerInstance();
			markerInstances.push(instance);
			return instance as unknown as VaultMarker;
		});

		mockedValidatePassphrase.mockReturnValue({ valid: true, strength: 'strong', message: 'OK' });
		mockedEncrypt.mockImplementation((content: string | Uint8Array) => {
			const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
			return new Uint8Array([255, ...bytes]);
		});
		mockedDecrypt.mockImplementation((content: Uint8Array) => content.slice(1));
		mockedHashContent.mockResolvedValue('deadbeef');
		mockedEncodeMetadata.mockImplementation((metadata) => ({
			fingerprint: metadata.fingerprint,
			clientMtime: String(metadata.clientMtime),
			deviceId: metadata.deviceId,
		}));
		mockedMatchesAnyGlob.mockReturnValue(false);
		mockedIsLikelyEncrypted.mockReturnValue(false);

		saveSettings.mockResolvedValue(undefined);
		(mockS3Provider.listObjects as jest.Mock).mockResolvedValue([]);
		(mockS3Provider.downloadFile as jest.Mock).mockResolvedValue(plaintextPayload);
		(mockS3Provider.uploadFile as jest.Mock).mockResolvedValue(undefined);
		(mockPathCodec.remoteToLocal as jest.Mock).mockImplementation((key: string) => key.replace('vault/', ''));
		(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new MockVaultFile('notes/file.md', 4321));

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
		consoleErrorSpy.mockRestore();
		consoleDebugSpy.mockRestore();
	});

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

			await coordinator.refreshRemoteMode(saveSettings);

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
			const listObjectsDeferred = createDeferred<S3ObjectInfo[]>();
			currentMarker().create.mockResolvedValue(derivedKey);
			(mockS3Provider.listObjects as jest.Mock).mockReturnValue(listObjectsDeferred.promise);

			const pendingEnable = coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(coordinator.getState()).toEqual({
				remoteMode: 'plaintext',
				hasKey: false,
				isBusy: true,
			});

			listObjectsDeferred.resolve([]);
			await pendingEnable;
		});
	});

	describe('shouldBlock()', () => {
		it('returns true while a local enable migration is running', async () => {
			const listObjectsDeferred = createDeferred<S3ObjectInfo[]>();
			currentMarker().create.mockResolvedValue(derivedKey);
			(mockS3Provider.listObjects as jest.Mock).mockReturnValue(listObjectsDeferred.promise);

			const pendingEnable = coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);

			listObjectsDeferred.resolve([]);
			await pendingEnable;
		});

		it('returns true when remote mode is transitioning from enabling', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabling'));

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
		});

		it('returns true when remote mode is transitioning from disabling', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('disabling'));

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
		});

		it('returns true when the vault is encrypted remotely and no key is loaded', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(saveSettings);

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

	describe('getBlockReason()', () => {
		it('returns the busy reason while a local migration is running', async () => {
			const listObjectsDeferred = createDeferred<S3ObjectInfo[]>();
			currentMarker().create.mockResolvedValue(derivedKey);
			(mockS3Provider.listObjects as jest.Mock).mockReturnValue(listObjectsDeferred.promise);

			const pendingEnable = coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(coordinator.getBlockReason()).toBe('Encryption migration in progress');

			listObjectsDeferred.resolve([]);
			await pendingEnable;
		});

		it('returns the transitioning reason when another device is changing encryption state', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabling'));

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getBlockReason()).toBe('Encryption state transition in progress on another device');
		});

		it('returns the unlock reason when the vault is encrypted and locked', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getBlockReason()).toBe('Vault is encrypted — enter passphrase in settings to unlock');
		});

		it('returns null when operations are not blocked', async () => {
			await setEncryptedRemoteAndUnlock();

			expect(coordinator.getBlockReason()).toBeNull();
		});
	});

	describe('refreshRemoteMode(saveSettings)', () => {
		it('sets plaintext mode and disables the local setting when no marker exists', async () => {
			settings.encryptionEnabled = true;
			currentMarker().exists.mockResolvedValue(false);

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getState().remoteMode).toBe('plaintext');
			expect(settings.encryptionEnabled).toBe(false);
			expect(saveSettings).toHaveBeenCalledTimes(1);
		});

		it('does not save settings when no marker exists and local encryption is already disabled', async () => {
			currentMarker().exists.mockResolvedValue(false);

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getState().remoteMode).toBe('plaintext');
			expect(saveSettings).not.toHaveBeenCalled();
		});

		it('sets encrypted mode and enables the local setting when the remote marker is enabled', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getState().remoteMode).toBe('encrypted');
			expect(settings.encryptionEnabled).toBe(true);
			expect(saveSettings).toHaveBeenCalledTimes(1);
		});

		it('does not save settings when the remote marker is enabled and local settings already match', async () => {
			settings.encryptionEnabled = true;
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getState().remoteMode).toBe('encrypted');
			expect(saveSettings).not.toHaveBeenCalled();
		});

		it('sets transitioning mode when the remote marker state is enabling', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabling'));

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getState().remoteMode).toBe('transitioning');
		});

		it('sets transitioning mode when the remote marker state is disabling', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('disabling'));

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getState().remoteMode).toBe('transitioning');
		});

		it('falls back to plaintext mode when marker metadata cannot be loaded', async () => {
			settings.encryptionEnabled = true;
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(null);

			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.getState().remoteMode).toBe('plaintext');
			expect(settings.encryptionEnabled).toBe(true);
			expect(saveSettings).not.toHaveBeenCalled();
		});

		it('keeps the current state and does not throw on network errors', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
			await coordinator.refreshRemoteMode(saveSettings);

			currentMarker().exists.mockRejectedValue(new Error('network down'));

			await expect(coordinator.refreshRemoteMode(saveSettings)).resolves.toBeUndefined();
			expect(coordinator.getState().remoteMode).toBe('encrypted');
		});
	});

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

	describe('enableEncryption(passphrase, saveSettings)', () => {
		it('returns a validation error when the passphrase is too short', async () => {
			mockedValidatePassphrase.mockReturnValue({
				valid: false,
				strength: 'weak',
				message: 'Passphrase too short',
			});

			await expect(coordinator.enableEncryption('short', saveSettings)).resolves.toEqual({
				success: false,
				error: 'Passphrase too short',
			});

			expect(currentMarker().create).not.toHaveBeenCalled();
		});

		it('returns a busy error when another enable migration is already running', async () => {
			const listObjectsDeferred = createDeferred<S3ObjectInfo[]>();
			currentMarker().create.mockResolvedValue(derivedKey);
			(mockS3Provider.listObjects as jest.Mock).mockReturnValue(listObjectsDeferred.promise);

			const pendingEnable = coordinator.enableEncryption('correct-passphrase', saveSettings);
			const secondEnable = await coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(secondEnable).toEqual({
				success: false,
				error: 'Migration already in progress',
			});

			listObjectsDeferred.resolve([]);
			await pendingEnable;
		});

		it('creates the marker, encrypts eligible files, updates metadata, and flips to enabled on success', async () => {
			currentMarker().create.mockResolvedValue(derivedKey);
			setListObjects([
				{ key: 'vault/notes/a.md', size: 1, lastModified: new Date() },
				{ key: 'vault/notes/b.md', size: 1, lastModified: new Date() },
			]);
			(mockS3Provider.downloadFile as jest.Mock)
				.mockResolvedValueOnce(new Uint8Array([10]))
				.mockResolvedValueOnce(new Uint8Array([20]));
			(mockPathCodec.remoteToLocal as jest.Mock)
				.mockReturnValueOnce('notes/a.md')
				.mockReturnValueOnce('notes/b.md');
			(mockApp.vault.getAbstractFileByPath as jest.Mock)
				.mockReturnValueOnce(new MockVaultFile('notes/a.md', 1111))
				.mockReturnValueOnce(new MockVaultFile('notes/b.md', 2222));

			const result = await coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(result).toEqual({ success: true });
			expect(currentMarker().create).toHaveBeenCalledWith('correct-passphrase', deviceId);
			expect(mockPayloadCodec.updateKey).toHaveBeenCalledWith(derivedKey);
			expect(mockSnapshotCreator.setEncryptionKey).toHaveBeenCalledWith(derivedKey);
			expect(mockBackupDownloader.setEncryptionKey).toHaveBeenCalledWith(derivedKey);
			expect(saveSettings).toHaveBeenCalledTimes(1);
			expect(currentMarker().updateState).toHaveBeenCalledWith('enabled', deviceId);
			expect(coordinator.getState()).toEqual({
				remoteMode: 'encrypted',
				hasKey: true,
				isBusy: false,
			});
			expect(mockedEncrypt).toHaveBeenNthCalledWith(1, new Uint8Array([10]), derivedKey);
			expect(mockedEncrypt).toHaveBeenNthCalledWith(2, new Uint8Array([20]), derivedKey);
			expect(mockedHashContent).toHaveBeenNthCalledWith(1, new Uint8Array([10]));
			expect(mockedHashContent).toHaveBeenNthCalledWith(2, new Uint8Array([20]));
			expect(mockedEncodeMetadata).toHaveBeenNthCalledWith(1, {
				fingerprint: 'sha256:deadbeef',
				clientMtime: 1111,
				deviceId,
			});
			expect(mockedEncodeMetadata).toHaveBeenNthCalledWith(2, {
				fingerprint: 'sha256:deadbeef',
				clientMtime: 2222,
				deviceId,
			});
			expect(mockS3Provider.uploadFile).toHaveBeenNthCalledWith(1, 'vault/notes/a.md', new Uint8Array([255, 10]), {
				metadata: {
					fingerprint: 'sha256:deadbeef',
					clientMtime: '1111',
					deviceId,
				},
			});
			expect(mockS3Provider.uploadFile).toHaveBeenNthCalledWith(2, 'vault/notes/b.md', new Uint8Array([255, 20]), {
				metadata: {
					fingerprint: 'sha256:deadbeef',
					clientMtime: '2222',
					deviceId,
				},
			});
		});

		it('skips internal sync files and excluded paths during enable migration', async () => {
			currentMarker().create.mockResolvedValue(derivedKey);
			setListObjects([
				{ key: 'vault/.obsidian-s3-sync/.vault.enc', size: 1, lastModified: new Date() },
				{ key: 'vault/notes/skip.md', size: 1, lastModified: new Date() },
				{ key: 'vault/notes/keep.md', size: 1, lastModified: new Date() },
			]);
			(mockPathCodec.remoteToLocal as jest.Mock)
				.mockReturnValueOnce('notes/skip.md')
				.mockReturnValueOnce('notes/keep.md');
			(mockedMatchesAnyGlob as jest.MockedFunction<typeof matchesAnyGlob>).mockImplementation(
				(path) => path === 'notes/skip.md',
			);
			(mockS3Provider.downloadFile as jest.Mock).mockResolvedValue(new Uint8Array([30]));
			(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new MockVaultFile('notes/keep.md', 3333));

			const result = await coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(result).toEqual({ success: true });
			expect(mockPathCodec.remoteToLocal).toHaveBeenCalledTimes(2);
			expect(mockS3Provider.downloadFile).toHaveBeenCalledTimes(1);
			expect(mockS3Provider.uploadFile).toHaveBeenCalledTimes(1);
			expect(mockS3Provider.uploadFile).toHaveBeenCalledWith('vault/notes/keep.md', new Uint8Array([255, 30]), {
				metadata: {
					fingerprint: 'sha256:deadbeef',
					clientMtime: '3333',
					deviceId,
				},
			});
		});

		it('skips objects whose remote keys cannot be mapped back to vault paths', async () => {
			currentMarker().create.mockResolvedValue(derivedKey);
			setListObjects([
				{ key: 'vault/notes/unmapped.md', size: 1, lastModified: new Date() },
				{ key: 'vault/notes/mapped.md', size: 1, lastModified: new Date() },
			]);
			(mockPathCodec.remoteToLocal as jest.Mock)
				.mockReturnValueOnce(null)
				.mockReturnValueOnce('notes/mapped.md');
			(mockS3Provider.downloadFile as jest.Mock).mockResolvedValue(new Uint8Array([40]));
			(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new MockVaultFile('notes/mapped.md', 4444));

			const result = await coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(result).toEqual({ success: true });
			expect(mockS3Provider.downloadFile).toHaveBeenCalledTimes(1);
			expect(mockS3Provider.uploadFile).toHaveBeenCalledTimes(1);
			expect(mockS3Provider.uploadFile).toHaveBeenCalledWith('vault/notes/mapped.md', new Uint8Array([255, 40]), {
				metadata: {
					fingerprint: 'sha256:deadbeef',
					clientMtime: '4444',
					deviceId,
				},
			});
		});

		it('uses the current time when the local vault path does not resolve to a file', async () => {
			currentMarker().create.mockResolvedValue(derivedKey);
			setListObjects([{ key: 'vault/notes/no-local.md', size: 1, lastModified: new Date() }]);
			(mockPathCodec.remoteToLocal as jest.Mock).mockReturnValue('notes/no-local.md');
			(mockS3Provider.downloadFile as jest.Mock).mockResolvedValue(new Uint8Array([50]));
			(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
			const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(987654321);

			const result = await coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(result).toEqual({ success: true });
			expect(mockedEncodeMetadata).toHaveBeenCalledWith({
				fingerprint: 'sha256:deadbeef',
				clientMtime: 987654321,
				deviceId,
			});

			dateNowSpy.mockRestore();
		});

		it('returns an aggregated migration error when an individual file upload fails', async () => {
			currentMarker().create.mockResolvedValue(derivedKey);
			setListObjects([
				{ key: 'vault/notes/good.md', size: 1, lastModified: new Date() },
				{ key: 'vault/notes/bad.md', size: 1, lastModified: new Date() },
			]);
			(mockPathCodec.remoteToLocal as jest.Mock)
				.mockReturnValueOnce('notes/good.md')
				.mockReturnValueOnce('notes/bad.md');
			(mockS3Provider.downloadFile as jest.Mock)
				.mockResolvedValueOnce(new Uint8Array([60]))
				.mockResolvedValueOnce(new Uint8Array([61]));
			(mockApp.vault.getAbstractFileByPath as jest.Mock)
				.mockReturnValueOnce(new MockVaultFile('notes/good.md', 5555))
				.mockReturnValueOnce(new MockVaultFile('notes/bad.md', 6666));
			(mockS3Provider.uploadFile as jest.Mock)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('upload failed'));

			const result = await coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(result).toEqual({
				success: false,
				error: 'Migration incomplete: 1 file(s) failed to migrate',
			});
			expect(currentMarker().updateState).not.toHaveBeenCalled();
			expect(coordinator.getState().isBusy).toBe(false);
		});

		it('returns the thrown error, resets busy state, and leaves the marker in enabling state when migration setup fails', async () => {
			currentMarker().create.mockResolvedValue(derivedKey);
			(mockS3Provider.listObjects as jest.Mock).mockRejectedValue(new Error('list failed'));

			const result = await coordinator.enableEncryption('correct-passphrase', saveSettings);

			expect(result).toEqual({ success: false, error: 'list failed' });
			expect(currentMarker().updateState).not.toHaveBeenCalled();
			expect(mockPayloadCodec.updateKey).toHaveBeenCalledWith(derivedKey);
			expect(coordinator.getState()).toEqual({
				remoteMode: 'plaintext',
				hasKey: true,
				isBusy: false,
			});
		});
	});

	describe('disableEncryption(saveSettings)', () => {
		it('returns an error when no encryption key is loaded', async () => {
			await expect(coordinator.disableEncryption(saveSettings)).resolves.toEqual({
				success: false,
				error: 'No encryption key loaded — unlock first',
			});
		});

		it('returns a busy error when another disable migration is already running', async () => {
			await setEncryptedRemoteAndUnlock();
			const updateDeferred = createDeferred<void>();
			currentMarker().updateState.mockReturnValue(updateDeferred.promise);

			const pendingDisable = coordinator.disableEncryption(saveSettings);
			const secondDisable = await coordinator.disableEncryption(saveSettings);

			expect(secondDisable).toEqual({
				success: false,
				error: 'Migration already in progress',
			});

			updateDeferred.resolve(undefined);
			await pendingDisable;
		});

		it('marks disabling, decrypts files, deletes the marker, clears the key, and updates settings on success', async () => {
			await setEncryptedRemoteAndUnlock();
			setListObjects([
				{ key: 'vault/notes/encrypted.md', size: 1, lastModified: new Date() },
			]);
			(mockPathCodec.remoteToLocal as jest.Mock).mockReturnValue('notes/encrypted.md');
			(mockS3Provider.downloadFile as jest.Mock).mockResolvedValue(encryptedPayload);
			mockedIsLikelyEncrypted.mockReturnValue(true);
			(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new MockVaultFile('notes/encrypted.md', 7777));

			const result = await coordinator.disableEncryption(saveSettings);

			expect(result).toEqual({ success: true });
			expect(currentMarker().updateState).toHaveBeenCalledWith('disabling', deviceId);
			expect(mockedDecrypt).toHaveBeenCalledWith(encryptedPayload, derivedKey);
			expect(mockedHashContent).toHaveBeenCalledWith(plaintextPayload);
			expect(mockS3Provider.uploadFile).toHaveBeenCalledWith('vault/notes/encrypted.md', plaintextPayload, {
				metadata: {
					fingerprint: 'sha256:deadbeef',
					clientMtime: '7777',
					deviceId,
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

		it('returns a migration error and resets busy state when a file fails during disable migration', async () => {
			await setEncryptedRemoteAndUnlock();
			setListObjects([{ key: 'vault/notes/bad.md', size: 1, lastModified: new Date() }]);
			(mockPathCodec.remoteToLocal as jest.Mock).mockReturnValue('notes/bad.md');
			(mockS3Provider.downloadFile as jest.Mock).mockResolvedValue(encryptedPayload);
			mockedIsLikelyEncrypted.mockReturnValue(true);
			(mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(new MockVaultFile('notes/bad.md', 8888));
			(mockS3Provider.uploadFile as jest.Mock).mockRejectedValue(new Error('decrypt upload failed'));

			const result = await coordinator.disableEncryption(saveSettings);

			expect(result).toEqual({
				success: false,
				error: 'Migration incomplete: 1 file(s) failed to migrate',
			});
			expect(currentMarker().delete).not.toHaveBeenCalled();
			expect(coordinator.getState()).toEqual({
				remoteMode: 'transitioning',
				hasKey: true,
				isBusy: false,
			});
		});
	});

	describe('updateSettings(settings)', () => {
		it('recreates the VaultMarker with the new sync prefix', () => {
			expect(mockedVaultMarker).toHaveBeenCalledTimes(1);

			const updatedSettings = createSettings({ syncPrefix: 'new-prefix' });
			coordinator.updateSettings(updatedSettings);

			expect(mockedVaultMarker).toHaveBeenCalledTimes(2);
			expect(mockedVaultMarker).toHaveBeenLastCalledWith(mockS3Provider, 'new-prefix');
		});
	});

	/** Multi-device sync scenarios for encryption state propagation. */
	describe('multi-device scenarios', () => {
		it('blocks sync when another device is enabling encryption (transitioning state)', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabling'));
			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
			expect(coordinator.getBlockReason()).toContain('transition in progress');
			expect(coordinator.getState().remoteMode).toBe('transitioning');
		});

		it('blocks sync when remote vault is encrypted but no passphrase entered', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
			expect(coordinator.getBlockReason()).toContain('enter passphrase');
			expect(coordinator.getState()).toEqual({
				remoteMode: 'encrypted',
				hasKey: false,
				isBusy: false,
			});
		});

		it('unblocks sync after correct passphrase is entered on second device', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
			await coordinator.refreshRemoteMode(saveSettings);

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

		it('blocks sync when another device is disabling encryption', async () => {
			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('disabling'));
			await coordinator.refreshRemoteMode(saveSettings);

			expect(coordinator.shouldBlock()).toBe(true);
			expect(coordinator.getBlockReason()).toContain('transition in progress');
			expect(coordinator.getState().remoteMode).toBe('transitioning');
		});

		it('auto-aligns local encryptionEnabled setting when remote marker is detected', async () => {
			expect(settings.encryptionEnabled).toBe(false);

			currentMarker().exists.mockResolvedValue(true);
			currentMarker().getMetadata.mockResolvedValue(createMarkerMetadata('enabled'));
			await coordinator.refreshRemoteMode(saveSettings);

			expect(settings.encryptionEnabled).toBe(true);
			expect(saveSettings).toHaveBeenCalled();
		});
	});
});
