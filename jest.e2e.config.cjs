/**
 * Jest configuration for E2E (pipeline) tests.
 *
 * These tests wire up real plugin modules (SyncEngine, SnapshotCreator, etc.)
 * against real S3, using an in-memory vault mock and fake-indexeddb for the
 * journal. Requires S3 credentials in .env (same as integration tests).
 *
 * Run with: npm run test:e2e
 */

/** @type {import('jest').Config} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/tests/e2e'],
	testMatch: ['**/*.e2e.test.ts'],
	setupFilesAfterEnv: [
		'<rootDir>/tests/setup.ts',
		'<rootDir>/tests/e2e/helpers/setup-idb.ts',
	],
	moduleNameMapper: {
		'^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
	},
	// E2E tests may take longer due to S3 round-trips
	testTimeout: 60000,
	transform: {
		'^.+\\.tsx?$': [
			'ts-jest',
			{
				tsconfig: {
					esModuleInterop: true,
					allowSyntheticDefaultImports: true,
					isolatedModules: true,
				},
			},
		],
	},
};
