# Obsidian S3 Sync & Backup

Bi-directional vault synchronization and scheduled backups for Obsidian with S3-compatible storage and optional end-to-end encryption.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0+-purple.svg)

## Features

- **🔄 Bi-directional Sync** — Keep your vault synchronized across devices via S3
- **☁️ S3-Compatible Storage** — Works with AWS S3, Cloudflare R2, MinIO, and custom endpoints
- **🔐 End-to-End Encryption** — Optional XSalsa20-Poly1305 encryption with Argon2id key derivation
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
   - **Endpoint URL** (required for R2/MinIO/Custom)
   - **Region** (use `auto` for Cloudflare R2)
   - **Bucket name**
   - **Access Key ID**
   - **Secret Access Key**
   - **Force Path Style** (enable for MinIO)
4. Click **Test Connection** to verify

### 2. Enable Sync

1. Toggle **Enable Sync** in the Sync section
2. Set the **Sync Prefix** (default: `vault`) — the S3 path where vault files are stored
3. Configure **Sync Interval** (1, 2, 5, 10, 15, or 30 minutes)
4. Optionally enable **Sync on Startup**

### 3. Enable Backups (Optional)

1. Toggle **Enable Backups** in the Backup section
2. Set the **Backup Prefix** (default: `backups`) — the S3 path for backup snapshots
3. Configure **Backup Interval**:
   - Every hour
   - Every 6 hours
   - Every 12 hours
   - Daily (24h) — default
   - Every 3 days
   - Weekly
4. Configure **Retention Policy** (optional):
   - **By Days**: Delete backups older than X days (1–360)
   - **By Copies**: Keep only the latest X backups (1–1000)

### 4. Enable Encryption (Optional)

> ⚠️ **Important**: If you lose your passphrase, your data cannot be recovered!

1. Toggle **Enable End-to-End Encryption**
2. Enter a strong passphrase (12+ characters recommended)
3. The same passphrase must be used on all devices

## Settings Options

### Connection Settings

| Setting | Description |
|---------|-------------|
| Provider | Select S3 provider (AWS S3, MinIO, Cloudflare R2, Custom) |
| Endpoint URL | Custom endpoint URL (required for MinIO/R2/Custom) |
| Region | AWS region (use `auto` for R2) |
| Bucket | S3 bucket name |
| Access Key ID | Your access key |
| Secret Access Key | Your secret key |
| Force Path Style | Enable for MinIO and some S3-compatible services |

### Sync Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Enable Sync | Turn sync on/off | On |
| Sync Prefix | S3 path prefix for vault files | `vault` |
| Auto-sync | Enable periodic automatic sync | On |
| Sync Interval | Time between auto-syncs | 5 minutes |
| Sync on Startup | Sync when Obsidian launches | On |

### Backup Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Enable Backups | Turn backups on/off | On |
| Backup Prefix | S3 path prefix for backups | `backups` |
| Backup Interval | Time between backups | Daily (24h) |
| Enable Retention | Auto-delete old backups | Off |
| Retention Mode | Delete by age or by count | By Copies |
| Retention Days | Keep backups for X days | 30 |
| Retention Copies | Keep last X backups | 30 |

### Advanced Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Exclude Patterns | Glob patterns to exclude from sync | `workspace*`, `.trash/*` |
| Debug Logging | Enable verbose logging | Off |

## S3 Bucket Structure

```
your-bucket/
├── vault/                              # Synced vault files (sync prefix)
│   ├── .obsidian-s3-sync/
│   │   ├── vault.enc                   # Encryption marker (if enabled)
│   │   ├── journal.json                # Sync state backup
│   │   └── device-registry.json        # Known devices
│   ├── Notes/
│   │   └── my-note.md
│   ├── Attachments/
│   │   └── image.png
│   └── .obsidian/
│       └── (synced config)
│
└── backups/                            # Backup snapshots (backup prefix)
    ├── backup-2024-12-25T14-30-00/
    │   ├── .backup-manifest.json       # Backup metadata
    │   ├── Notes/
    │   │   └── my-note.md
    │   └── Attachments/
    │       └── image.png
    └── backup-2024-12-24T14-30-00/
        └── ...
```

## Commands

Access these via the Command Palette (`Ctrl/Cmd + P`):

| Command | Description |
|---------|-------------|
| **Sync now** | Trigger immediate sync |
| **Backup now** | Create backup snapshot |
| **Pause sync** | Pause automatic sync |
| **Resume sync** | Resume automatic sync |
| **View sync log** | View sync history |
| **View backups** | Open backup list in settings |
| **Open settings** | Open plugin settings |

## Status Bar

The status bar shows sync and backup status:

```
[Sync: ✓ 2m ago | Backup: ✓ 3h ago]
```

**Status Icons:**

| Icon | Meaning |
|------|---------|
| ✓ | Completed successfully |
| ↻ | In progress |
| ! | Error occurred |
| ⚠ | Has conflicts (sync only) |
| ○ | Disabled |
| ⏸ | Paused (sync only) |

**Interactions:**
- **Left-click Sync** → Trigger manual sync
- **Left-click Backup** → Trigger manual backup
- **Hover** → Show detailed tooltip

## Conflict Resolution

When the same file is modified on multiple devices while offline, a conflict occurs. The plugin handles this by:

1. Renaming the local version to `LOCAL_filename.md`
2. Downloading the remote version as `REMOTE_filename.md`
3. Showing a notification to alert you

**Example:**
```
Original:   Notes/meeting.md
Local:      Notes/LOCAL_meeting.md   (this device's version)
Remote:     Notes/REMOTE_meeting.md  (other device's version)
```

**To resolve:**
1. Compare both LOCAL_ and REMOTE_ versions
2. Create a merged `meeting.md` with the combined changes
3. Delete the LOCAL_ and REMOTE_ files
4. The merged file will sync on the next sync cycle

## Security

### Encryption Details

- **Algorithm**: XSalsa20-Poly1305 (AEAD via TweetNaCl)
- **Key Derivation**: Argon2id with OWASP-recommended parameters
- **File Hashing**: SHA-256 (via hash-wasm)
- **Zero-knowledge**: S3 provider cannot read encrypted content

### Best Practices

- Use a strong, unique passphrase (12+ characters)
- Store your passphrase securely (password manager recommended)
- Keep local backups of critical data
- Use IAM policies to limit S3 bucket access

### Minimal S3 IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-bucket-name",
        "arn:aws:s3:::your-bucket-name/*"
      ]
    }
  ]
}
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

Your encrypted data cannot be recovered without the passphrase. This is by design for security. Always store your passphrase securely in a password manager.
</details>

<details>
<summary><strong>How much does S3 storage cost?</strong></summary>

Costs vary by provider:
- **Cloudflare R2**: Free egress, ~$0.015/GB storage
- **AWS S3**: ~$0.023/GB storage + data transfer fees
- **MinIO**: Self-hosted, only your infrastructure costs

For a typical vault (~100MB), expect $0.50–$2/month on commercial providers.
</details>

<details>
<summary><strong>What's the difference between sync and backup?</strong></summary>

- **Sync** keeps your vault mirrored across devices in real-time. Changes are bi-directional.
- **Backup** creates point-in-time snapshots for disaster recovery. Backups are separate copies you can restore from.
</details>

<details>
<summary><strong>How do I restore from a backup?</strong></summary>

Currently, you can download backups from the settings panel. Download the backup zip, then manually extract it to replace or merge with your vault contents.
</details>

<details>
<summary><strong>Why do I see LOCAL_ and REMOTE_ files?</strong></summary>

These appear when a sync conflict occurs (same file edited on multiple devices while offline). Compare both versions, merge your changes into a new file, then delete the LOCAL_ and REMOTE_ versions.
</details>

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Development setup instructions
- Project structure
- Testing guidelines
- Commit message conventions
- Pull request process

## Support

- 🐛 [Report a bug](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/issues)
- 💡 [Request a feature](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/issues)
- 📖 [Documentation](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/wiki)

## License

MIT © [CeilãoLabs](https://github.com/ceilaolabs)

---

Made with ❤️ for the Obsidian community
