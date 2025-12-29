# Contributing to Obsidian S3 Sync & Backup

Welcome! We love contributions. This plugin brings enterprise-grade sync and backup capabilities to Obsidian using S3-compatible storage.

Before you dive in, please check these documents for context:
- **[README.md](README.md)**: Features, installation, and usage.
- **[AGENTS.md](AGENTS.md)**: Agent-specific directives and project architecture.
- **[BLUEPRINT.md](BLUEPRINT.md)**: Full Product Requirements Document (PRD).

---

## TL;DR Quick Start

1.  **Fork** this repository on GitHub.
2.  **Clone** your fork:
    ```bash
    git clone https://github.com/YOUR_USERNAME/obsidian-s3-sync-and-backup.git
    cd obsidian-s3-sync-and-backup
    ```
3.  **Install** dependencies:
    ```bash
    npm install
    # Note: Requires Node.js 22+
    ```
4.  **Build** in watch mode:
    ```bash
    npm run dev
    ```

---

## Development Setup

### Prerequisites
- **Node.js**: v22 or higher (v24 recommended).
- **npm**: v10+.
- **Git**: Latest version.

### Build Commands
| Command | Description |
| :--- | :--- |
| `npm run dev` | Builds in watch mode (development). |
| `npm run build` | Production build (minified, type-checked). |
| `npm run lint` | **Mandatory.** Runs ESLint. |
| `npm run test:unit` | Runs unit tests. |
| `npm run test:integration` | Runs integration tests. |

### Local Testing Setup
To test your changes in Obsidian:
1.  Create a test vault in Obsidian.
2.  Create the plugin folder:
    `<VaultPath>/.obsidian/plugins/s3-sync-and-backup/`
3.  Build the plugin (`npm run build`).
4.  Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
    - *Tip: You can symlink these files for easier development, but copying is safer to avoid file lock issues.*
5.  Reload Obsidian (`Cmd/Ctrl + R`) and enable the plugin.

---

## Contribution Workflow

### 1. Branching
Create a new branch for your work. We use descriptive branch names:
-   `feat/feature-name` (New features)
-   `fix/bug-name` (Bug fixes)
-   `docs/documentation-update` (Docs only)
-   `refactor/cleanup` (Code restructuring)

### 2. Making Changes
-   **Write Code**: Follow the [Coding Standards](#-coding-standards) below.
-   **Test**: Add unit tests for logic and integration tests for S3 operations.
-   **Lint**: Run `npm run lint` frequently. **You cannot commit if linting fails.**

### 3. Commit Messages (Crucial!)
We use **[Conventional Commits](https://www.conventionalcommits.org/)**. This is **enforced** by CI and used to generate the CHANGELOG automatically.

**Format:** `<type>(<scope>): <description>`

**Types:**
-   `feat`: New feature (Triggers **Minor** version bump).
-   `fix`: Bug fix (Triggers **Patch** version bump).
-   `docs`: Documentation changes.
-   `style`: Formatting, missing semi colons, etc.
-   `refactor`: Code change that neither fixes a bug nor adds a feature.
-   `test`: Adding missing tests.
-   `chore`: Maintenance tasks.

**Examples:**
-   `feat(sync): add support for Cloudflare R2`
-   `fix(backup): resolve retention policy bug`
-   `docs: update installation guide in README`

> **Note:** Append `!` to the type (e.g., `feat!: remove legacy API`) for Breaking Changes (Triggers **Major** version bump).

### 4. Pull Request (PR)
1.  Push your branch to your fork.
2.  Open a PR against the `main` branch.
3.  Fill out the PR template completely.
4.  **CI Checks** must pass:
    -   `lint`: ESLint check.
    -   `build`: TypeScript compilation.
    -   `test`: Unit and integration tests.
    -   `commitlint`: Commit message format check.

---

## Coding Standards

### Critical Guidelines
These are non-negotiable rules for this project:

1.  **Strict Linting**:
    -   Always run `npm run lint` before pushing.
    -   Fix errors immediately; do not suppress them.

2.  **Document Everything**:
    -   **More is better.** Over-communicate in comments.
    -   Use **JSDoc** for every exported function, class, and interface.
    -   Explain *why* complex logic exists, not just *what* it does.

3.  **Maintain Consistency**:
    -   If you change logic, **update all related mentions** immediately.
    -   Check `README.md`, `AGENTS.md`, and code comments to ensure they stay in sync.

### Obsidian-Specific Rules
-   **No Node.js APIs**: Remember, this runs in a browser/Electron (renderer). Do NOT use `fs`, `path`, or `crypto` modules directly (unless in strictly dev/test scripts).
-   **Filesystem**: Use `this.app.vault` API.
    -   Use `tFile` and `tFolder` references.
    -   Use `Vault.process()` for atomic updates.
-   **Paths**: Always wrap paths with `normalizePath()`.
-   **Styles**: Do not use `el.style`. Use CSS classes and define them in `styles.css`.

---

## Testing Strategy

### Unit Tests
-   **Location**: `tests/` (mirroring `src/` structure).
-   **Tool**: Jest + `jest-environment-jsdom`.
-   **Focus**: Isolated logic (diff engine, scheduling math, conflict resolution).
-   **Running**: `npm run test:unit`

### Integration Tests
-   **Location**: `tests/**/*.integration.test.ts`.
-   **Focus**: Real interactions with S3 providers.
-   **Requirement**: You need a `.env` file with S3 credentials.

**Setup for Integration Tests:**
1.  Copy `.env.sample` to `.env`.
2.  Fill in valid S3 credentials (AWS, MinIO, or R2).
    ```env
    S3_ENDPOINT=...
    S3_REGION=...
    S3_BUCKET=...
    S3_ACCESS_KEY=...
    S3_SECRET_KEY=...
    ```
3.  Run: `npm run test:integration`
    > ⚠️ **Warning**: Integration tests may incur small costs (S3 requests) and create files in the specified bucket. They attempt to clean up, but use a test bucket if possible. Most of cloud providers give generous
    free quota which is well above of these limits.

---

## Release Process

We use **[release-please](https://github.com/googleapis/release-please)** for full automation.

1.  **No Manual Versioning**: Do not edit `package.json` version manually.
2.  **Merge to Main**: When a PR is merged, `release-please`:
    -   Analyzes commits (feat/fix/etc).
    -   Updates `CHANGELOG.md`.
    -   Creates a **Release PR** (e.g., "chore: release 1.1.0").
3.  **Publish**: Merging the **Release PR** triggers:
    -   GitHub Release creation.
    -   Asset upload (`main.js`, `manifest.json`, `styles.css`).

**Manual Step (Only if `minAppVersion` changes):**
-   Update `versions.json` manually if you increased the minimum required Obsidian version in `manifest.json`.

---

Happy Coding! 🚀
