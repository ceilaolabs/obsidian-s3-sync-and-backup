# Obsidian S3 Sync & Backup - Product Requirements Document

## Overview

**Product Name:** Obsidian S3 Sync & Backup  
**Plugin ID:** obsidian-s3-sync-and-backup  
**Repository:** github.com/ceilaolabs/obsidian-s3-sync-and-backup 
**Version:** 1.0.0  
**Author:** Sathindu  
**Last Updated:** December 2025

### Vision

A lightweight, secure Obsidian plugin that provides bi-directional vault synchronization AND scheduled backups with S3-compatible storage services. Users can sync their vaults across multiple devices and maintain point-in-time backup snapshots using their own cloud storage (AWS S3, MinIO, Cloudflare R2) with optional end-to-end encryption.

### Problem Statement

Existing solutions either:
- Require proprietary cloud services (Obsidian Sync)
- Focus only on sync without backup snapshots
- Lack robust encryption
- Are overly complex for simple use cases

This plugin provides **simple periodic sync + scheduled backups** with S3-compatible storage users control.

---

## Target Users

| User Type | Description | Primary Need |
|-----------|-------------|--------------|
| **Privacy-conscious users** | Want full control over their data | End-to-end encryption with self-hosted storage |
| **Multi-device users** | Use Obsidian on desktop, laptop, mobile | Reliable bi-directional sync |
| **Backup-focused users** | Want point-in-time recovery | Scheduled snapshots with retention |
| **Self-hosters** | Run MinIO or similar on home servers | S3-compatible API support |

---

## S3 Bucket Structure

```
s3://my-bucket/
├── vault/                              # Sync prefix (configurable, default: "vault")
│   ├── .obsidian-s3-sync/
│   │   ├── vault.enc                   # Encryption marker + salt
│   │   ├── journal.json                # Sync state backup
│   │   └── device-registry.json        # Known devices
│   ├── Notes/
│   │   ├── meeting.md
│   │   └── ideas.md
│   ├── Attachments/
│   │   └── image.png
│   └── .obsidian/
│       └── (synced config)
│
└── backups/                            # Backup prefix (configurable, default: "backups")
    ├── backup-2024-12-25T14-30-00/     # Snapshot folder (ISO timestamp)
    │   ├── Notes/
    │   │   ├── meeting.md
    │   │   └── ideas.md
    │   ├── Attachments/
    │   │   └── image.png
    │   └── .backup-manifest.json       # Backup metadata
    ├── backup-2024-12-24T14-30-00/
    │   └── ...
    └── backup-2024-12-23T14-30-00/
        └── ...
```

---

## Core Features

### 1. S3-Compatible Storage Support

**Supported Providers:**
- AWS S3 (standard)
- MinIO (self-hosted)
- Cloudflare R2
- Backblaze B2 (S3-compatible API)
- Any S3-compatible endpoint

**Configuration:**
```
┌─────────────────────────────────────────────────────────────┐
│ Connection Settings                                         │
├─────────────────────────────────────────────────────────────┤
│ Provider:           AWS S3 / MinIO / Cloudflare R2 / Custom │
│ Endpoint URL:       (required for MinIO/R2/Custom)          │
│ Region:             us-east-1                               │
│ Bucket Name:        my-obsidian-bucket                      │
│ Access Key ID:      AKIA...                                 │
│ Secret Access Key:  ********                                │
│ Force Path Style:   Yes/No (required for MinIO)             │
└─────────────────────────────────────────────────────────────┘
```

---

### 2. End-to-End Encryption

**Encryption Model:**
- **Algorithm:** XChaCha20-Poly1305 (AEAD)
- **Key Derivation:** Argon2id from user passphrase
- **Shared Key:** Same encryption key used for both sync AND backups

**Key Setup Flow:**

```
┌─────────────────────────────────────────────────────────────┐
│                    FIRST DEVICE SETUP                       │
├─────────────────────────────────────────────────────────────┤
│ 1. User enables encryption in settings                      │
│ 2. User enters passphrase (min 12 characters)               │
│ 3. Plugin generates:                                        │
│    • Salt (random 32 bytes)                                 │
│    • Master key via Argon2id(passphrase, salt)              │
│ 4. Plugin uploads encrypted marker file:                    │
│    • {sync_prefix}/.obsidian-s3-sync/vault.enc              │
│    • Contains: salt, encrypted verification token           │
│ 5. All sync AND backup uploads are encrypted                │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   ADDITIONAL DEVICE SETUP                   │
├─────────────────────────────────────────────────────────────┤
│ 1. User configures S3 connection                            │
│ 2. Plugin detects vault.enc marker → prompts for passphrase │
│ 3. Plugin downloads salt, derives key, verifies             │
│ 4. If verification fails → reject passphrase                │
│ 5. If verification succeeds → sync & backup proceed         │
└─────────────────────────────────────────────────────────────┘
```

**Security Properties:**
- Zero-knowledge: S3 provider cannot read content
- Single passphrase for both sync and backup operations
- No recovery possible if passphrase lost (by design)

---

### 3. Bi-Directional Sync

**Sync Triggers:**
- **Manual:** Ribbon icon click or command palette
- **Periodic:** User-configurable intervals (1, 2, 5, 10, 15, 30 minutes)
- **On Startup:** Optional sync when Obsidian launches

**Sync Algorithm:**
- Four-timestamp comparison (local mtime, remote mtime, local delete time, remote delete time)
- Three-way diff using sync journal as base state

**Sync Direction Logic:**
```
For each file path:
  If exists locally AND remotely:
    If hashes match → skip (unchanged)
    If only local changed → upload
    If only remote changed → download
    If both changed → CONFLICT
  If exists locally only:
    If was synced before → delete locally (remote deletion)
    Else → upload (new local file)
  If exists remotely only:
    If was synced before → delete remotely (local deletion)
    Else → download (new remote file)
```

**Sync Settings:**
```
┌─────────────────────────────────────────────────────────────┐
│ Sync Settings                                               │
├─────────────────────────────────────────────────────────────┤
│ Enable Sync:        [✓]                                     │
│ Sync Prefix:        [vault          ] (S3 path prefix)      │
│ Auto-sync:          [✓] Enabled                             │
│ Sync Interval:      [5 minutes ▼]                           │
│                     (1m, 2m, 5m, 10m, 15m, 30m)             │
│ Sync on Startup:    [✓]                                     │
└─────────────────────────────────────────────────────────────┘
```

---

### 4. Conflict Resolution

**Strategy: Duplicate Both Versions**

When a conflict is detected (same file edited on multiple devices while offline), the plugin:

1. **Renames local version** to `LOCAL_<filename>`
2. **Downloads remote version** as `REMOTE_<filename>`
3. **Notifies user** via modal dialog
4. **User manually reconciles** and deletes the prefixed files

**Conflict Flow:**
```
Conflict detected for: meeting.md
         │
         ▼
┌─────────────────────────────────────────┐
│ 1. Rename local file:                   │
│    meeting.md → LOCAL_meeting.md        │
│                                         │
│ 2. Download remote file:                │
│    → REMOTE_meeting.md                  │
│                                         │
│ 3. Update journal (conflict state)      │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Show notification modal to user         │
└─────────────────────────────────────────┘
```

**Notification Modal:**
```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ Sync Conflict Detected                            [X]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ The file "meeting.md" was edited on multiple devices        │
│ while offline.                                              │
│                                                             │
│ Both versions have been saved:                              │
│                                                             │
│   📄 LOCAL_meeting.md   (this device's version)             │
│   📄 REMOTE_meeting.md  (other device's version)            │
│                                                             │
│ Please compare both files, merge your changes into a        │
│ new "meeting.md", then delete the LOCAL_ and REMOTE_        │
│ versions.                                                   │
│                                                             │
│                              [Open Folder] [Dismiss]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Conflict File Naming:**
```
Original:  meeting.md
Local:     LOCAL_meeting.md
Remote:    REMOTE_meeting.md

Original:  Notes/project/tasks.md  
Local:     Notes/project/LOCAL_tasks.md
Remote:    Notes/project/REMOTE_tasks.md
```

**Conflict Tracking:**
- Journal tracks files in conflict state
- Status bar shows conflict count
- Files with LOCAL_/REMOTE_ prefix excluded from normal sync until resolved

---

### 5. Backup System

**Purpose:** Create point-in-time snapshots of the entire vault for disaster recovery.

**Backup Triggers:**
- **Scheduled:** Based on configured period (hourly to weekly)
- **On-Open Logic:** If scheduled backup was missed (app not open), run immediately on next app open
- **Manual:** Via command palette

#### Backup Scheduling Logic

```
┌─────────────────────────────────────────────────────────────┐
│                    BACKUP SCHEDULING LOGIC                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ On Plugin Load:                                             │
│   1. Read lastBackupTime from local storage                 │
│   2. Calculate nextBackupDue = lastBackupTime + interval    │
│   3. If now >= nextBackupDue:                               │
│      → Run backup immediately (catch-up backup)             │
│   4. Schedule next backup at appropriate interval           │
│                                                             │
│ Example Scenarios:                                          │
│                                                             │
│ Scenario A: User opens app daily, backup interval = daily   │
│   Day 1, 9am: Opens app, backup runs                        │
│   Day 2, 9am: Opens app, 24h passed → backup runs           │
│   Day 3, 9am: Opens app, 24h passed → backup runs           │
│                                                             │
│ Scenario B: User skips days, backup interval = daily        │
│   Day 1, 9am: Opens app, backup runs                        │
│   Day 2: (app not opened)                                   │
│   Day 3: (app not opened)                                   │
│   Day 4, 2pm: Opens app, >24h passed → backup runs NOW      │
│               Creates: backup-2024-12-28T14-00-00           │
│                                                             │
│ Scenario C: Interval = weekly, irregular usage              │
│   Week 1 Mon: Opens app, backup runs                        │
│   Week 1 Wed: Opens app, <7 days → no backup                │
│   Week 2 Thu: Opens app, >7 days → backup runs NOW          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Backup Logic Pseudocode:**
```typescript
async function checkAndRunBackup(): Promise<void> {
  if (!settings.backupEnabled) return;
  
  const lastBackup = await getLastBackupTime();
  const intervalMs = parseInterval(settings.backupInterval);
  const nextDue = lastBackup + intervalMs;
  
  if (Date.now() >= nextDue) {
    // Backup is due (either on schedule or catch-up)
    await runBackup();
    await setLastBackupTime(Date.now());
  }
  
  // Schedule next check
  const msUntilNext = Math.max(nextDue - Date.now(), intervalMs);
  scheduleBackupCheck(msUntilNext);
}

function parseInterval(interval: BackupInterval): number {
  switch (interval) {
    case '1hour':  return 60 * 60 * 1000;
    case '6hours': return 6 * 60 * 60 * 1000;
    case '12hours': return 12 * 60 * 60 * 1000;
    case '1day':   return 24 * 60 * 60 * 1000;
    case '3days':  return 3 * 24 * 60 * 60 * 1000;
    case '1week':  return 7 * 24 * 60 * 60 * 1000;
  }
}
```

#### Backup Storage Format

Each backup is a complete snapshot stored in a timestamped folder:

```
{backup_prefix}/backup-{ISO_TIMESTAMP}/
├── Notes/
│   ├── meeting.md (or meeting.md.enc if encrypted)
│   └── ideas.md
├── Attachments/
│   └── image.png
├── .obsidian/
│   └── (config files)
└── .backup-manifest.json
```

**Backup Manifest:**
```json
{
  "version": 1,
  "timestamp": "2024-12-25T14:30:00.000Z",
  "deviceId": "macbook-pro-abc123",
  "deviceName": "MacBook Pro",
  "fileCount": 247,
  "totalSize": 15728640,
  "encrypted": true,
  "checksums": {
    "Notes/meeting.md": "sha256:abc123...",
    "Notes/ideas.md": "sha256:def456..."
  }
}
```

#### Retention Policy

**Two retention modes (mutually exclusive, optional):**

| Mode | Description | Range |
|------|-------------|-------|
| **By Days** | Delete backups older than X days | 1 - 360 days |
| **By Count** | Keep only the latest X backups | 1 - 1000 copies |

**Retention Logic:**
```typescript
async function applyRetentionPolicy(): Promise<void> {
  if (!settings.retentionEnabled) return;
  
  const backups = await listBackups(); // Sorted newest first
  
  if (settings.retentionMode === 'days') {
    const cutoff = Date.now() - (settings.retentionDays * 24 * 60 * 60 * 1000);
    for (const backup of backups) {
      if (backup.timestamp < cutoff) {
        await deleteBackup(backup.prefix);
      }
    }
  } else if (settings.retentionMode === 'copies') {
    const toDelete = backups.slice(settings.retentionCopies);
    for (const backup of toDelete) {
      await deleteBackup(backup.prefix);
    }
  }
}
```

#### Backup Settings

```
┌─────────────────────────────────────────────────────────────┐
│ Backup Settings                                             │
├─────────────────────────────────────────────────────────────┤
│ Enable Backups:     [✓]                                     │
│ Backup Prefix:      [backups        ] (S3 path prefix)      │
│                                                             │
│ ─── Schedule ─────────────────────────────────────────────  │
│ Backup Interval:    [Daily (24h) ▼]                         │
│                     • Every hour                            │
│                     • Every 6 hours                         │
│                     • Every 12 hours                        │
│                     • Daily (24h)        ← default          │
│                     • Every 3 days                          │
│                     • Weekly                                │
│                                                             │
│ ─── Retention (Optional) ─────────────────────────────────  │
│ Enable Retention:   [✓]                                     │
│ Retention Mode:     (○) By Days  (●) By Copies              │
│ Keep Latest:        [30         ] copies                    │
│                                                             │
│ ─── Recent Backups ───────────────────────────────────────  │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 📦 2024-12-25 14:30  │ 247 files │ 15 MB │ [Download]   │ │
│ │ 📦 2024-12-24 14:30  │ 245 files │ 15 MB │ [Download]   │ │
│ │ 📦 2024-12-23 14:30  │ 243 files │ 14 MB │ [Download]   │ │
│ │ 📦 2024-12-22 14:30  │ 240 files │ 14 MB │ [Download]   │ │
│ │ 📦 2024-12-21 14:30  │ 238 files │ 14 MB │ [Download]   │ │
│ │ 📦 2024-12-20 14:30  │ 235 files │ 14 MB │ [Download]   │ │
│ │ 📦 2024-12-19 14:30  │ 232 files │ 13 MB │ [Download]   │ │
│ │ 📦 2024-12-18 14:30  │ 230 files │ 13 MB │ [Download]   │ │
│ │ 📦 2024-12-17 14:30  │ 228 files │ 13 MB │ [Download]   │ │
│ │ 📦 2024-12-16 14:30  │ 225 files │ 13 MB │ [Download]   │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                   [View All] [Backup Now]   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Backup Download Flow

When user clicks "Download" on a backup:

```
1. Create temporary zip file in memory/temp
2. For each file in backup:
   a. Download from S3
   b. Decrypt if encrypted
   c. Add to zip
3. Trigger browser download of zip file
4. Cleanup temp resources
```

---

### 6. Status Bar Integration

**Dual Status Display:**

```
┌─────────────────────────────────────────────────────────────┐
│ Obsidian Status Bar (right side)                            │
├─────────────────────────────────────────────────────────────┤
│                          [Sync: ✓ 2m ago | Backup: ✓ 3h ago]│
└─────────────────────────────────────────────────────────────┘
```

**Status Format:**
```
[Sync: {status} {time} | Backup: {status} {time}]
```

**Sync Status States:**

| Icon | State | Example Display |
|------|-------|-----------------|
| `✓` | Synced | `Sync: ✓ 2m ago` |
| `↻` | Syncing | `Sync: ↻` |
| `!` | Error | `Sync: !` |
| `⚠` | Conflicts | `Sync: ⚠ 3` |
| `○` | Disabled | `Sync: ○` |
| `⏸` | Paused | `Sync: ⏸` |

**Backup Status States:**

| Icon | State | Example Display |
|------|-------|-----------------|
| `✓` | Completed | `Backup: ✓ 3h ago` |
| `↻` | Running | `Backup: ↻` |
| `!` | Error | `Backup: !` |
| `○` | Disabled | `Backup: ○` |

**Combined Examples:**
```
Normal operation:     [Sync: ✓ 2m ago | Backup: ✓ 3h ago]
Sync in progress:     [Sync: ↻ | Backup: ✓ 3h ago]
Backup running:       [Sync: ✓ 5m ago | Backup: ↻]
Sync has conflicts:   [Sync: ⚠ 3 | Backup: ✓ 1d ago]
Sync error:           [Sync: ! | Backup: ✓ 3h ago]
Both disabled:        [Sync: ○ | Backup: ○]
Only sync enabled:    [Sync: ✓ 2m ago | Backup: ○]
Only backup enabled:  [Sync: ○ | Backup: ✓ 6h ago]
```

**Relative Time Display:**
- "just now" (< 1 minute)
- "Xm ago" (1-59 minutes)
- "Xh ago" (1-23 hours)
- "1d ago" (24-47 hours)
- "Xd ago" (2-6 days)
- "1w ago" (7+ days)

**Status Bar Interactions:**

| Action | Result |
|--------|--------|
| Left click on Sync | Trigger manual sync |
| Left click on Backup | Trigger manual backup |
| Right click | Context menu |
| Hover | Detailed tooltip |

**Tooltip Content:**
```
┌─────────────────────────────────────────┐
│ S3 Sync & Backup Status                 │
├─────────────────────────────────────────┤
│ Sync                                    │
│   Last: Dec 25, 2024 2:34 PM            │
│   Status: Synced (1,247 files)          │
│   Next auto-sync: in 3 minutes          │
│   Conflicts: None                       │
│                                         │
│ Backup                                  │
│   Last: Dec 25, 2024 11:30 AM           │
│   Status: Completed (15 MB)             │
│   Next backup: ~9 hours                 │
│   Retention: 30 copies                  │
│                                         │
│ Remote: s3://my-bucket/vault            │
│ Encryption: Enabled                     │
└─────────────────────────────────────────┘
```

---

## Settings UI Structure

```
┌─────────────────────────────────────────────────────────────┐
│ S3 Sync & Backup Settings                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ═══ Connection ═══════════════════════════════════════════  │
│                                                             │
│ Provider:        [AWS S3          ▼]                        │
│                  • AWS S3                                   │
│                  • MinIO                                    │
│                  • Cloudflare R2                            │
│                  • Custom S3-compatible                     │
│                                                             │
│ Endpoint URL:    [                      ] (MinIO/R2 only)   │
│ Region:          [us-east-1             ]                   │
│ Bucket:          [my-obsidian-bucket    ]                   │
│ Access Key:      [********************  ]                   │
│ Secret Key:      [********************  ]                   │
│ Force Path Style:[✓] (Required for MinIO)                   │
│                                                             │
│                  [Test Connection]                          │
│                  ✓ Connected successfully                   │
│                                                             │
│ ═══ Encryption ═══════════════════════════════════════════  │
│                                                             │
│ Enable E2E Encryption: [✓]                                  │
│                                                             │
│ Passphrase:      [********************  ]                   │
│ Confirm:         [********************  ]                   │
│ Strength:        [████████░░] Strong                        │
│                                                             │
│ ⚠️ This passphrase encrypts both synced files AND backups.  │
│    If lost, your data CANNOT be recovered.                  │
│                                                             │
│ ═══ Sync ═════════════════════════════════════════════════  │
│                                                             │
│ Enable Sync:     [✓]                                        │
│ Sync Prefix:     [vault             ] (S3 path)             │
│                                                             │
│ Auto-sync:       [✓] Enabled                                │
│ Sync Interval:   [5 minutes     ▼]                          │
│                  • 1 minute                                 │
│                  • 2 minutes                                │
│                  • 5 minutes          ← default             │
│                  • 10 minutes                               │
│                  • 15 minutes                               │
│                  • 30 minutes                               │
│                                                             │
│ Sync on Startup: [✓]                                        │
│                                                             │
│ ═══ Backup ═══════════════════════════════════════════════  │
│                                                             │
│ Enable Backups:  [✓]                                        │
│ Backup Prefix:   [backups           ] (S3 path)             │
│                                                             │
│ Backup Interval: [Daily (24h)   ▼]                          │
│                  • Every hour                               │
│                  • Every 6 hours                            │
│                  • Every 12 hours                           │
│                  • Daily (24h)        ← default             │
│                  • Every 3 days                             │
│                  • Weekly                                   │
│                                                             │
│ ─── Retention ────────────────────────────────────────────  │
│                                                             │
│ Enable Retention: [✓]                                       │
│ Retention Mode:   (○) By Days  (●) By Copies                │
│                                                             │
│ If "By Days":                                               │
│   Delete backups older than: [30    ] days (1-360)          │
│                                                             │
│ If "By Copies":                                             │
│   Keep latest: [30    ] backups (1-1000)                    │
│                                                             │
│ ─── Recent Backups ───────────────────────────────────────  │
│                                                             │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ 📦 Dec 25, 2024 2:30 PM  │ 247 files │ 15 MB │ [⬇️]   │   │
│ │ 📦 Dec 24, 2024 2:30 PM  │ 245 files │ 15 MB │ [⬇️]   │   │
│ │ 📦 Dec 23, 2024 2:30 PM  │ 243 files │ 14 MB │ [⬇️]   │   │
│ │ 📦 Dec 22, 2024 2:30 PM  │ 240 files │ 14 MB │ [⬇️]   │   │
│ │ 📦 Dec 21, 2024 2:30 PM  │ 238 files │ 14 MB │ [⬇️]   │   │
│ │ 📦 Dec 20, 2024 2:30 PM  │ 235 files │ 14 MB │ [⬇️]   │   │
│ │ 📦 Dec 19, 2024 2:30 PM  │ 232 files │ 13 MB │ [⬇️]   │   │
│ │ 📦 Dec 18, 2024 2:30 PM  │ 230 files │ 13 MB │ [⬇️]   │   │
│ │ 📦 Dec 17, 2024 2:30 PM  │ 228 files │ 13 MB │ [⬇️]   │   │
│ │ 📦 Dec 16, 2024 2:30 PM  │ 225 files │ 13 MB │ [⬇️]   │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│                        [Refresh List]  [Backup Now]         │
│                                                             │
│ ═══ Advanced ═════════════════════════════════════════════  │
│                                                             │
│ Debug Logging:   [ ]                                        │
│ Exclude Patterns: [.obsidian/workspace*, .trash/*]          │
│                                                             │
│                     [Reset to Defaults]                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Command Palette Commands

| Command | Description |
|---------|-------------|
| `S3 Sync & Backup: Sync now` | Trigger immediate sync |
| `S3 Sync & Backup: Backup now` | Trigger immediate backup |
| `S3 Sync & Backup: Pause sync` | Pause automatic sync |
| `S3 Sync & Backup: Resume sync` | Resume automatic sync |
| `S3 Sync & Backup: View sync log` | Open sync history modal |
| `S3 Sync & Backup: View backups` | Open backup list modal |
| `S3 Sync & Backup: Open settings` | Open plugin settings |

---

## Technical Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              PLUGIN CORE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  main.ts    │  │ settings.ts │  │ commands.ts │  │ statusbar.ts│     │
│  │  (Plugin)   │  │ (Settings)  │  │ (Commands)  │  │ (UI)        │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │                │            │
│         └────────────────┴────────────────┴────────────────┘            │
│                                   │                                     │
│  ┌────────────────────────────────┴─────────────────────────────────┐   │
│  │                                                                  │   │
│  │  ┌─────────────────────────┐    ┌─────────────────────────────┐  │   │
│  │  │      SYNC ENGINE        │    │       BACKUP ENGINE         │  │   │
│  │  ├─────────────────────────┤    ├─────────────────────────────┤  │   │
│  │  │ • SyncScheduler         │    │ • BackupScheduler           │  │   │
│  │  │ • SyncOrchestrator      │    │ • BackupOrchestrator        │  │   │
│  │  │ • ChangeTracker         │    │ • SnapshotCreator           │  │   │
│  │  │ • DiffEngine            │    │ • RetentionManager          │  │   │
│  │  │ • ConflictHandler       │    │ • BackupDownloader          │  │   │
│  │  └───────────┬─────────────┘    └─────────────┬───────────────┘  │   │
│  │              │                                │                  │   │
│  │              └────────────┬───────────────────┘                  │   │
│  │                           │                                      │   │
│  └───────────────────────────┼──────────────────────────────────────┘   │
│                              │                                          │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │                        CRYPTO LAYER                               │  │
│  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────┐    │  │
│  │  │KeyDerivation │  │ FileEncryptor │  │   PassphraseVerifier │    │  │
│  │  │(Argon2id)    │  │ (XChaCha20)   │  │   (vault.enc)        │    │  │
│  │  └──────────────┘  └───────────────┘  └──────────────────────┘    │  │
│  └───────────────────────────┬───────────────────────────────────────┘  │
│                              │                                          │
│  ┌───────────────────────────┴───────────────────────────────────────┐  │
│  │                       STORAGE LAYER                               │  │
│  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────┐    │  │
│  │  │ S3Provider   │  │  SyncJournal  │  │    BackupRegistry    │    │  │
│  │  │ (AWS SDK v3) │  │  (IndexedDB)  │  │    (IndexedDB)       │    │  │
│  │  └──────────────┘  └───────────────┘  └──────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow: Sync Operation

```
1. Sync Triggered (manual, periodic, or startup)
         │
         ▼
2. Check for conflicts from previous sync
         │
         ▼
3. Fetch remote file list from S3 (sync_prefix/*)
         │
         ▼
4. Compare with local vault + sync journal
         │
         ▼
5. Generate sync plan:
   • Files to upload
   • Files to download
   • Files to delete
   • Conflicts detected
         │
         ▼
6. For conflicts:
   ├─► Rename local → LOCAL_filename
   └─► Download remote → REMOTE_filename
         │
         ▼
7. Execute uploads/downloads (encrypted if enabled)
         │
         ▼
8. Update sync journal
         │
         ▼
9. Update status bar
         │
         ▼
10. Show conflict notification if any
```

### Data Flow: Backup Operation

```
1. Backup Triggered (scheduled or manual)
         │
         ▼
2. Generate backup timestamp
   (backup-2024-12-25T14-30-00)
         │
         ▼
3. Create backup manifest
         │
         ▼
4. For each file in vault:
   ├─► Read file content
   ├─► Encrypt if enabled
   └─► Upload to {backup_prefix}/{timestamp}/{path}
         │
         ▼
5. Upload manifest to {backup_prefix}/{timestamp}/.backup-manifest.json
         │
         ▼
6. Record backup in local registry
         │
         ▼
7. Apply retention policy (delete old backups if configured)
         │
         ▼
8. Update status bar
```

---

## Settings Interface (TypeScript)

```typescript
interface S3SyncBackupSettings {
  // Connection
  provider: 'aws' | 'minio' | 'r2' | 'custom';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  
  // Encryption
  encryptionEnabled: boolean;
  // Note: passphrase never stored, only derived key in memory
  
  // Sync
  syncEnabled: boolean;
  syncPrefix: string;              // default: "vault"
  autoSyncEnabled: boolean;
  syncIntervalMinutes: 1 | 2 | 5 | 10 | 15 | 30;
  syncOnStartup: boolean;
  
  // Backup
  backupEnabled: boolean;
  backupPrefix: string;            // default: "backups"
  backupInterval: '1hour' | '6hours' | '12hours' | '1day' | '3days' | '1week';
  retentionEnabled: boolean;
  retentionMode: 'days' | 'copies';
  retentionDays: number;           // 1-360
  retentionCopies: number;         // 1-1000
  
  // Advanced
  excludePatterns: string[];
  debugLogging: boolean;
}

const DEFAULT_SETTINGS: S3SyncBackupSettings = {
  provider: 'aws',
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: false,
  
  encryptionEnabled: false,
  
  syncEnabled: true,
  syncPrefix: 'vault',
  autoSyncEnabled: true,
  syncIntervalMinutes: 5,
  syncOnStartup: true,
  
  backupEnabled: true,
  backupPrefix: 'backups',
  backupInterval: '1day',
  retentionEnabled: false,
  retentionMode: 'copies',
  retentionDays: 30,
  retentionCopies: 30,
  
  excludePatterns: ['.obsidian/workspace*', '.trash/*'],
  debugLogging: false,
};
```

---

## Implementation Phases

### Phase 1: Foundation (MVP)
- [ ] S3 connection and authentication
- [ ] Basic settings UI (connection section)
- [ ] Test connection functionality
- [ ] Simple status bar (text only)

### Phase 2: Sync Core
- [ ] Local file tracking via Vault events
- [ ] Remote file listing from S3
- [ ] Sync journal (IndexedDB)
- [ ] Upload/download operations
- [ ] Sync prefix support
- [ ] Auto-sync scheduling
- [ ] Sync on startup

### Phase 3: Conflict Handling
- [ ] Three-way diff detection
- [ ] LOCAL_/REMOTE_ file creation
- [ ] Conflict notification modal
- [ ] Conflict state tracking in journal

### Phase 4: Encryption
- [ ] Passphrase setup flow
- [ ] Key derivation (Argon2id)
- [ ] File encryption (XChaCha20-Poly1305)
- [ ] vault.enc marker file
- [ ] Multi-device key verification

### Phase 5: Backup System
- [ ] Backup scheduler with catch-up logic
- [ ] Snapshot creation
- [ ] Backup manifest
- [ ] Backup listing in settings
- [ ] Backup download (zip)
- [ ] Retention policy implementation

### Phase 6: Polish
- [ ] Full status bar with dual status
- [ ] Tooltips and interactions
- [ ] Error handling and retry logic
- [ ] Mobile optimization
- [ ] Documentation

---

## Non-Functional Requirements

### Performance

| Metric | Target |
|--------|--------|
| Initial sync (1000 files) | < 5 minutes |
| Incremental sync (10 changed files) | < 10 seconds |
| Full backup (1000 files) | < 10 minutes |
| Memory usage during operations | < 100 MB |

### Security

- Passphrase never stored (only derived key in memory)
- Key cleared from memory on plugin unload
- No telemetry or analytics
- Credentials stored via Obsidian's secure storage API

### Reliability

- Atomic sync operations (journal updated only on success)
- Automatic retry with exponential backoff
- Safe abort threshold (warn if > 50% files affected)
- Graceful degradation (offline mode)

---

## Appendix

### A. S3 Bucket Policy (Minimal Permissions)

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

### B. File Naming Convention for Conflicts

```
Conflict detected: Notes/meeting.md

Creates:
  Notes/LOCAL_meeting.md    (this device's version)
  Notes/REMOTE_meeting.md   (other device's version)

User resolution:
  1. Compare LOCAL_ and REMOTE_ versions
  2. Create merged meeting.md
  3. Delete LOCAL_meeting.md and REMOTE_meeting.md
  4. Next sync uploads meeting.md
```

### C. Backup Interval Mapping

| Setting | Milliseconds | Human Readable |
|---------|--------------|----------------|
| `1hour` | 3,600,000 | 1 hour |
| `6hours` | 21,600,000 | 6 hours |
| `12hours` | 43,200,000 | 12 hours |
| `1day` | 86,400,000 | 24 hours |
| `3days` | 259,200,000 | 72 hours |
| `1week` | 604,800,000 | 168 hours |

### D. Glossary

- **AEAD:** Authenticated Encryption with Associated Data
- **E2E:** End-to-End (encryption)
- **KDF:** Key Derivation Function
- **Retention:** Policy for automatically deleting old backups
- **Snapshot:** Point-in-time copy of entire vault
- **Sync Journal:** Local database tracking sync state per file
- **XChaCha20:** Extended-nonce variant of ChaCha20 stream cipher