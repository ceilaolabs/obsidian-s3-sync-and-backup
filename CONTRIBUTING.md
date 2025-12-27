# Contributing to Obsidian S3 Sync & Backup

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to this project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
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

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start development mode (with watch):
   ```bash
   npm run dev
   ```

3. Build production bundle:
   ```bash
   npm run build
   ```

4. Run linter:
   ```bash
   npm run lint
   ```

### Testing Your Changes

For manual testing, copy the built files to your Obsidian vault:

```bash
# After running npm run build
cp main.js manifest.json styles.css /path/to/your/vault/.obsidian/plugins/obsidian-s3-sync-and-backup/
```

Then reload Obsidian to test your changes.

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

The debounce delay is configurable in settings (default: 5 seconds).

Fixes #123"
```

### Validation

Commit messages are automatically validated by `commitlint` in pull requests. If your commit message doesn't follow the conventional commits format, the PR checks will fail.

To validate commits locally before pushing:

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
   - Use TypeScript
   - Follow existing code style
   - Add comments for complex logic
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
- [ ] Changes are tested manually in Obsidian
- [ ] Documentation is updated if needed
- [ ] No unnecessary files are included (node_modules, build artifacts, etc.)

## Release Process

Releases are fully automated using [release-please](https://github.com/googleapis/release-please). Here's how it works:

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
