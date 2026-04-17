# AGENTS.md

## Project Overview

**Obsidian S3 Sync & Backup** — An Obsidian community plugin that provides bi-directional vault synchronization and scheduled backups for S3-compatible storage (AWS S3, MinIO, Cloudflare R2) with optional end-to-end encryption.

**Plugin ID:** `s3-sync-and-backup`

| Attribute | Value |
|-----------|-------|
| Type | Obsidian Community Plugin |
| Language | TypeScript (strict mode) |
| Runtime | Browser (NO Node.js APIs) |
| Package Manager | npm |
| Bundler | esbuild |
| Output | `main.js`, `manifest.json`, `styles.css` |

## Agent Directives

1. **Strict Linting:** After EVERY code modification, run `npm run lint`. Fix errors immediately before proceeding.
2. **Up-to-Date Knowledge:** If you lack current information on any dependency (AWS SDK, Obsidian API, etc.), use the `context7` tool (if it's available). Do not guess.
3. **Document Everything:** Over-documenting is preferred. See the [Documentation](#documentation) section.
4. **Maintain Consistency:** When you change logic or code, update all related mentions (docs, comments, tests, README, CONTRIBUTING, AGENTS).
5. **Scrutinize Existing Code:** Don't assume it's perfect. If you see a bad pattern, fix it.
6. **Fix the Code, Not the Test:** If a valid test fails, the code is broken. Never weaken a test to pass buggy code.
7. **Root Cause Analysis:** Fix the root cause of bugs, don't patch symptoms.
8. **Human contributor guide:** See [CONTRIBUTING.md](CONTRIBUTING.md) for the full human-facing development guide.

## Architecture

### Project Structure

```
obsidian-s3-sync-and-backup/
├── src/
│   ├── main.ts                      # Plugin entry point (keep minimal)
│   ├── settings.ts                  # Settings tab UI
│   ├── statusbar.ts                 # Status bar component
│   ├── commands.ts                  # Command palette registration
│   ├── types.ts                     # TypeScript interfaces & constants
│   │
│   ├── sync/                        # Sync engine (v2 — three-way reconciliation)
│   │   ├── SyncEngine.ts            # Thin orchestrator (~150 lines)
│   │   ├── SyncPlanner.ts           # Discovers state, classifies, builds plan
│   │   ├── SyncDecisionTable.ts     # Pure-function L/R decision matrix
│   │   ├── SyncExecutor.ts          # Bounded-concurrency plan executor
│   │   ├── SyncJournal.ts           # IndexedDB per-file baseline persistence
│   │   ├── ChangeTracker.ts         # Local dirty-paths tracker
│   │   ├── SyncScheduler.ts         # Periodic sync scheduling
│   │   ├── SyncPathCodec.ts         # Local ↔ S3 key conversion
│   │   ├── SyncObjectMetadata.ts    # S3 custom metadata encoding
│   │   └── SyncPayloadCodec.ts      # Encryption-aware content encoding
│   │
│   ├── backup/                      # Backup engine
│   │   ├── BackupScheduler.ts       # Backup scheduling with catch-up logic
│   │   ├── SnapshotCreator.ts       # Full vault snapshot creation
│   │   ├── RetentionManager.ts      # Old backup cleanup (by days/copies)
│   │   ├── BackupDownloader.ts      # Backup download as zip
│   │   └── BackupListModal.ts       # Modal UI listing recent backups with download
│   │
│   ├── storage/                     # S3 abstraction layer
│   │   ├── S3Provider.ts            # S3 operations wrapper
│   │   ├── S3Config.ts              # S3 client configuration
│   │   ├── ObsidianHttpHandler.ts   # Custom HTTP handler for Obsidian
│   │   └── ObsidianRequestHandler.ts
│   │
│   ├── crypto/                      # Encryption modules
│   │   ├── KeyDerivation.ts         # Argon2id key derivation (hash-wasm)
│   │   ├── FileEncryptor.ts         # XSalsa20-Poly1305 (tweetnacl)
│   │   ├── VaultMarker.ts           # Encryption marker file (vault.enc)
│   │   └── Hasher.ts                # SHA-256 file hashing (hash-wasm)
│   │
│   └── utils/                       # Shared utilities
│       ├── retry.ts                 # Retry with exponential backoff
│       ├── time.ts                  # Time formatting (relative times)
│       ├── paths.ts                 # Path normalization & glob matching
│       └── vaultFiles.ts            # Vault file read helpers (text/binary)
│
├── tests/                           # Unit & integration tests (Jest)
│   ├── __mocks__/                   # Obsidian API mocks
│   ├── helpers/                     # S3 test utilities
│   ├── backup/                      # Backup module tests
│   ├── crypto/                      # Crypto module tests
│   ├── storage/                     # Storage module tests
│   ├── sync/                        # Sync module tests
│   └── utils/                       # Utility tests
│
├── manifest.json
├── package.json
├── esbuild.config.mjs
└── tsconfig.json
```

### Sync Engine (v2) Architecture

The sync engine uses **three-way reconciliation** with per-file SHA-256 baselines stored in IndexedDB. No remote manifests — S3 stores only vault files and metadata.

**Data flow:** `SyncEngine` (orchestrator) → `SyncPlanner` (discover + classify + plan) → `SyncDecisionTable` (pure decision function) → `SyncExecutor` (execute with bounded concurrency).

**Key design decisions:**
- Content identity: SHA-256 fingerprint of plaintext, stored in S3 custom metadata
- ETag used as revision token only, never as content identity
- Remote mtime stored in S3 metadata as `obsidian-mtime` (epoch ms)
- Conflict policy: keep-both only (`LOCAL_`/`REMOTE_` artifacts)
- Lazy hashing: mtime+size fast-path first, SHA-256 only when ambiguous

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

- **Safe File Writes:** Use `Vault.process()` for atomic background modifications
- **Path Safety:** Always use `normalizePath()` on user inputs and file paths
- **Strict TypeScript:** Use `"strict": true`
- **Obsidian API:** Use `this.app.vault` for vault operations
- **S3 Operations:** Use `@aws-sdk/client-s3` v3
- **Local State:** Use IndexedDB (`idb` library)
- **Encryption:** `hash-wasm` (Argon2id/SHA-256) & `tweetnacl` (XSalsa20-Poly1305)
- **Performance:** Batch disk access, debounce events, keep startup light
- **Async:** Use `async/await` everywhere

### DON'Ts

- **No Global App:** Never use `window.app` or `app`. Use `this.app`
- **No `innerHTML`:** Security risk. Use DOM API (`createEl`, `setText`)
- **No Hardcoded Styles:** Use CSS classes and variables
- **No Node.js APIs:** `fs`, `path`, `crypto` DO NOT work in Obsidian (browser env)
- **No LocalStorage:** Use IndexedDB
- **No Blocking:** Never block the main thread
- **No Hardcoded Paths:** Use `settings.syncPrefix` / `settings.backupPrefix`
- **Security:** No network calls without user reason, no telemetry, no remote code execution
- **Mobile:** Do not assume desktop behavior

## Build & Test Commands

```bash
npm install             # Install dependencies
npm run dev             # Development build with watch
npm run build           # Production build (tsc + esbuild)
npm run lint            # Run ESLint (mandatory after every change)
npm run test:unit       # Run unit tests
npm run test:integration # Run integration tests (requires .env with S3 creds)
npm run test:coverage   # Unit tests with coverage report
npm run test:watch      # Watch mode
```

### Linting Rules

Uses `eslint-plugin-obsidianmd`:
- Use `Vault#configDir` instead of hardcoded `.obsidian`
- Sentence case for UI text
- Avoid unsafe casts to `TFile`/`TFolder`

### Manual Testing

1. Run `npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to: `<Vault>/.obsidian/plugins/s3-sync-and-backup/`
3. Reload Obsidian and enable in **Settings → Community plugins**

## Documentation

Over-documenting is preferred over under-documenting. Every file should be self-explanatory to someone (human or AI) reading it for the first time.

- **Every file**: JSDoc comment at the top explaining what the file does, why it exists, and how it fits into the plugin
- **Every exported function/class/interface**: JSDoc with description, `@param`, `@returns`, and a brief usage note if non-obvious
- **Every IndexedDB store**: docstring explaining the domain it manages and what triggers state changes
- **Every type/interface in `types.ts`**: comment explaining the purpose, key fields, and any non-obvious semantics
- **Config files** (`esbuild.config.mjs`, `tsconfig.json`, `jest.config.cjs`, etc.): inline comments explaining each non-default option and why it's set
- **Inline comments**: use for non-obvious logic, business rules, workarounds, or "why" explanations — not for restating what the code does
- **Test files**: every `describe` block gets a docstring explaining what module/behavior it covers; every `it`/`test` gets a clear description of the scenario and expected outcome
- **When changing code**: update all affected docstrings, comments, and JSDoc to reflect the change — stale docs are worse than no docs

## Git Workflow

- Commit early and often — one logical change per commit, never batch unrelated changes
- Run lint, type-check, and tests BEFORE committing — never commit broken code
- Use [Conventional Commits](https://www.conventionalcommits.org/) format
- Scope should match the domain: `sync`, `backup`, `crypto`, `storage`, `settings`, `statusbar`, `commands`, etc.
- Commit granularity guide:
  - New module → commit
  - Its tests → separate commit
  - IndexedDB schema change + migration → commit together
  - Sync engine logic change → commit, then its test update → separate commit
  - Bug fix + regression test → can be one commit
  - Config file changes → own commit with explanation in message body
- Write a short message body (below the subject line) when the "why" isn't obvious from the diff
- Never force-push to shared branches
- Never commit `.env`, secrets, or generated files (`node_modules`, `main.js`)

### Release & Versioning

Automated via **release-please**:
1. Merge PR with conventional commits to `main`
2. `release-please` creates a Release PR
3. Merge Release PR to publish

**Manual step:** Update `versions.json` ONLY when `minAppVersion` changes in `manifest.json`. Helper: `node scripts/version.mjs <version>`

## References

- **Obsidian API:** https://docs.obsidian.md
- **Developer Policies:** https://docs.obsidian.md/Developer+policies
- **Plugin Guidelines:** https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- **Sample Plugin:** https://github.com/obsidianmd/obsidian-sample-plugin