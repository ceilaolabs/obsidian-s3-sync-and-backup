# AGENTS.md

## Project Overview

**Obsidian S3 Sync & Backup** — An Obsidian community plugin that provides bi-directional vault synchronization and scheduled backups for S3-compatible storage (AWS S3, MinIO, Cloudflare R2) with optional end-to-end encryption.

**Plugin ID:** `obsidian-s3-sync-and-backup`

## Agent Workflow & Mindset

### 🛠️ Workflow
**Linting is mandatory.**
- After **every** code modification or refactoring step, you must run:
  ```bash
  npm run lint
  ```
- You must fix any linting errors immediately. Do not leave them for later.

### 🧠 Mindset & Quality
**Code Perfection is a Myth.**
- **Don't assume existing code is perfect.** Scrutinize it. If you see a bad pattern, fix it.
- **Test Design:** Design tests based on *requirements* and *logic*, not just to mirror the current implementation.
- **Fix the Code, Don't Hack the Test:** If a correctly designed test fails, it means the *code* is broken. Fix the code. **Never** overfit or weaken a test just to make it pass a buggy implementation.
- **Root Cause Analysis:** When a bug is found, fix the root cause. Don't just patch it to work with existing bad patterns.

## Quick Context

| Attribute | Value |
|-----------|-------|
| Type | Obsidian Community Plugin |
| Language | TypeScript (strict mode) |
| Runtime | Browser (NO Node.js APIs) |
| Package Manager | npm |
| Bundler | esbuild |
| Output | `main.js`, `manifest.json`, `styles.css` |

## Build Commands

```bash
npm install      # Install dependencies
npm run dev      # Development build with watch
npm run build    # Production build
npm run lint     # Run ESLint
npm run test     # Run unit tests
```

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
├── tests/                       # Unit tests (Jest)
│   ├── __mocks__/
│   ├── crypto/
│   ├── sync/
│   └── utils/
│
├── manifest.json
├── package.json
├── esbuild.config.mjs
└── tsconfig.json
```

## S3 Bucket Structure

```
s3://bucket/
├── {syncPrefix}/                     # default: "vault"
│   ├── .obsidian-s3-sync/
│   │   ├── vault.enc                 # Encryption marker + salt
│   │   ├── journal.json              # Sync state backup
│   │   └── device-registry.json      # Known devices
│   └── [vault files mirrored here]
│
└── {backupPrefix}/                   # default: "backups"
    └── backup-{ISO_TIMESTAMP}/
        ├── [full vault snapshot]
        └── .backup-manifest.json
```

## Testing

```bash
npm run test           # Run all tests
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage
```

Manual install for testing:
1. Run `npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to: `<Vault>/.obsidian/plugins/obsidian-s3-sync-and-backup/`
3. Reload Obsidian and enable in **Settings → Community plugins**

## Linting

```bash
npm run lint
```

Uses `eslint-plugin-obsidianmd` for Obsidian-specific rules:
- Use `Vault#configDir` instead of hardcoded `.obsidian`
- Sentence case for UI text
- Avoid unsafe casts to `TFile`/`TFolder`

**Always fix linting errors before committing.**

## Commit Messages

This project uses **Conventional Commits** and **release-please** for automated releases.

```
<type>(<scope>): <subject>
```

**Types:**
- `feat:` New feature (minor bump)
- `fix:` Bug fix (patch bump)
- `docs:` Documentation
- `refactor:` Code refactoring
- `perf:` Performance
- `test:` Tests
- `chore:` Maintenance

**See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.**

## DO

**Documentation & Code Quality:**
- Document everything with JSDoc comments
- Use TypeScript with `"strict": true`
- Keep functions small and focused

**Obsidian Plugin Patterns:**
- Keep `main.ts` minimal — delegate to modules
- Split files at ~200-300 lines
- Use `this.registerEvent()`, `this.registerInterval()` for auto-cleanup
- Use `this.loadData()` / `this.saveData()` for settings persistence
- Use stable command IDs — never rename after release
- Provide sensible defaults for all settings

**Technical:**
- Use Obsidian API for vault operations (`this.app.vault`)
- Use `@aws-sdk/client-s3` v3 for S3 operations
- Use IndexedDB for local state persistence (`idb` library)
- Use `hash-wasm` for Argon2id AND SHA-256
- Use `tweetnacl` for XSalsa20-Poly1305 encryption
- Use configurable prefixes for all S3 paths
- Handle errors gracefully with retry logic
- Use `async/await` over promise chains

**Performance:**
- Keep startup light — defer heavy work
- Avoid long-running tasks during `onload`
- Batch disk access, avoid excessive vault scans
- Debounce/throttle file system event handlers

## DON'T

**Technical Restrictions:**
- Don't use Node.js APIs (`fs`, `path`, `crypto` module) — runs in browser
- Don't use `localStorage` — use IndexedDB instead
- Don't store passphrase — only derived key in memory
- Don't block main thread — use async/await
- Don't hardcode paths — use `settings.syncPrefix` and `settings.backupPrefix`

**Development Practices:**
- Don't over-engineer — add complexity only when justified
- Don't skip error handling
- Don't assume network availability — handle offline gracefully
- Don't commit build artifacts (`node_modules/`, `main.js`)

**Security & Privacy:**
- Don't make network calls without clear user-facing reason
- Don't add hidden telemetry
- Don't execute remote code
- Don't access files outside the vault

## Mobile Considerations

- Test on iOS and Android where feasible
- Don't assume desktop-only behavior
- Be mindful of memory constraints
- Set `isDesktopOnly: true` in manifest if desktop-only features required

## Versioning

**Automated via release-please.** Don't manually update versions.

1. Use conventional commits when merging to main
2. release-please creates a Release PR with version bumps and CHANGELOG
3. Merge Release PR to publish GitHub release

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Plugin doesn't load | Ensure `main.js` and `manifest.json` at plugin folder root |
| Build issues | Run `npm run build`, check for TypeScript errors |
| Commands not appearing | Verify `addCommand` runs in `onload`, IDs are unique |
| Settings not persisting | Ensure `loadData`/`saveData` are awaited |

## References

- **PRD:** See `obsidian-s3-sync-and-backup.md` for complete requirements
- **Obsidian API:** https://docs.obsidian.md
- **Developer Policies:** https://docs.obsidian.md/Developer+policies
- **Plugin Guidelines:** https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- **Sample Plugin:** https://github.com/obsidianmd/obsidian-sample-plugin