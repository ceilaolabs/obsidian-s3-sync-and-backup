# Obsidian S3 Sync & Backup

Vault synchronization and scheduled backups across devices using S3-compatible storage (AWS S3, MinIO, Cloudflare R2, etc.) with optional end-to-end encryption.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Obsidian](https://img.shields.io/badge/Obsidian-1.0.0+-purple.svg)

## Features

- **Bi-directional Sync** — Three-way reconciliation keeps your vault synchronized across devices via S3. Per-file SHA-256 baselines stored locally in IndexedDB detect changes accurately — no cloud manifest required.
- **S3-Compatible Storage** — Works with AWS S3, Cloudflare R2, MinIO, and any S3-compatible custom endpoint.
- **End-to-End Encryption** — Optional XSalsa20-Poly1305 encryption with Argon2id key derivation. Encrypts both synced files and backup snapshots. Passphrase can be remembered for auto-unlock on startup.
- **Scheduled Backups** — Full vault snapshot backups with configurable intervals (hourly to weekly). Download any backup as a ZIP from settings.
- **Smart Conflict Resolution** — When the same file changes on two devices while offline, the plugin creates `LOCAL_` and `REMOTE_` copies so you never lose data.
- **Status Bar Integration** — Real-time sync and backup status at a glance, with clickable actions.
- **Flexible Retention** — Automatically clean up old backups by age (days) or number of copies.
- **Plugin Settings Protection** — The plugin's own settings directory is hardcoded-excluded from sync to prevent credential or passphrase leakage.
- **Mobile Support** — Works on iOS and Android. No desktop-only APIs used.
- **Command Palette** — Sync now, Backup now, Pause/Resume sync, and more — all available from the command palette with customizable hotkeys.

---

## Installation

### From Community Plugins
1. Open **Settings** → **Community plugins**
2. Search for "S3 Sync & Backup"
3. Click **Install** then **Enable**

---

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/releases).
2. Create the folder: `<VaultPath>/.obsidian/plugins/s3-sync-and-backup/`
3. Copy the downloaded files into this folder.
4. Reload Obsidian and enable the plugin in **Settings** → **Community plugins**.

---

## Quick Start

### 1. Configure S3 Connection
1. Open **Settings** → **S3 Sync & Backup**.
2. Select your provider (**AWS S3**, **Cloudflare R2**, **MinIO**, or **Custom**).
3. Enter your credentials:
   - **Endpoint URL**: Required for non-AWS providers.
   - **Region**: Use `auto` for Cloudflare R2.
   - **Bucket name**: Your S3 bucket.
   - **Access Key ID** & **Secret Access Key**.
   - **Force Path Style**: Enable for MinIO and some custom endpoints.
4. Click **Test Connection** to verify credentials and bucket access.

### 2. Enable Sync
1. In the **Sync** section, toggle **Enable sync** (on by default).
2. Set the **Sync prefix** (default: `vault`) — this is the S3 folder where your files live.
3. Toggle **Auto-sync** and choose a **Sync interval** (1 min to 30 min, default: 5 min).
4. Enable **Sync on startup** to sync immediately when Obsidian opens.

### 3. Enable Backups (Optional but Recommended)
1. In the **Backup** section, toggle **Enable backups** (on by default).
2. Set the **Backup prefix** (default: `backups`).
3. Choose a **Backup interval** (every hour, 6 hours, 12 hours, daily, every 3 days, or weekly).
4. Enable **Retention** and configure a policy to auto-delete old backups.
5. Use **Backup now** for an immediate snapshot at any time.

### 4. Enable Encryption (Optional)
> ⚠️ **Important**: If you enable encryption, you MUST remember your passphrase. There is no recovery if it is lost.

1. Toggle **Enable end-to-end encryption**.
2. Enter a strong passphrase (minimum 8 characters — a strength indicator guides you).
3. Optionally enable **Remember passphrase** to auto-unlock the vault on startup.
4. Use the **same passphrase** on all devices syncing this vault.

When encryption is enabled:
- All synced files are encrypted before upload to S3.
- All backup snapshots are encrypted (the backup manifest remains plain JSON for metadata).
- Other devices detect the encryption state automatically and prompt for the passphrase.
- Disabling encryption re-uploads all files as plaintext (with a confirmation dialog).

---

## Settings Reference

### Connection

| Setting | Description |
| :--- | :--- |
| **Provider** | Storage provider: AWS S3, MinIO, Cloudflare R2, or Custom. |
| **Endpoint URL** | S3-compatible endpoint URL. Required for non-AWS providers (e.g., `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` for R2, `http://localhost:9000` for MinIO). Hidden when provider is AWS. |
| **Region** | AWS region (e.g., `us-east-1`). Use `auto` for Cloudflare R2. |
| **Bucket** | Name of your S3 bucket. |
| **Access key ID** | Your S3 access key ID. Displayed as a password field. |
| **Secret access key** | Your S3 secret access key. Displayed as a password field. |
| **Force path style** | Use path-style URLs instead of virtual-hosted. Required for MinIO and some custom endpoints. Only shown for MinIO and Custom providers. |
| **Test connection** | Verify credentials, bucket access, and required permissions. |

### Encryption

| Setting | Description |
| :--- | :--- |
| **Enable end-to-end encryption** | Encrypt all files with XSalsa20-Poly1305 before uploading to S3. Requires a passphrase (minimum 8 characters). Shows a strength indicator while typing. |
| **Remember passphrase** | Save the passphrase locally so the vault unlocks automatically on startup. The passphrase is stored in the plugin's `data.json`, which is hardcoded-excluded from sync. |
| **Unlock** | When the vault is encrypted but locked (e.g., after restarting Obsidian without "Remember passphrase"), enter your passphrase to unlock sync and backup. |
| **Disable encryption** | Re-upload all files as plaintext and remove the encryption marker. Shows a confirmation dialog. Other devices switch to plaintext mode automatically on next sync. |

### Sync

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Enable sync** | Master switch for bi-directional vault synchronization. | On |
| **Sync prefix** | S3 folder path for synced files (e.g., `vault` → `s3://bucket/vault/`). | `vault` |
| **Auto-sync** | Automatically sync at regular intervals. | On |
| **Sync interval** | How often to auto-sync. Options: 1, 2, 5, 10, 15, or 30 minutes. Only shown when auto-sync is enabled. | 5 min |
| **Sync on startup** | Run a sync immediately when Obsidian starts. | On |

### Backup

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Enable backups** | Master switch for scheduled vault backup snapshots. | On |
| **Backup prefix** | S3 folder path for backups (e.g., `backups` → `s3://bucket/backups/`). | `backups` |
| **Backup interval** | How often to create snapshots. Options: every hour, 6 hours, 12 hours, daily, every 3 days, or weekly. | Daily |
| **Enable retention** | Automatically delete old backups based on the retention policy. | Off |
| **Retention mode** | How to determine which backups to keep: **By days** (delete backups older than N days) or **By copies** (keep only the latest N backups). Only shown when retention is enabled. | By copies |
| **Retention days** | Delete backups older than this many days (1–360). Only shown in "By days" mode. | 30 |
| **Retention copies** | Keep only the latest N backups (1–1000). Only shown in "By copies" mode. | 30 |
| **Backup now** | Create a backup snapshot immediately. |  |
| **View backups** | Open a modal listing the 5 most recent backups with per-backup download buttons. Each entry shows timestamp, file count, size, and encryption status. |  |

### Advanced

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Debug logging** | Enable verbose console logging for troubleshooting. | Off |
| **Exclude patterns** | Comma-separated glob patterns for files/folders to exclude from sync (e.g., `workspace*, .trash/*`). The plugin's own settings directory is always excluded regardless of this setting. | `**/workspace*, .trash/**` |
| **Reset to defaults** | Reset all settings to defaults, preserving S3 connection credentials. Shows a confirmation dialog. |  |

---

## Command Palette

All commands are available via the Obsidian command palette (`Ctrl/Cmd + P`) and can be bound to custom hotkeys.

| Command | Description |
| :--- | :--- |
| **S3 Sync & Backup: Sync now** | Trigger an immediate sync. |
| **S3 Sync & Backup: Backup now** | Trigger an immediate backup snapshot. |
| **S3 Sync & Backup: Pause sync** | Pause automatic sync (shown only when sync and auto-sync are enabled). |
| **S3 Sync & Backup: Resume sync** | Resume automatic sync after pausing. |
| **S3 Sync & Backup: View sync log** | Open the sync log viewer. |
| **S3 Sync & Backup: View backups** | Open a modal listing recent backups with download buttons. |
| **S3 Sync & Backup: Open settings** | Open the plugin settings page. |

---

## Multi-Device Sync

This plugin is designed for multi-device use. Each device gets a unique ID on first run, and all S3 uploads are tagged with the writing device's ID.

**How it works:**
- Each device maintains its own local sync journal (IndexedDB) with per-file baselines.
- On sync, the engine compares local state, remote state (S3), and the last-known baseline to determine what changed and where.
- If the same file changed on two devices while both were offline, a **conflict** is created with `LOCAL_` and `REMOTE_` copies of the file.

**Encryption across devices:**
- When encryption is enabled on one device, other devices detect the encrypted state on next sync and prompt for the passphrase.
- Use the same passphrase on all devices. If the wrong passphrase is entered, the plugin notifies you and clears any saved passphrase.
- Encryption enable/disable operations use an advisory lock to prevent two devices from migrating simultaneously.

---

## S3 Bucket Structure

```
your-bucket/
├── vault/                              # LIVE DATA (synced)
│   ├── .obsidian-s3-sync/
│   │   └── .vault.enc                  # Encryption marker (if enabled)
│   ├── Notes/
│   │   └── my-note.md
│   └── Attachments/
│       └── image.png
│
└── backups/                            # SNAPSHOTS (read-only)
    ├── backup-2024-12-25T14-30-00/
    │   ├── .backup-manifest.json       # Plain JSON: file count, checksums, encrypted flag
    │   └── ... (full vault copy)
    └── backup-2024-12-24T14-30-00/
```

> **Note:** The plugin's own settings directory (`.obsidian/plugins/s3-sync-and-backup/`) is never uploaded to S3, regardless of exclude pattern configuration.

---

## Security

- **Encryption algorithm:** XSalsa20-Poly1305 (via tweetnacl) with Argon2id key derivation (via hash-wasm).
- **Content identity:** SHA-256 fingerprints of plaintext content, stored in S3 custom metadata.
- **No telemetry:** The plugin makes no network calls except to your configured S3 endpoint.
- **No remote code execution:** All encryption and hashing runs locally in the browser.
- **Credential protection:** S3 credentials and saved passphrases are stored in Obsidian's `data.json`, which is hardcoded-excluded from sync to prevent leakage.

---

### Testing

The plugin includes 565+ automated tests: unit tests covering sync, encryption, backup, and utility modules, pipeline end-to-end tests, and integration tests against live S3 endpoints. CI runs linting, type-checking, and the full test suite on every pull request.

---

## FAQ

<details>
<summary><strong>Does this work on mobile?</strong></summary>
Yes! The plugin works on both iOS and Android versions of Obsidian. No desktop-only APIs are used. Note that mobile operating systems may restrict background activity, so open the app periodically to ensure sync completes.
</details>

<details>
<summary><strong>Can I use this alongside Obsidian Sync?</strong></summary>
It is <strong>not recommended</strong>. Using two sync solutions simultaneously can cause race conditions and data conflicts. Choose one primary sync method.
</details>

<details>
<summary><strong>How do I restore from a backup?</strong></summary>
Go to <strong>Settings → S3 Sync & Backup → Backup → View backups</strong>, or use the <strong>View backups</strong> command from the command palette. The modal lists the 5 most recent backups — click "Download zip" to export one as a ZIP file. Extract it and manually copy files back into your vault.
</details>

<details>
<summary><strong>Why do I see LOCAL_ and REMOTE_ files?</strong></summary>
This means the same file changed on two devices while both were offline (a sync conflict). Open both files, manually merge the content into the original filename, then delete the <code>LOCAL_</code> and <code>REMOTE_</code> copies. The conflict resolves on the next sync.
</details>

<details>
<summary><strong>Are my backups encrypted?</strong></summary>
Yes — when encryption is enabled and the vault is unlocked, all backup files are encrypted before upload. The backup manifest (<code>.backup-manifest.json</code>) is always plain JSON so the plugin can read backup metadata, but it contains only file names, checksums, and the <code>encrypted</code> flag — no file content.
</details>

<details>
<summary><strong>What happens if I forget my passphrase?</strong></summary>
There is <strong>no recovery</strong>. The passphrase is never sent to S3. If you lose it, encrypted files in S3 cannot be decrypted. Always use a password manager to store your passphrase securely.
</details>

<details>
<summary><strong>Can I change the sync or backup prefix after setup?</strong></summary>
Yes, but existing files under the old prefix won't be moved. The plugin will treat the new prefix as a fresh location. You'd need to manually move or re-sync files if you change prefixes.
</details>

<details>
<summary><strong>What files are excluded from sync?</strong></summary>
By default, <code>**/workspace*</code> and <code>.trash/**</code> are excluded. You can customize this in <strong>Settings → Advanced → Exclude patterns</strong>. The plugin's own settings directory (<code>.obsidian/plugins/s3-sync-and-backup/</code>) is always excluded and cannot be overridden.
</details>

---

## Support & Contributing

- **Issues**: [Report bugs or request features](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/issues)
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT © [Ceilão Labs](https://github.com/ceilaolabs)

Made with love for the Obsidian community
