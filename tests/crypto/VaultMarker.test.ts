/**
 * @jest-environment jsdom
 */

import { App } from 'obsidian';
import { generateDeviceId, getOrCreateDeviceId } from '../../src/crypto/VaultMarker';

describe('generateDeviceId', () => {
	it('returns a string with "device-" prefix and 16 hex characters', () => {
		const id = generateDeviceId();
		expect(id).toMatch(/^device-[0-9a-f]{16}$/);
	});

	it('generates unique IDs on successive calls', () => {
		const ids = new Set(Array.from({ length: 20 }, () => generateDeviceId()));
		expect(ids.size).toBe(20);
	});
});

describe('getOrCreateDeviceId', () => {
	let mockApp: App;
	let vaultStorage: Map<string, string>;

	beforeEach(() => {
		vaultStorage = new Map();

		mockApp = {
			loadLocalStorage: jest.fn((key: string) => vaultStorage.get(key) ?? null),
			saveLocalStorage: jest.fn((key: string, value: string) => {
				vaultStorage.set(key, value);
			}),
		} as unknown as App;

		window.localStorage.removeItem('obsidian-s3-sync-device-id');
	});

	afterEach(() => {
		window.localStorage.removeItem('obsidian-s3-sync-device-id');
	});

	it('generates a new device ID when no prior value exists', () => {
		const id = getOrCreateDeviceId(mockApp);

		expect(id).toMatch(/^device-[0-9a-f]{16}$/);
		expect(mockApp.saveLocalStorage).toHaveBeenCalledWith('s3-sync-device-id', id);
	});

	it('returns the existing vault-scoped ID without regenerating', () => {
		vaultStorage.set('s3-sync-device-id', 'device-existing1234abcd');

		const id = getOrCreateDeviceId(mockApp);

		expect(id).toBe('device-existing1234abcd');
		expect(mockApp.saveLocalStorage).not.toHaveBeenCalled();
	});

	it('migrates a legacy global localStorage ID into vault-scoped storage', () => {
		window.localStorage.setItem('obsidian-s3-sync-device-id', 'device-legacy00112233');

		const id = getOrCreateDeviceId(mockApp);

		expect(id).toBe('device-legacy00112233');
		expect(mockApp.saveLocalStorage).toHaveBeenCalledWith('s3-sync-device-id', 'device-legacy00112233');
	});

	it('does not migrate when vault-scoped storage already has a value', () => {
		window.localStorage.setItem('obsidian-s3-sync-device-id', 'device-legacy00112233');
		vaultStorage.set('s3-sync-device-id', 'device-vaultspecific99');

		const id = getOrCreateDeviceId(mockApp);

		expect(id).toBe('device-vaultspecific99');
		expect(mockApp.saveLocalStorage).not.toHaveBeenCalled();
	});

	it('leaves the legacy global key intact after migration', () => {
		window.localStorage.setItem('obsidian-s3-sync-device-id', 'device-legacy00112233');

		getOrCreateDeviceId(mockApp);

		expect(window.localStorage.getItem('obsidian-s3-sync-device-id')).toBe('device-legacy00112233');
	});

	it('produces distinct IDs for two different vaults (vault-scoped isolation)', () => {
		const vault1Storage = new Map<string, string>();
		const vault2Storage = new Map<string, string>();

		const app1 = {
			loadLocalStorage: jest.fn((key: string) => vault1Storage.get(key) ?? null),
			saveLocalStorage: jest.fn((key: string, value: string) => {
				vault1Storage.set(key, value);
			}),
		} as unknown as App;

		const app2 = {
			loadLocalStorage: jest.fn((key: string) => vault2Storage.get(key) ?? null),
			saveLocalStorage: jest.fn((key: string, value: string) => {
				vault2Storage.set(key, value);
			}),
		} as unknown as App;

		const id1 = getOrCreateDeviceId(app1);
		const id2 = getOrCreateDeviceId(app2);

		expect(id1).not.toBe(id2);
		expect(vault1Storage.get('s3-sync-device-id')).toBe(id1);
		expect(vault2Storage.get('s3-sync-device-id')).toBe(id2);
	});

	it('handles window.localStorage being unavailable gracefully', () => {
		const originalLocalStorage = window.localStorage;
		Object.defineProperty(window, 'localStorage', {
			get: () => { throw new Error('SecurityError: localStorage not available'); },
			configurable: true,
		});

		const id = getOrCreateDeviceId(mockApp);

		expect(id).toMatch(/^device-[0-9a-f]{16}$/);
		expect(mockApp.saveLocalStorage).toHaveBeenCalledWith('s3-sync-device-id', id);

		Object.defineProperty(window, 'localStorage', {
			get: () => originalLocalStorage,
			configurable: true,
		});
	});

	it('returns the same ID on repeated calls for the same vault', () => {
		const first = getOrCreateDeviceId(mockApp);
		const second = getOrCreateDeviceId(mockApp);

		expect(first).toBe(second);
	});
});
