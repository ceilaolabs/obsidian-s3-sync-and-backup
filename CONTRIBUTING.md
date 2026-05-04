# Contributing to Obsidian S3 Sync & Backup

Welcome! We love contributions. This plugin brings bi-directional vault sync and scheduled backups to Obsidian using S3-compatible storage.

Before you dive in, please check these documents for context:
- **[README.md](README.md)** — Features, installation, and usage
- **[AGENTS.md](AGENTS.md)** — Project architecture and development standards

---

## Quick Start

1.  **Fork** this repository on GitHub.
2.  **Clone** your fork:
    ```bash
    git clone https://github.com/YOUR_USERNAME/obsidian-s3-sync-and-backup.git
    cd obsidian-s3-sync-and-backup
    ```
3.  **Install** dependencies:
    ```bash
    npm install
    ```
4.  **Build** in watch mode:
    ```bash
    npm run dev
    ```

---

## Development Setup

### Prerequisites

- **Node.js**: v22 or higher
- **npm**: v10+
- **Git**: Latest version

### Build Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Development build with file watching |
| `npm run build` | Production build (type-check + esbuild) |
| `npm run lint` | **Mandatory.** Run ESLint on the entire project |
| `npm run test:unit` | Run unit tests (excludes integration) |
| `npm run test:integration` | Run integration tests (requires `.env` with S3 creds) |
| `npm run test:coverage` | Unit tests with coverage report |
| `npm run test:watch` | Run tests in watch mode |

### Manual Testing in Obsidian

To test your changes in a live Obsidian instance:

1.  Create a test vault in Obsidian (or use an existing one).
2.  Create the plugin folder:
    ```
    <VaultPath>/.obsidian/plugins/s3-sync-and-backup/
    ```
3.  Build the plugin: `npm run build`
4.  Copy `main.js`, `manifest.json`, and `styles.css` into the plugin folder.
    > **Tip:** You can symlink these files for faster iteration, but copying is safer to avoid file lock issues.
5.  Reload Obsidian (`Cmd/Ctrl + R`) and enable the plugin in **Settings → Community plugins**.

### Debug Logging

The plugin has a built-in debug logging mode that outputs verbose logs to the browser console.

1.  Enable **Debug logging** in **Settings → S3 Sync & Backup → Advanced**.
2.  Open Obsidian DevTools: `Cmd+Option+I` (Mac) or `Ctrl+Shift+I` (Windows/Linux).
3.  Go to the **Console** tab and filter by `[S3` to isolate plugin logs.

All debug logs use `console.debug()` and are prefixed by module:

| Prefix | Module |
| :--- | :--- |
| `[S3 Sync]` | Sync engine, scheduler, executor |
| `[S3 Backup]` | Backup scheduler, snapshots, retention |
| `[S3 Retry]` | S3 request retry attempts |
| `[S3 HTTP]` | Raw S3 HTTP requests/responses (always on) |
| `[Encryption]` | Encryption coordinator |

> **Note:** `console.error()` calls (failures) are always emitted regardless of the debug toggle.

---

## Contribution Workflow

### 1. Branching

Create a new branch for your work:
-   `feat/feature-name` — New features
-   `fix/bug-name` — Bug fixes
-   `docs/documentation-update` — Documentation only
-   `refactor/description` — Code restructuring
-   `test/description` — Test additions or improvements

### 2. Making Changes

-   **Write code**: Follow the [Coding Standards](#coding-standards) below.
-   **Add tests**: Every new feature or bug fix should include corresponding tests.
-   **Lint early**: Run `npm run lint` frequently. **You cannot commit if linting fails.**
-   **Run tests**: Run `npm run test:unit` before pushing. All tests must pass.

### 3. Commit Messages

We use **[Conventional Commits](https://www.conventionalcommits.org/)**. This is enforced by CI and used to generate the CHANGELOG automatically.

**Format:** `<type>(<scope>): <description>`

| Type | Purpose | Version Bump |
|------|---------|-------------|
| `feat` | New feature | Minor |
| `fix` | Bug fix | Patch |
| `docs` | Documentation changes | None |
| `style` | Formatting (no logic change) | None |
| `refactor` | Code restructuring (no feature/fix) | None |
| `test` | Adding or updating tests | None |
| `perf` | Performance improvement | None |
| `chore` | Maintenance tasks | None |

**Scope** should match the domain: `sync`, `backup`, `crypto`, `storage`, `settings`, `statusbar`, `commands`, etc.

**Examples:**
```
feat(sync): add support for Cloudflare R2
fix(backup): resolve retention policy off-by-one error
test(sync): add SyncPlanner unit tests
docs: update installation guide in README
```

> Append `!` after the type for **breaking changes**: `feat(sync)!: replace sync journal schema`

**Commit granularity:**
- One logical change per commit — never batch unrelated changes
- New module → commit. Its tests → separate commit.
- Bug fix + regression test → can be one commit
- Write a message body when the "why" isn't obvious from the diff

### 4. Pull Requests

1.  Push your branch to your fork.
2.  Open a PR against the `main` branch.
3.  Fill out the PR template completely.
4.  **All CI checks must pass:**
    -   `lint` — ESLint
    -   `build` — TypeScript compilation + esbuild
    -   `test` — Unit tests with ≥75% coverage threshold

---

## Coding Standards

### Critical Rules

These are non-negotiable for this project:

1.  **Strict TypeScript**: The project uses `"strict": true`. No `as any`, no `@ts-ignore`.
2.  **Strict Linting**: Run `npm run lint` before every push. Fix errors immediately.
3.  **Document Everything**: Use JSDoc for every exported function, class, and interface. Explain *why* complex logic exists, not just *what* it does.
4.  **Maintain Consistency**: If you change logic, update all related docs, comments, and tests.

### Obsidian-Specific Rules

-   **No Node.js APIs**: This plugin runs in a browser/Electron renderer. `fs`, `path`, and `crypto` do NOT work. Use Obsidian's `Vault` API instead.
-   **Vault operations**: Use `this.app.vault` — never `window.app` or global `app`.
-   **Atomic writes**: Use `Vault.process()` for background file modifications.
-   **Paths**: Always use `normalizePath()` on user input and file paths.
-   **Styles**: Use CSS classes in `styles.css` — never inline `el.style`.
-   **No `innerHTML`**: Security risk. Use Obsidian's DOM helpers (`createEl`, `setText`).
-   **Local state**: Use IndexedDB (`idb` library) — never `localStorage`.

---

## Testing

Tests are essential. We maintain a **75% minimum coverage threshold** enforced by CI.

### Unit Tests

-   **Location**: `tests/` (mirrors `src/` structure)
-   **Framework**: Jest with `ts-jest`
-   **Mock**: Obsidian API is mocked via `tests/__mocks__/obsidian.ts`
-   **Run**: `npm run test:unit`

**What to test:**
- All public methods of new modules
- Edge cases and error paths
- Every branch in decision logic

**Test file naming**: `tests/<domain>/<ModuleName>.test.ts`

### Integration Tests

-   **Location**: `tests/**/*.integration.test.ts`
-   **Focus**: Real S3 operations against a live bucket
-   **Config**: Requires `.env` file with S3 credentials

**Setup:**
1.  Copy `.env.sample` to `.env`.
2.  Fill in valid S3 credentials:
    ```env
    S3_ENDPOINT=...
    S3_REGION=...
    S3_BUCKET=...
    S3_ACCESS_KEY=...
    S3_SECRET_KEY=...
    ```
3.  Run: `npm run test:integration`

> ⚠️ Integration tests create and delete objects in the specified bucket. Use a dedicated test bucket. Most cloud providers offer generous free tiers well above these limits.

### Coverage

Run `npm run test:coverage` to generate a coverage report. The CI enforces:

| Metric | Threshold |
|--------|-----------|
| Statements | 75% |
| Branches | 75% |
| Functions | 75% |
| Lines | 75% |

---

## Reporting Issues

When filing a bug report on [GitHub Issues](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/issues):

1.  **Search first** — check if the issue already exists.
2.  **Use the bug template** if available.
3.  **Include:**
    -   Obsidian version and platform (desktop/mobile, OS)
    -   Plugin version
    -   S3 provider (AWS, R2, RustFS, etc.)
    -   Steps to reproduce
    -   Expected vs. actual behavior
    -   Console errors (if any — open DevTools with `Cmd/Ctrl + Shift + I`)
4.  **For feature requests**, describe the use case and why existing functionality doesn't cover it.

---

## Release Process

Automated via **[release-please](https://github.com/googleapis/release-please)**:

1.  **No manual versioning** — do not edit `package.json` version.
2.  Merge PR with conventional commits to `main`.
3.  `release-please` creates a **Release PR** with bumped version and CHANGELOG.
4.  Merge the Release PR → GitHub Release + asset upload (`main.js`, `manifest.json`, `styles.css`).

**Manual step (rare):** Update `versions.json` only when `minAppVersion` changes in `manifest.json`. Helper: `node scripts/version.mjs <version>`

---

Happy coding!
