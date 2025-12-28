/** @type {import('jest').Config} */
require('dotenv').config();

module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    // Only run integration tests
    testMatch: ['**/*.integration.test.ts'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
    moduleNameMapper: {
        '^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
    },
    // Higher timeout for S3 operations
    testTimeout: 30000,
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
