# Obsidian S3 Sync & Backup

Bi-directional vault synchronization and scheduled backups for Obsidian with S3-compatible storage and optional end-to-end encryption.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0+-purple.svg)

## Features

- **🔄 Bi-directional Sync** — Keep your vault synchronized across devices via S3
- **☁️ S3-Compatible Storage** — Works with AWS S3, Cloudflare R2, MinIO, and custom endpoints
- **🔐 End-to-End Encryption** — Optional AES encryption with Argon2id key derivation
- **💾 Scheduled Backups** — Automatic backup snapshots with configurable intervals
- **⚡ Smart Conflict Resolution** — Automatic LOCAL_/REMOTE_ file creation for conflicts
- **📊 Status Bar Integration** — Real-time sync and backup status at a glance
- **🎛️ Flexible Retention** — Keep backups by days or number of copies

## Supported Providers

| Provider | Status |
|----------|--------|
| AWS S3 | ✅ Supported |
| Cloudflare R2 | ✅ Supported |
| MinIO | ✅ Supported |
| Custom S3-Compatible | ✅ Supported |

## Installation

### From Community Plugins (Coming Soon)

1. Open **Settings** → **Community plugins**
2. Search for "S3 Sync & Backup"
3. Click **Install** then **Enable**

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/releases)
2. Create folder `<vault>/.obsidian/plugins/obsidian-s3-sync-and-backup/`
3. Copy the downloaded files into this folder
4. Enable the plugin in **Settings** → **Community plugins**

## Quick Start

### 1. Configure S3 Connection

1. Open **Settings** → **S3 Sync & Backup**
2. Select your provider (AWS S3, Cloudflare R2, MinIO, or Custom)
3. Enter your credentials:
   - **Endpoint URL** (for R2/MinIO/Custom)
   - **Region** (use `auto` for Cloudflare R2)
   - **Bucket name**
   - **Access Key ID**
   - **Secret Access Key**
4. Click **Test Connection** to verify

### 2. Enable Sync

1. Toggle **Enable Sync** in the Sync section
2. Configure sync interval (1–30 minutes)
3. Optionally enable **Sync on Startup**

### 3. Enable Backups (Optional)

1. Toggle **Enable Backups** in the Backup section
2. Set backup interval (hourly to weekly)
3. Configure retention policy (by days or copies)

### 4. Enable Encryption (Optional)

> ⚠️ **Important**: If you lose your passphrase, your data cannot be recovered!

1. Toggle **Enable End-to-End Encryption**
2. Enter a strong passphrase (12+ characters recommended)
3. The same passphrase must be used on all devices

## S3 Bucket Structure

```
your-bucket/
├── vault/                          # Synced vault files
│   ├── Notes/
│   │   └── my-note.md
│   └── .obsidian-s3-sync/
│       └── .vault.enc              # Encryption marker (if enabled)
└── backups/                        # Backup snapshots
    └── backup-2024-12-25T14-30-00/
        ├── .backup-manifest.json
        └── Notes/
            └── my-note.md
```

## Commands

Access these via the Command Palette (`Ctrl/Cmd + P`):

| Command | Description |
|---------|-------------|
| **Sync now** | Trigger immediate sync |
| **Backup now** | Create backup snapshot |
| **Pause sync** | Pause automatic sync |
| **Resume sync** | Resume automatic sync |
| **Open settings** | Open plugin settings |

## Conflict Resolution

When the same file is modified on multiple devices while offline, a conflict occurs. The plugin handles this by:

1. Renaming the local version to `LOCAL_filename.md`
2. Downloading the remote version as `REMOTE_filename.md`
3. Showing a notification to alert you

You can then manually merge the changes and delete the conflict files.

## Security

### Encryption Details

- **Algorithm**: XSalsa20-Poly1305 (via TweetNaCl)
- **Key Derivation**: Argon2id with OWASP-recommended parameters
- **File Hashing**: SHA-256

### Best Practices

- Use a strong, unique passphrase
- Store your passphrase securely (password manager)
- Keep local backups of critical data
- Use IAM policies to limit S3 access

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone https://github.com/ceilaolabs/obsidian-s3-sync-and-backup.git
cd obsidian-s3-sync-and-backup
npm install
```

### Build

```bash
npm run build   # Production build
npm run dev     # Development with watch mode
```

### Lint

```bash
npm run lint
```

### Project Structure

```
src/
├── main.ts              # Plugin entry point
├── settings.ts          # Settings UI
├── statusbar.ts         # Status bar component
├── types.ts             # TypeScript interfaces
├── storage/             # S3 operations
├── sync/                # Sync engine & journal
├── backup/              # Backup system
├── crypto/              # Encryption modules
└── utils/               # Utilities
```

## FAQ

<details>
<summary><strong>Does this work on mobile?</strong></summary>

Yes! The plugin is designed to work on both desktop and mobile versions of Obsidian. However, sync on mobile may be affected by iOS/Android background restrictions.
</details>

<details>
<summary><strong>Can I use this with Obsidian Sync?</strong></summary>

It's not recommended to use both simultaneously as they may conflict. Choose one sync solution for your vault.
</details>

<details>
<summary><strong>What happens if I forget my passphrase?</strong></summary>

Your encrypted data cannot be recovered without the passphrase. Always store your passphrase securely.
</details>

<details>
<summary><strong>How much does S3 storage cost?</strong></summary>

Costs vary by provider. Cloudflare R2 offers free egress. AWS S3 charges for storage and data transfer. For a typical vault, expect $0.50–$2/month.
</details>

## Support

- 🐛 [Report a bug](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/issues)
- 💡 [Request a feature](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/issues)
- 📖 [Documentation](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/wiki)

## License

MIT © [Sathindu](https://github.com/ceilaolabs)

---

Made with ❤️ for the Obsidian community
