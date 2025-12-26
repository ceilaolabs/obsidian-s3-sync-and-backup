# AGENTS.md

## Project Overview

**Obsidian S3 Sync & Backup** — An Obsidian community plugin that provides bi-directional vault synchronization and scheduled backup snapshots to S3-compatible storage (AWS S3, MinIO, Cloudflare R2) with optional end-to-end encryption.

**Plugin ID:** `obsidian-s3-sync-and-backup`

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
```

## Project Structure

```
obsidian-s3-sync-and-backup/
├── src/
│   ├── main.ts                  # Plugin entry point (keep minimal)
│   ├── settings.ts              # Settings tab UI
│   ├── statusbar.ts             # Status bar component
│   ├── commands.ts              # Command palette registration
│   │
│   ├── sync/                    # Sync engine modules
│   │   ├── SyncEngine.ts
│   │   ├── SyncScheduler.ts
│   │   ├── ChangeTracker.ts
│   │   ├── DiffEngine.ts
│   │   ├── ConflictHandler.ts
│   │   └── SyncJournal.ts
│   │
│   ├── backup/                  # Backup engine modules
│   │   ├── BackupEngine.ts
│   │   ├── BackupScheduler.ts
│   │   ├── SnapshotCreator.ts
│   │   ├── RetentionManager.ts
│   │   ├── BackupDownloader.ts
│   │   └── BackupRegistry.ts
│   │
│   ├── storage/                 # S3 abstraction
│   │   ├── S3Provider.ts
│   │   └── S3Config.ts
│   │
│   ├── crypto/                  # Encryption
│   │   ├── KeyDerivation.ts
│   │   ├── FileEncryptor.ts
│   │   └── VaultMarker.ts
│   │
│   ├── utils/                   # Shared utilities
│   │   ├── retry.ts
│   │   ├── time.ts
│   │   └── paths.ts
│   │
│   └── types.ts                 # Shared TypeScript interfaces
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
│   │   ├── vault.enc                 # Encryption marker
│   │   └── journal.json              # Sync state
│   └── [vault files mirrored here]
│
└── {backupPrefix}/                   # default: "backups"
    └── backup-{ISO_TIMESTAMP}/
        ├── [full vault snapshot]
        └── .backup-manifest.json
```

## Testing

Manual install for testing:
1. Run `npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` to: `<Vault>/.obsidian/plugins/obsidian-s3-sync-and-backup/`
3. Reload Obsidian and enable in **Settings → Community plugins**

## DO

**Documentation & Code Quality:**
- Document everything — prefer over-documenting over under-documenting
- Add JSDoc comments to all public functions and interfaces
- Use TypeScript with `"strict": true`
- Follow clean code principles, keep functions small and focused

**Obsidian Plugin Patterns:**
- Keep `main.ts` minimal — only lifecycle management, delegate to modules
- Split files at ~200-300 lines into smaller, focused modules
- Use `this.registerEvent()`, `this.registerInterval()`, `this.registerDomEvent()` for auto-cleanup
- Persist settings using `this.loadData()` / `this.saveData()`
- Use stable command IDs — never rename after release
- Provide sensible defaults for all settings

**Technical:**
- Use Obsidian API for all vault operations (`this.app.vault`)
- Use `@aws-sdk/client-s3` v3 for S3 operations
- Use IndexedDB for local state persistence
- Use `hash-wasm` for Argon2id key derivation AND SHA-256 file hashing
- Use `tweetnacl` for XSalsa20-Poly1305 encryption (~7KB, pure JS, audited)
- Use configurable prefixes for all S3 paths (never hardcode)
- Handle errors gracefully — retry transient failures, show user-friendly messages
- Use `async/await` over promise chains

**Performance:**
- Keep startup light — defer heavy work until needed
- Avoid long-running tasks during `onload`
- Batch disk access, avoid excessive vault scans
- Debounce/throttle expensive operations on file system events

## DON'T

**Technical Restrictions:**
- Don't use Node.js APIs (`fs`, `path`, `crypto` module) — runs in browser
- Don't use `localStorage` — use IndexedDB instead
- Don't store passphrase — only derived key in memory, clear on unload
- Don't block main thread — use async/await for all I/O
- Don't hardcode paths — use `settings.syncPrefix` and `settings.backupPrefix`

**Development Practices:**
- Don't over-engineer — add complexity only when justified
- Don't skip error handling — every async operation needs failure handling
- Don't assume network availability — handle offline gracefully
- Don't commit build artifacts (`node_modules/`, `main.js`) to version control

**Security & Privacy:**
- Don't make network calls without clear user-facing reason
- Don't add hidden telemetry — require explicit opt-in if needed
- Don't execute remote code or auto-update outside normal releases
- Don't access files outside the vault

## Mobile Considerations

- Test on iOS and Android where feasible
- Don't assume desktop-only behavior
- Avoid large in-memory structures — be mindful of memory constraints
- If desktop-only features are required, set `isDesktopOnly: true` in manifest

## Versioning & Releases

- Bump `version` in `manifest.json` (SemVer: `x.y.z`)
- Update `versions.json` to map plugin version → minimum app version
- Create GitHub release with tag matching version exactly (no `v` prefix)
- Attach `manifest.json`, `main.js`, `styles.css` as release assets

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