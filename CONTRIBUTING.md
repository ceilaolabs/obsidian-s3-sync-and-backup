# Contributing to Obsidian S3 Sync & Backup

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to this project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Linting](#linting)
- [Conventional Commits](#conventional-commits)
- [Pull Request Process](#pull-request-process)
- [Release Process](#release-process)

## Code of Conduct

This project follows the standard open-source code of conduct. Please be respectful and constructive in all interactions.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/obsidian-s3-sync-and-backup.git
   cd obsidian-s3-sync-and-backup
   ```
3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/ceilaolabs/obsidian-s3-sync-and-backup.git
   ```

## Development Setup

### Prerequisites

- Node.js 22+ (24 recommended)
- npm
- Git

### Installation

```bash
npm install
```

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Development build with watch mode |
| `npm run build` | Production build (with type checking) |
| `npm run lint` | Run ESLint |
| `npm run test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |

### Manual Testing in Obsidian

After building, copy the output files to your test vault:

```bash
# After running npm run build
cp main.js manifest.json styles.css /path/to/your/vault/.obsidian/plugins/obsidian-s3-sync-and-backup/
```

Then reload Obsidian (`Ctrl/Cmd + R`) to test your changes.

## Project Structure

```
obsidian-s3-sync-and-backup/
├── src/
│   ├── main.ts                  # Plugin entry point (keep minimal)
│   ├── settings.ts              # Settings tab UI
│   ├── statusbar.ts             # Status bar component
│   ├── commands.ts              # Command palette registration
│   ├── types.ts                 # TypeScript interfaces & constants
│   │
│   ├── sync/                    # Sync engine modules
│   │   ├── SyncEngine.ts        # Main sync orchestrator
│   │   ├── SyncScheduler.ts     # Periodic sync scheduling
│   │   ├── SyncJournal.ts       # IndexedDB sync state
│   │   ├── ChangeTracker.ts     # Local file change detection
│   │   ├── DiffEngine.ts        # File comparison logic
│   │   └── ConflictHandler.ts   # Conflict resolution
│   │
│   ├── backup/                  # Backup engine modules
│   │   ├── BackupScheduler.ts   # Backup scheduling logic
│   │   ├── SnapshotCreator.ts   # Vault snapshot creation
│   │   ├── RetentionManager.ts  # Old backup cleanup
│   │   └── BackupDownloader.ts  # Backup download (zip)
│   │
│   ├── storage/                 # S3 abstraction layer
│   │   ├── S3Provider.ts        # S3 operations wrapper
│   │   ├── S3Config.ts          # S3 client configuration
│   │   ├── ObsidianHttpHandler.ts   # Custom HTTP handler
│   │   └── ObsidianRequestHandler.ts
│   │
│   ├── crypto/                  # Encryption modules
│   │   ├── KeyDerivation.ts     # Argon2id key derivation
│   │   ├── FileEncryptor.ts     # XSalsa20-Poly1305 encryption
│   │   ├── VaultMarker.ts       # Encryption marker file
│   │   └── Hasher.ts            # SHA-256 hashing
│   │
│   └── utils/                   # Shared utilities
│       ├── retry.ts             # Retry with exponential backoff
│       ├── time.ts              # Time formatting utilities
│       └── paths.ts             # Path normalization
│
├── tests/                       # Unit tests (Jest)
│   ├── __mocks__/               # Mock implementations
│   ├── crypto/                  # Crypto module tests
│   ├── sync/                    # Sync module tests
│   └── utils/                   # Utility tests
│
├── .github/                     # GitHub Actions workflows
│   └── workflows/
│       ├── pr-checks.yml        # PR validation
│       └── release-please.yml   # Automated releases
│
├── manifest.json                # Obsidian plugin manifest
├── package.json                 # npm package config
├── tsconfig.json                # TypeScript config
├── esbuild.config.mjs           # Build configuration
├── eslint.config.mts            # ESLint configuration
├── jest.config.cjs              # Jest test configuration
└── commitlint.config.js         # Commit message validation
```

## Testing

### Running Tests

```bash
# Run all tests
npm run test

# Run tests in watch mode (for development)
npm run test:watch

# Run with coverage report
npm run test:coverage
```

### Writing Tests

- Place test files in `/tests/` directory, mirroring the `src/` structure
- Use Jest and `jest-environment-jsdom` for browser-like environment
- Mock Obsidian APIs as needed (see `tests/__mocks__/`)

## Linting

The project uses ESLint with `eslint-plugin-obsidianmd` for Obsidian-specific best practices.

```bash
npm run lint
```

### Key Linting Rules

- Use `Vault#configDir` instead of hardcoded `.obsidian`
- Use sentence case for UI text
- Avoid unsafe casts to `TFile`/`TFolder`
- Proper Settings API usage

**Always fix linting errors before committing.**

## Conventional Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for commit messages. This enables automated changelog generation and semantic versioning.

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type**: The type of change (required)
- **scope**: The area of the codebase affected (optional)
- **subject**: A brief description of the change (required)
- **body**: A detailed description (optional)
- **footer**: Breaking changes and issue references (optional)

### Commit Types

| Type | Description | Changelog Section | Version Bump |
|------|-------------|-------------------|--------------|
| `feat` | New feature | Features | Minor |
| `fix` | Bug fix | Bug Fixes | Patch |
| `perf` | Performance improvement | Performance | Patch |
| `docs` | Documentation only | Documentation | - |
| `style` | Code style (formatting, etc.) | - | - |
| `refactor` | Code refactoring | Code Refactoring | - |
| `test` | Adding or updating tests | - | - |
| `build` | Build system changes | - | - |
| `ci` | CI configuration changes | - | - |
| `chore` | Other changes | - | - |
| `revert` | Revert a previous commit | Reverts | - |

### Examples

**Feature (triggers minor version bump):**
```bash
git commit -m "feat: add support for MinIO custom paths"
```

**Bug fix (triggers patch version bump):**
```bash
git commit -m "fix: resolve conflict detection for binary files"
```

**With scope:**
```bash
git commit -m "feat(sync): implement incremental sync algorithm"
```

**Breaking change (triggers major version bump):**
```bash
git commit -m "feat!: change encryption algorithm to XSalsa20

BREAKING CHANGE: Existing encrypted vaults must be re-encrypted with the new algorithm."
```

**Multiple paragraphs:**
```bash
git commit -m "fix(backup): prevent duplicate backups during rapid changes

This change adds a debounce mechanism to the backup trigger to prevent
duplicate backups when multiple files are changed in quick succession.

Fixes #123"
```

### Validation

Commit messages are validated by `commitlint` in PR checks. To validate locally:

```bash
npx commitlint --from HEAD~1 --to HEAD --verbose
```

## Pull Request Process

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes** following the coding standards:
   - Use TypeScript with strict mode
   - Follow existing code style
   - Add JSDoc comments for public functions
   - Update documentation if needed

3. **Commit your changes** using conventional commits:
   ```bash
   git add .
   git commit -m "feat: your feature description"
   ```

4. **Push to your fork**:
   ```bash
   git push origin feat/your-feature-name
   ```

5. **Create a Pull Request** on GitHub:
   - Target the `main` branch
   - Fill out the PR template
   - Link any related issues
   - Wait for CI checks to pass

6. **Address review feedback**:
   - Make requested changes
   - Commit with conventional commits
   - Push updates to your branch

7. **Merge**: Once approved and all checks pass, a maintainer will merge your PR.

### PR Checklist

Before submitting your PR, ensure:

- [ ] Code follows the project's coding standards
- [ ] All commits follow conventional commits format
- [ ] Linting passes (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] Tests pass (`npm run test`)
- [ ] Changes are tested manually in Obsidian
- [ ] Documentation is updated if needed

## Release Process

Releases are fully automated using [release-please](https://github.com/googleapis/release-please).

### Automated Workflow

1. **Conventional Commits**: When you merge a PR with conventional commits to `main`, release-please automatically:
   - Analyzes commit messages
   - Determines the next version number (based on commit types)
   - Creates or updates a "Release PR"

2. **Release PR**: This special PR:
   - Updates version numbers in `package.json`, `manifest.json`, and `versions.json`
   - Generates/updates `CHANGELOG.md` with all changes since last release
   - Is automatically kept up-to-date as more commits are merged

3. **Publishing**: When the Release PR is merged:
   - A GitHub release is automatically created
   - The production build is compiled
   - Required files (`main.js`, `manifest.json`, `styles.css`) are attached to the release
   - The release is published

### Version Bumping Rules

- **Patch** (0.1.0 → 0.1.1): `fix`, `perf` commits
- **Minor** (0.1.0 → 0.2.0): `feat` commits
- **Major** (0.1.0 → 1.0.0): Any commit with `BREAKING CHANGE` in footer or `!` after type

### No Manual Versioning

**Do not manually update version numbers** in `package.json`, `manifest.json`, or `versions.json`. Release-please handles all version management automatically.

## Questions?

If you have questions about contributing:

- Check existing [issues](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/issues)
- Open a new issue with the "question" label
- Review the [documentation](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/wiki)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
