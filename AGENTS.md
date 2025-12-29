# AGENTS.md

## Project Overview

**Obsidian S3 Sync & Backup** — An Obsidian community plugin that provides bi-directional vault synchronization and scheduled backups for S3-compatible storage (AWS S3, MinIO, Cloudflare R2) with optional end-to-end encryption.

**Plugin ID:** `s3-sync-and-backup`

## Quick Context

| Attribute | Value |
|-----------|-------|
| Type | Obsidian Community Plugin |
| Language | TypeScript (strict mode) |
| Runtime | Browser (NO Node.js APIs) |
| Package Manager | npm |
| Bundler | esbuild |
| Output | `main.js`, `manifest.json`, `styles.css` |

## Agent Directives

### Important
1.  **Strict Linting Policy:**
    - **After EVERY code modification**, you MUST run: `npm run lint`
    - You must fix any linting errors **immediately**. Do not proceed until the linter passes.
2.  **Up-to-Date Knowledge:**
    - If you lack up-to-date information on any tech stack (e.g., latest AWS SDK), **use the `context7` tool** to find the latest documentation. Do not guess.
3.  **Document Everything:**
    - **More docs is better than less.** Document code, tests, GitHub Actions, and any logic thoroughly.
    - Use JSDoc for all functions, classes, and non-trivial code blocks.
4.  **Maintain Consistency:**
    - When you change any logic or code, **update all related mentions** (docs, comments, tests, README, CONTRIBUTING, AGENTS, etc.).

### Mindset & Quality
**Code Perfection is a Myth.**
- **Scrutinize Existing Code:** Don't assume it's perfect. If you see a bad pattern, fix it.
- **Test Logic, Not Implementation:** Design tests based on requirements, not just to mirror the current code.
- **Fix the Code:** If a valid test fails, the code is broken. **Never** weaken a test to pass buggy code.
- **Root Cause Analysis:** Fix the root cause of bugs, don't patch symptoms.

## Architecture & Structure

### Project Structure
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
│   │   ├── SyncJournal.ts       # IndexedDB sync state persistence
│   │   ├── ChangeTracker.ts     # Local file change detection
│   │   ├── DiffEngine.ts        # File comparison logic
│   │   └── ConflictHandler.ts   # Conflict resolution (LOCAL_/REMOTE_)
│   │
│   ├── backup/                  # Backup engine modules
│   │   ├── BackupScheduler.ts   # Backup scheduling with catch-up logic
│   │   ├── SnapshotCreator.ts   # Full vault snapshot creation
│   │   ├── RetentionManager.ts  # Old backup cleanup (by days/copies)
│   │   └── BackupDownloader.ts  # Backup download as zip
│   │
│   ├── storage/                 # S3 abstraction layer
│   │   ├── S3Provider.ts        # S3 operations wrapper
│   │   ├── S3Config.ts          # S3 client configuration
│   │   ├── ObsidianHttpHandler.ts   # Custom HTTP handler for Obsidian
│   │   └── ObsidianRequestHandler.ts
│   │
│   ├── crypto/                  # Encryption modules
│   │   ├── KeyDerivation.ts     # Argon2id key derivation (hash-wasm)
│   │   ├── FileEncryptor.ts     # XSalsa20-Poly1305 (tweetnacl)
│   │   ├── VaultMarker.ts       # Encryption marker file (vault.enc)
│   │   └── Hasher.ts            # SHA-256 file hashing (hash-wasm)
│   │
│   └── utils/                   # Shared utilities
│       ├── retry.ts             # Retry with exponential backoff
│       ├── time.ts              # Time formatting (relative times)
│       └── paths.ts             # Path normalization
│
├── tests/                       # Unit & integration tests (Jest)
│   ├── __mocks__/               # Obsidian API mocks
│   ├── helpers/                 # S3 test utilities
│   ├── backup/                  # Backup module tests
│   ├── crypto/                  # Crypto module tests
│   ├── storage/                 # Storage module tests
│   ├── sync/                    # Sync module tests
│   └── utils/                   # Utility tests
│
├── manifest.json
├── package.json
├── esbuild.config.mjs
└── tsconfig.json
```

### S3 Bucket Structure

```
s3://bucket/
├── {syncPrefix}/                     # default: "vault"
│   ├── .obsidian-s3-sync/
│   │   └── .vault.enc                # Encryption marker + salt
│   └── [vault files mirrored here]
│
└── {backupPrefix}/                   # default: "backups"
    └── backup-{ISO_TIMESTAMP}/
        ├── [full vault snapshot]
        └── .backup-manifest.json
```

## Development Standards

### DOs
- **Safe File Writes:** Use `Vault.process()` for atomic background modifications (prevents conflicts).
- **Path Safety:** ALWAYS use `normalizePath()` on user inputs and file paths.
- **Document Everything:** Use JSDoc comments.
- **Strict TypeScript:** Use `"strict": true`.
- **Obsidian API:** Use `this.app.vault` for vault operations.
- **S3 Operations:** Use `@aws-sdk/client-s3` v3.
- **Local State:** Use IndexedDB (`idb` library).
- **Encryption:** `hash-wasm` (Argon2id/SHA-256) & `tweetnacl` (XSalsa20-Poly1305).
- **Performance:** Batch disk access, debounce events, keep startup light.
- **Async:** Use `async/await` everywhere.

### DON'Ts
- **No Global App:** Never use `window.app` or `app`. Use `this.app`.
- **No `innerHTML`:** Security risk. Use DOM API (e.g., `createEl`, `setText`).
- **No Hardcoded Styles:** Use CSS classes and variables.
- **No Node.js APIs:** `fs`, `path`, `crypto` DO NOT work in Obsidian (browser env).
- **No LocalStorage:** Use IndexedDB.
- **No Blocking:** Never block the main thread.
- **No Hardcoded Paths:** Use `settings.syncPrefix` / `settings.backupPrefix`.
- **Security:** No network calls without user reason, no telemetry, no remote code execution.
- **Mobile:** Do not assume desktop behavior. Test on mobile if possible.

## Operational Procedures

### Build & Test Commands
```bash
npm install      # Install dependencies
npm run dev      # Development build with watch
npm run build    # Production build
npm run lint     # Run ESLint (Mandatory)
npm run test     # Run unit tests
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage
```

### Manual Testing
1. Run `npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to: `<Vault>/.obsidian/plugins/s3-sync-and-backup/`
3. Reload Obsidian and enable in **Settings → Community plugins**

### Linting Rules
Uses `eslint-plugin-obsidianmd`.
- Use `Vault#configDir` instead of hardcoded `.obsidian`
- Sentence case for UI text
- Avoid unsafe casts to `TFile`/`TFolder`

### Commit Strategy
Use **Conventional Commits**:
- `feat:` New feature (minor bump)
- `fix:` Bug fix (patch bump)
- `docs:`, `refactor:`, `perf:`, `test:`, `chore:`

### Release & Versioning
**Automated via release-please.**
1. Merge PR with conventional commits to `main`.
2. `release-please` creates a Release PR.
3. Merge Release PR to publish.

**Manual Step: `versions.json`**
- Update ONLY when `minAppVersion` changes in `manifest.json`.
- Add new mapping: `"plugin_version": "min_app_version"`.
- Helper: `node scripts/version.mjs <version>`

## References
- **Obsidian API:** https://docs.obsidian.md
- **Developer Policies:** https://docs.obsidian.md/Developer+policies
- **Plugin Guidelines:** https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- **Sample Plugin:** https://github.com/obsidianmd/obsidian-sample-plugin