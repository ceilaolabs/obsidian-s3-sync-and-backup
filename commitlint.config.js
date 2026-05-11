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
        'type-empty': [2, 'never'],
        // Bot-generated commits (Dependabot, release-please) include long
        // auto-generated URLs (release notes, changelogs, compare links) and
        // trailers (Signed-off-by, updated-dependencies) that routinely exceed
        // 100 characters and cannot be reformatted. Disabling these rules
        // unblocks bot PRs without sacrificing any meaningful enforcement,
        // since the line-length cap on bodies/footers is purely cosmetic.
        'body-max-line-length': [0, 'always'],
        'footer-max-line-length': [0, 'always']
    }
};
