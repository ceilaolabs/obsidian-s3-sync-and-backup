# Obsidian S3 Sync & Backup

Bi-directional vault synchronization and scheduled backups for Obsidian with S3-compatible storage and optional end-to-end encryption.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Obsidian](https://img.shields.io/badge/Obsidian-1.0.0+-purple.svg)

## Features

- **🔄 Bi-directional Sync** — Keep your vault synchronized across devices via S3.
- **☁️ S3-Compatible Storage** — Works with AWS S3, Cloudflare R2, MinIO, and S3 compatible custom endpoints.
- **🔐 End-to-End Encryption** — Optional XSalsa20-Poly1305 encryption with Argon2id key derivation.
- **💾 Scheduled Backups** — Automatic backup snapshots with configurable intervals.
- **⚡ Smart Conflict Resolution** — Automatic `LOCAL_`/`REMOTE_` file creation for conflicts.
- **📊 Status Bar Integration** — Real-time sync and backup status at a glance.
- **🎛️ Flexible Retention** — Keep backups by days or number of copies.

---

## Installation

### From Community Plugins (Coming Soon)
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
   - **Access Key ID & Secret Access Key**.
   - **Force Path Style**: Enable for MinIO.
4. Click **Test Connection** to verify specific permissions.

### 2. Enable Sync
1. In the **Sync** section, toggle **Enable Sync**.
2. Set the **Sync Prefix** (default: `vault`) to organize files in your bucket.
3. Configure the **Sync Interval** (default: 5 minutes) and enable **Sync on Startup**.

### 3. Enable Backups (Optional but Recommended)
1. In the **Backup** section, toggle **Enable Backups**.
2. Set the **Backup Prefix** (default: `backups`).
3. Choose a **Backup Interval** (e.g., Daily).
4. Configure **Retention Policy** to auto-delete old backups (e.g., keep last 30 copies).

### 4. Enable Encryption (Optional)
> ⚠️ **Important**: If you enable encryption, you MUST remember your passphrase. There is no recovery if it is lost.

1. Toggle **Enable End-to-End Encryption**.
2. Enter a strong passphrase (you can use tools like [Bitwarden](https://bitwarden.com/password-generator/#password-generator)).
3. Use the **same passphrase** on all other devices.

---

## Settings Reference

### Connection Settings
| Setting | Description |
| :--- | :--- |
| **Provider** | AWS S3, MinIO, Cloudflare R2, or Custom. |
| **Endpoint URL** | Custom endpoint (e.g., `https://files.domain.com`). |
| **Region** | AWS Region (e.g., `us-east-1`). |
| **Force Path Style** | Required for self-hosted MinIO setups. |

### Sync Settings
| Setting | Description | Default |
| :--- | :--- | :--- |
| **Enable Sync** | Master switch for sync functionality. | On |
| **Sync Prefix** | S3 folder for synced files. | `vault` |
| **Sync Interval** | Frequency of auto-sync checks. | 5 min |

### Backup Settings
| Setting | Description | Default |
| :--- | :--- | :--- |
| **Enable Backups** | Master switch for backup functionality. | On |
| **Backup Prefix** | S3 folder for backup snapshots. | `backups` |
| **Retention Policy** | Clean up by **Age** (days) or **Count** (copies). | Copies (30) |

---

## S3 Bucket Structure
Your bucket will be organized cleanly to separate live sync data from historical backups.

```
your-bucket/
├── vault/                              # LIVE DATA (Synced)
│   ├── .obsidian-s3-sync/
│   │   └── .vault.enc                  # Encryption marker (if enabled)
│   ├── Notes/
│   │   └── my-note.md
│   └── Attachments/
│       └── image.png
│
└── backups/                            # SNAPSHOTS (Read-only)
    ├── backup-2024-12-25T14-30-00/
    │   ├── .backup-manifest.json
    │   └── ... (Full vault copy)
    └── backup-2024-12-24T14-30-00/
```

---

### 🛠️ Built with Engineering Excellence
This plugin is developed with a focus on reliability, security, and code quality. We employ **GitHub Actions** for rigorous CI/CD, including automated versioning with `release-please`, mandatory linting standards, and comprehensive testing suites. With **200+ unit tests** and real-world **integration tests** against Cloudflare R2, every release is verified for stability. Our commitment to best practices ensures your data is handled with the utmost care.

---

## FAQ

<details>
<summary><strong>Does this work on mobile?</strong></summary>
Yes! The plugin works on both iOS and Android versions of Obsidian. Note that mobile operating systems may restrict background sync, so open the app to ensure sync completes.
</details>

<details>
<summary><strong>Can I use this alongside Obsidian Sync?</strong></summary>
It is <strong>not recommended</strong>. Using two sync solutions simultaneously can cause race conditions and data conflicts. Please choose one primary sync method.
</details>

<details>
<summary><strong>How do I restore from a specific backup?</strong></summary>
Go to <strong>Settings → Recent Backups</strong>. Click the download button next to the desired timestamp. This downloads a ZIP file you can extract and manually restore files from.
</details>

<details>
<summary><strong>Why do I see LOCAL_ and REMOTE_ files?</strong></summary>
This indicates a sync conflict (the same file changed on two devices while offline). Review both files, manually merge the content into the original filename, and delete the <code>LOCAL_</code> and <code>REMOTE_</code> copies.
</details>

---

## Support & Contributing

- **Issues**: [Report bugs or request features](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/issues)
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT © [CeilãoLabs](https://github.com/ceilaolabs)

Made with ❤️ for the Obsidian community
