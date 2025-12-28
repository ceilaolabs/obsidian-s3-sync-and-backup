/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
    moduleNameMapper: {
        '^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
    },
    collectCoverageFrom: [
        'src/**/*.ts',
        // Exclude UI/Plugin files (require Obsidian runtime)
        '!src/main.ts',
        '!src/settings.ts',
        '!src/statusbar.ts',
        '!src/commands.ts',
        // Exclude files that require Obsidian HTTP runtime
        '!src/storage/ObsidianHttpHandler.ts',
        '!src/storage/S3Provider.ts',
        // Exclude workflow orchestrators (tested via integration tests)
        '!src/sync/SyncEngine.ts',
        '!src/sync/SyncScheduler.ts',
    ],
    coverageThreshold: {
        global: {
            branches: 75,
            functions: 75,
            lines: 75,
            statements: 75,
        },
    },
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
