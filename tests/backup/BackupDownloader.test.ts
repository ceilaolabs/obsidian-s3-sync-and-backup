/**
 * Unit tests for BackupDownloader.
 *
 * These tests validate manifest loading, single-file downloads, whole-backup
 * downloads, ZIP creation, browser download triggering, and runtime updates.
 */

jest.mock('obsidian');

jest.mock('../../src/storage/S3Provider', () => ({
	S3Provider: jest.fn(),
}));

jest.mock('../../src/crypto/FileEncryptor', () => ({
	decrypt: jest.fn(),
}));

jest.mock('../../src/utils/paths', () => ({
	addPrefix: jest.fn((path: string, prefix: string) => prefix ? `${prefix}/${path}` : path),
	normalizePrefix: jest.fn((prefix: string) => prefix.replace(/^\/+|\/+$/g, '')),
	removePrefix: jest.fn((path: string, prefix: string) => {
		if (!prefix) return path;
		if (path === prefix) return '';
		if (path.startsWith(`${prefix}/`)) {
			return path.slice(prefix.length + 1);
		}

		return null;
	}),
}));

type MockZipInstance = {
	file: jest.Mock<MockZipInstance, [string, string | Uint8Array]>;
	generateAsync: jest.Mock<Promise<Blob>, [{ type: 'blob' }]>;
};

const mockZipInstances: MockZipInstance[] = [];

jest.mock('jszip', () => {
	const JSZip = jest.fn().mockImplementation(() => {
		const instance: MockZipInstance = {
			file: jest.fn(),
			generateAsync: jest.fn(),
		};
		instance.file.mockReturnValue(instance);
		instance.generateAsync.mockResolvedValue(new Blob(['zip-bytes'], { type: 'application/zip' }));
		mockZipInstances.push(instance);
		return instance;
	});

	return {
		__esModule: true,
		default: JSZip,
	};
});

import JSZip from 'jszip';
import { decrypt } from '../../src/crypto/FileEncryptor';
import { BackupDownloader } from '../../src/backup/BackupDownloader';
import { S3Provider } from '../../src/storage/S3Provider';
import {
	BackupManifest,
	DEFAULT_SETTINGS,
	S3ObjectInfo,
	S3SyncBackupSettings,
} from '../../src/types';
import { addPrefix, normalizePrefix } from '../../src/utils/paths';

interface MockS3Provider {
	downloadFileAsText: jest.Mock<Promise<string>, [string]>;
	downloadFile: jest.Mock<Promise<Uint8Array>, [string]>;
	listObjects: jest.Mock<Promise<S3ObjectInfo[]>, [string, boolean?]>;
}

const mockedDecrypt = jest.mocked(decrypt);
const mockedAddPrefix = jest.mocked(addPrefix);
const mockedNormalizePrefix = jest.mocked(normalizePrefix);
const MockedJSZip = jest.mocked(JSZip);

function createTestSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		...DEFAULT_SETTINGS,
		...overrides,
	};
}

function createMockS3Provider(): MockS3Provider {
	return {
		downloadFileAsText: jest.fn(),
		downloadFile: jest.fn(),
		listObjects: jest.fn(),
	};
}

function createManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
	return {
		version: 1,
		timestamp: '2026-04-16T00:00:00.000Z',
		deviceId: 'device-1',
		deviceName: 'Primary Device',
		fileCount: 2,
		totalSize: 42,
		encrypted: false,
		checksums: {
			'Notes/test.md': 'sha256:test',
		},
		...overrides,
	};
}

function createObject(key: string, size = 1): S3ObjectInfo {
	return {
		key,
		size,
		lastModified: new Date('2026-04-16T00:00:00.000Z'),
	};
}

/**
 * Tests the browser-side backup restore downloader orchestration.
 */
describe('BackupDownloader', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockZipInstances.length = 0;
	});

	/**
	 * Covers manifest fetching and parsing behavior.
	 */
	describe('getManifest', () => {
		it('parses the backup manifest JSON downloaded from S3', async () => {
			const s3Provider = createMockS3Provider();
			const manifest = createManifest({ encrypted: true, fileCount: 7 });
			s3Provider.downloadFileAsText.mockResolvedValue(JSON.stringify(manifest));
			const downloader = new BackupDownloader(
				s3Provider as unknown as S3Provider,
				createTestSettings({ backupPrefix: '/backups/' }),
			);

			const result = await downloader.getManifest('backup-2026-04-16T00-00-00');

			expect(result).toEqual(manifest);
			expect(mockedNormalizePrefix).toHaveBeenCalledWith('/backups/');
			expect(mockedAddPrefix).toHaveBeenCalledWith('backup-2026-04-16T00-00-00/.backup-manifest.json', 'backups');
			expect(s3Provider.downloadFileAsText).toHaveBeenCalledWith('backups/backup-2026-04-16T00-00-00/.backup-manifest.json');
		});
	});

	/**
	 * Covers single-file download and optional decryption behavior.
	 */
	describe('downloadFile', () => {
		it('returns decrypted bytes when the backup is encrypted and a key is loaded', async () => {
			const s3Provider = createMockS3Provider();
			const ciphertext = new Uint8Array([9, 9, 9]);
			const plaintext = new Uint8Array([1, 2, 3]);
			const encryptionKey = new Uint8Array([4, 5, 6]);
			s3Provider.downloadFile.mockResolvedValue(ciphertext);
			s3Provider.downloadFileAsText.mockResolvedValue(JSON.stringify(createManifest({ encrypted: true })));
			mockedDecrypt.mockReturnValue(plaintext);
			const downloader = new BackupDownloader(s3Provider as unknown as S3Provider, createTestSettings());
			downloader.setEncryptionKey(encryptionKey);

			const result = await downloader.downloadFile('backup-1', 'Notes/secret.md');

			expect(result).toEqual(plaintext);
			expect(s3Provider.downloadFile).toHaveBeenCalledWith('backups/backup-1/Notes/secret.md');
			expect(mockedDecrypt).toHaveBeenCalledWith(ciphertext, encryptionKey);
		});

		it('returns raw bytes when the backup manifest marks the file set as unencrypted', async () => {
			const s3Provider = createMockS3Provider();
			const rawBytes = new Uint8Array([1, 2, 3, 4]);
			s3Provider.downloadFile.mockResolvedValue(rawBytes);
			s3Provider.downloadFileAsText.mockResolvedValue(JSON.stringify(createManifest({ encrypted: false })));
			const downloader = new BackupDownloader(s3Provider as unknown as S3Provider, createTestSettings());

			const result = await downloader.downloadFile('backup-1', 'Notes/plain.md');

			expect(result).toEqual(rawBytes);
			expect(mockedDecrypt).not.toHaveBeenCalled();
		});

		it('returns raw ciphertext when the backup is encrypted but no key is available', async () => {
			const s3Provider = createMockS3Provider();
			const ciphertext = new Uint8Array([7, 8, 9]);
			s3Provider.downloadFile.mockResolvedValue(ciphertext);
			s3Provider.downloadFileAsText.mockResolvedValue(JSON.stringify(createManifest({ encrypted: true })));
			const downloader = new BackupDownloader(s3Provider as unknown as S3Provider, createTestSettings());

			const result = await downloader.downloadFile('backup-1', 'Notes/encrypted.md');

			expect(result).toEqual(ciphertext);
			expect(mockedDecrypt).not.toHaveBeenCalled();
		});
	});

	/**
	 * Covers bulk backup download behavior across S3 object listings.
	 */
	describe('downloadBackup', () => {
		it('downloads every listed file except the manifest and returns them by relative path', async () => {
			const s3Provider = createMockS3Provider();
			s3Provider.downloadFileAsText.mockResolvedValue(JSON.stringify(createManifest()));
			s3Provider.listObjects.mockResolvedValue([
				createObject('backups/backup-1/.backup-manifest.json'),
				createObject('backups/backup-1/Notes/first.md'),
				createObject('backups/backup-1/Attachments/image.png'),
			]);
			s3Provider.downloadFile
				.mockResolvedValueOnce(new Uint8Array([1]))
				.mockResolvedValueOnce(new Uint8Array([2, 3]));
			const downloader = new BackupDownloader(s3Provider as unknown as S3Provider, createTestSettings());

			const result = await downloader.downloadBackup('backup-1');

			expect(s3Provider.listObjects).toHaveBeenCalledWith('backups/backup-1', true);
			expect(s3Provider.downloadFile).toHaveBeenCalledTimes(2);
			expect(result).toEqual(new Map([
				['Notes/first.md', new Uint8Array([1])],
				['Attachments/image.png', new Uint8Array([2, 3])],
			]));
		});

		it('logs download errors and continues processing the remaining files', async () => {
			const s3Provider = createMockS3Provider();
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			s3Provider.downloadFileAsText.mockResolvedValue(JSON.stringify(createManifest()));
			s3Provider.listObjects.mockResolvedValue([
				createObject('backups/backup-1/Notes/good.md'),
				createObject('backups/backup-1/Notes/bad.md'),
				createObject('backups/backup-1/Notes/last.md'),
			]);
			s3Provider.downloadFile
				.mockResolvedValueOnce(new Uint8Array([1]))
				.mockRejectedValueOnce(new Error('network failed'))
				.mockResolvedValueOnce(new Uint8Array([3]));
			const downloader = new BackupDownloader(s3Provider as unknown as S3Provider, createTestSettings());

			const result = await downloader.downloadBackup('backup-1');

			expect(result).toEqual(new Map([
				['Notes/good.md', new Uint8Array([1])],
				['Notes/last.md', new Uint8Array([3])],
			]));
			expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to download Notes/bad.md:', expect.any(Error));
			consoleErrorSpy.mockRestore();
		});

		it('decrypts every downloaded file when the backup is encrypted and a key is loaded', async () => {
			const s3Provider = createMockS3Provider();
			const encryptionKey = new Uint8Array([5, 6, 7]);
			const firstCiphertext = new Uint8Array([9]);
			const secondCiphertext = new Uint8Array([8]);
			s3Provider.downloadFileAsText.mockResolvedValue(JSON.stringify(createManifest({ encrypted: true })));
			s3Provider.listObjects.mockResolvedValue([
				createObject('backups/backup-1/Notes/first.md'),
				createObject('backups/backup-1/Notes/second.md'),
			]);
			s3Provider.downloadFile
				.mockResolvedValueOnce(firstCiphertext)
				.mockResolvedValueOnce(secondCiphertext);
			mockedDecrypt
				.mockReturnValueOnce(new Uint8Array([1]))
				.mockReturnValueOnce(new Uint8Array([2]));
			const downloader = new BackupDownloader(s3Provider as unknown as S3Provider, createTestSettings());
			downloader.setEncryptionKey(encryptionKey);

			const result = await downloader.downloadBackup('backup-1');

			expect(mockedDecrypt).toHaveBeenNthCalledWith(1, firstCiphertext, encryptionKey);
			expect(mockedDecrypt).toHaveBeenNthCalledWith(2, secondCiphertext, encryptionKey);
			expect(result).toEqual(new Map([
				['Notes/first.md', new Uint8Array([1])],
				['Notes/second.md', new Uint8Array([2])],
			]));
		});
	});

	/**
	 * Covers ZIP archive assembly for downloaded backups.
	 */
	describe('createDownloadBlob', () => {
		it('packages downloaded files and the manifest into a ZIP blob', async () => {
			const s3Provider = createMockS3Provider();
			const manifest = createManifest({ encrypted: true });
			const downloader = new BackupDownloader(s3Provider as unknown as S3Provider, createTestSettings());
			jest.spyOn(downloader, 'downloadBackup').mockResolvedValue(new Map([
				['Notes/test.md', new Uint8Array([1, 2])],
				['Attachments/image.png', new Uint8Array([3, 4])],
			]));
			jest.spyOn(downloader, 'getManifest').mockResolvedValue(manifest);

			const blob = await downloader.createDownloadBlob('backup-1');
			const zipInstance = mockZipInstances[0];

			expect(MockedJSZip).toHaveBeenCalledTimes(1);
			expect(zipInstance).toBeDefined();
			expect(zipInstance?.file).toHaveBeenNthCalledWith(1, 'Notes/test.md', new Uint8Array([1, 2]));
			expect(zipInstance?.file).toHaveBeenNthCalledWith(2, 'Attachments/image.png', new Uint8Array([3, 4]));
			expect(zipInstance?.file).toHaveBeenNthCalledWith(3, '.backup-manifest.json', JSON.stringify(manifest, null, 2));
			expect(zipInstance?.generateAsync).toHaveBeenCalledWith({ type: 'blob' });
			expect(blob).toBeInstanceOf(Blob);
			expect(blob.type).toBe('application/zip');
		});
	});

	/**
	 * Covers browser download triggering behavior.
	 */
	describe('triggerDownload', () => {
		it('creates a temporary anchor element, clicks it, and revokes the object URL', async () => {
			const s3Provider = createMockS3Provider();
			const downloader = new BackupDownloader(s3Provider as unknown as S3Provider, createTestSettings());
			const blob = new Blob(['zip-content'], { type: 'application/zip' });
			jest.spyOn(downloader, 'createDownloadBlob').mockResolvedValue(blob);

			const link = {
				href: '',
				download: '',
				click: jest.fn(),
			} as unknown as HTMLAnchorElement;
			const appendChildSpy = jest.fn((node: Node) => node);
			const removeChildSpy = jest.fn((node: Node) => node);
			const createElementSpy = jest.fn((tagName: string) => {
				if (tagName !== 'a') {
					throw new Error(`Unexpected tag: ${tagName}`);
				}

				return link;
			});
			const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
			Object.defineProperty(globalThis, 'document', {
				configurable: true,
				writable: true,
				value: {
					createElement: createElementSpy,
					body: {
						appendChild: appendChildSpy,
						removeChild: removeChildSpy,
					},
				} as unknown as Document,
			});

			const originalCreateObjectURL = URL.createObjectURL;
			const originalRevokeObjectURL = URL.revokeObjectURL;
			const createObjectURLMock = jest.fn(() => 'blob:backup-1');
			const revokeObjectURLMock = jest.fn();
			Object.defineProperty(URL, 'createObjectURL', {
				configurable: true,
				writable: true,
				value: createObjectURLMock,
			});
			Object.defineProperty(URL, 'revokeObjectURL', {
				configurable: true,
				writable: true,
				value: revokeObjectURLMock,
			});

			try {
				await downloader.triggerDownload('backup-1');

				expect(createElementSpy).toHaveBeenCalledWith('a');
				expect(appendChildSpy).toHaveBeenCalledWith(link);
				expect(link.href).toBe('blob:backup-1');
				expect(link.download).toBe('backup-1.zip');
				expect(link.click).toHaveBeenCalledTimes(1);
				expect(removeChildSpy).toHaveBeenCalledWith(link);
				expect(createObjectURLMock).toHaveBeenCalledWith(blob);
				expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:backup-1');
			} finally {
				Object.defineProperty(URL, 'createObjectURL', {
					configurable: true,
					writable: true,
					value: originalCreateObjectURL,
				});
				Object.defineProperty(URL, 'revokeObjectURL', {
					configurable: true,
					writable: true,
					value: originalRevokeObjectURL,
				});

				if (originalDocumentDescriptor) {
					Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
				} else {
					Reflect.deleteProperty(globalThis, 'document');
				}
			}
		});
	});

	/**
	 * Covers runtime mutation helpers for encryption keys and settings.
	 */
	describe('runtime updates', () => {
		it('clears the encryption key when null is provided and re-normalizes the backup prefix after settings updates', async () => {
			const s3Provider = createMockS3Provider();
			const ciphertext = new Uint8Array([6, 6, 6]);
			s3Provider.downloadFile.mockResolvedValue(ciphertext);
			s3Provider.downloadFileAsText.mockResolvedValue(JSON.stringify(createManifest({ encrypted: true })));
			const downloader = new BackupDownloader(
				s3Provider as unknown as S3Provider,
				createTestSettings({ backupPrefix: 'initial-prefix/' }),
			);

			downloader.setEncryptionKey(new Uint8Array([1, 2, 3]));
			downloader.setEncryptionKey(null);
			downloader.updateSettings(createTestSettings({ backupPrefix: '/updated-prefix//' }));

			const manifest = await downloader.getManifest('backup-2');
			const result = await downloader.downloadFile('backup-2', 'Notes/secret.md');

			expect(manifest.encrypted).toBe(true);
			expect(result).toEqual(ciphertext);
			expect(mockedDecrypt).not.toHaveBeenCalled();
			expect(mockedNormalizePrefix).toHaveBeenNthCalledWith(1, 'initial-prefix/');
			expect(mockedNormalizePrefix).toHaveBeenNthCalledWith(2, '/updated-prefix//');
			expect(mockedAddPrefix).toHaveBeenCalledWith('backup-2/.backup-manifest.json', 'updated-prefix');
			expect(s3Provider.downloadFile).toHaveBeenCalledWith('updated-prefix/backup-2/Notes/secret.md');
		});
	});
});
