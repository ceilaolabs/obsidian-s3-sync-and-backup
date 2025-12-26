export default {
    extends: ['@commitlint/config-conventional'],
    rules: {
        'type-enum': [
            2,
            'always',
            [
                'feat',     // New feature
                'fix',      // Bug fix
                'docs',     // Documentation changes
                'style',    // Code style changes (formatting, missing semicolons, etc.)
                'refactor', // Code refactoring
                'perf',     // Performance improvements
                'test',     // Adding or updating tests
                'build',    // Build system or external dependencies
                'ci',       // CI configuration changes
                'chore',    // Other changes that don't modify src or test files
                'revert'    // Revert a previous commit
            ]
        ],
        'subject-case': [2, 'never', ['upper-case', 'pascal-case']],
        'subject-empty': [2, 'never'],
        'subject-full-stop': [2, 'never', '.'],
        'type-case': [2, 'always', 'lower-case'],
        'type-empty': [2, 'never']
    }
};
