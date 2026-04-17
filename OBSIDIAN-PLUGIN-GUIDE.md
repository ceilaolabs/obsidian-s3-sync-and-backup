---
title: Obsidian Plugin Developer Reference
tags: [obsidian, plugin-development, reference]
---

# Obsidian Plugin Developer Reference

A consolidated reference covering plugin guidelines, submission requirements, the `versions.json` file, and the `manifest.json` schema. Written as a field guide, not a reproduction — see the official docs for the canonical text.

**Sources:**
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Submission requirements for plugins](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [Versions](https://docs.obsidian.md/Reference/Versions)
- [Manifest](https://docs.obsidian.md/Reference/Manifest)

---

## 1. Plugin guidelines

These are the coding and UX conventions the Obsidian team expects from community plugins. Follow them before submission — otherwise the reviewer will ask you to fix them and the review cycle lengthens.

### 1.1 Use `this.app`, not the global `app`

Obsidian exposes a global `app` object for convenience in the console, but plugins must access it via `this.app` on the `Plugin` instance. The global is intended for debugging only and may go away.

### 1.2 Rename placeholder names from the sample

The sample plugin ships with class and constant names like `MyPlugin`, `MyPluginSettings`, `DEFAULT_SETTINGS`, and `SampleSettingTab`. Rename them to match your plugin before submitting. Leaving the placeholder names in place is one of the most common review comments.

### 1.3 Don't include `"Obsidian"` in the plugin name

The plugin name is shown inside Obsidian's own community directory, so prefixing it with "Obsidian" is redundant. It also runs into the trademark expectations in the developer policies.

Also avoid the word "plugin" in the name for the same reason — the UI already frames the entry as a plugin.

### 1.4 Don't include the plugin name in your command names

Obsidian prepends the plugin name to every command automatically in the command palette. If you name your command `"My Plugin: Insert table"`, users see `My Plugin: My Plugin: Insert table`.

### 1.5 Sentence case in UI text

Buttons, commands, settings headings, notices — all UI text should use sentence case (`Create new note`), not Title Case (`Create New Note`). This matches Obsidian's own style.

### 1.6 Avoid unnecessary top-level settings headings

Don't start your settings tab with a big "Settings for X Plugin" heading. The settings tab itself already has the plugin name as its heading. Go straight into the grouped settings.

### 1.7 Resource cleanup is handled by `register*` methods

Anything you register through the framework is cleaned up automatically when the plugin unloads:

| Register this way                    | Instead of                         |
|--------------------------------------|------------------------------------|
| `this.registerEvent(ref)`            | Bare `on()` / `off()` pairs        |
| `this.registerDomEvent(el, type, …)` | `el.addEventListener(…)`           |
| `this.registerInterval(id)`          | Bare `setInterval`                 |
| `this.addCommand(…)` / `this.addRibbonIcon(…)` | Manual DOM insertion     |

You should only need to put code in `onunload()` for resources the framework doesn't know about.

### 1.8 Don't detach leaves in `onunload`

A common mistake is calling `workspace.detachLeavesOfType(MY_VIEW_TYPE)` inside `onunload`. Don't. Obsidian handles view cleanup for leaves of your registered view types automatically, and detaching them on unload makes workspace restore flaky.

### 1.9 Don't manage view references via the plugin

Store view state inside the view itself, not on the plugin instance. Multiple leaves of the same view type can exist simultaneously, and the plugin singleton can't represent per-leaf state.

### 1.10 Prefer the Editor interface for the active file

When the user is editing a file, use the `Editor` interface rather than `Vault.modify()`. `Vault.modify` rewrites the whole file on disk and will clobber unsaved editor state and cursor position.

### 1.11 Use `Vault.process` for non-active files

For files that aren't open in the editor, prefer `Vault.process()` over `Vault.modify()`. `process` takes a callback that receives the current content and returns the new content, which avoids race conditions when the file changes between your read and your write.

### 1.12 Read files with `cachedRead` when you're only reading

If you only need to read a file (for example, to parse its frontmatter), use `Vault.cachedRead()` rather than `Vault.read()`. The cached version is much cheaper when you're operating over many files.

### 1.13 Use `normalizePath` for user input paths

Any path that comes from a user or is constructed by concatenation should go through `normalizePath()` before being passed to vault APIs. This handles cross-platform slashes, collapses `..`, and strips trailing whitespace.

### 1.14 Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML` with dynamic content

These are an XSS vector. Obsidian loads arbitrary community plugins, and note content is fully user-controlled, so injecting a string into the DOM is how a malicious note pops a plugin. Use the DOM API:

```ts
// Bad
containerEl.innerHTML = `<div class="x">${userValue}</div>`;

// Good
const wrapper = containerEl.createDiv({ cls: "x" });
wrapper.setText(userValue);
```

Obsidian extends `HTMLElement` with `createEl`, `createDiv`, `createSpan`, and `setText` — use them.

### 1.15 Keep styles in `styles.css`

Don't set inline styles with string concatenation. Define classes in `styles.css` and toggle them with `addClass` / `removeClass` / `toggleClass`. Inline styles make your plugin impossible for theme authors and snippet authors to override.

It's also fine to use CSS variables that Obsidian defines — that way your plugin inherits theme colors automatically.

### 1.16 Avoid `async` in `onload()` unless you need it

`onload` can be async, but anything that blocks it delays Obsidian startup. If you have work that can happen after the workspace is ready, defer it with `this.app.workspace.onLayoutReady(...)`.

### 1.17 Don't hardcode the English locale

Strings like `"Loading..."` should be localizable if your plugin is likely to serve non-English users. Even if you don't localize now, structure the code so strings are centralized.

### 1.18 Prefer TypeScript strictness

The sample plugin turns on basic strict options. Keep them on. Type errors caught at compile time are review comments you don't have to address later.

### 1.19 Don't ship console logs from normal paths

`console.log` from every event handler makes user vaults' dev consoles useless. Keep logging behind a setting, or remove it before publishing. Error logging on actual errors is fine.

---

## 2. Submission requirements for plugins

This is the checklist the Obsidian review bot and reviewer will run through. It's stricter than the general guidelines — submissions that fail these get rejected automatically.

### 2.1 `manifest.json` requirements

| Field           | Requirement                                                                                  |
|-----------------|----------------------------------------------------------------------------------------------|
| `id`            | Kebab-case, unique across the entire community registry, must not contain `"obsidian"`.      |
| `name`          | Display name. Must not start with or contain `"Obsidian"`. Avoid the word `"plugin"`.        |
| `version`       | Strict semver `x.y.z`. No `v` prefix, no pre-release suffixes, no build metadata.            |
| `minAppVersion` | The oldest Obsidian version your current build is tested on.                                 |
| `description`   | ≤ 250 characters, sentence case, ends with a period, no emoji or decorative characters.      |
| `author`        | Your name or organization name.                                                              |
| `isDesktopOnly` | `true` if you import any Node.js or Electron module (`fs`, `child_process`, `path`, etc.).   |

### 2.2 Description rules

The description is shown in the community plugins browser. Reviewers apply these rules strictly:

- Start with an action verb: `Generate…`, `Translate…`, `Import…`, `Sync…`.
- Don't begin with `"This is a plugin that…"` or `"A plugin for…"`.
- Sentence case, not Title Case.
- One to two sentences max, ≤ 250 characters.
- End with a period.
- Capitalize proper nouns correctly: Obsidian, Markdown, PDF, LaTeX, GitHub.
- No emoji, no ASCII art, no promotional exclamation marks.

### 2.3 Plugin ID rules

- Kebab-case lowercase: `my-cool-plugin`.
- Cannot contain the substring `obsidian` — so no `obsidian-tasks`, just `tasks`.
- Must be unique against everything already in [`community-plugins.json`](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json). Grep that file before you pick a name.
- The `id` must match the folder name under `.obsidian/plugins/` for `onExternalSettingsChange` to work correctly.

### 2.4 Desktop-only flag

Set `isDesktopOnly: true` if your plugin uses any of:
- Node.js built-ins (`fs`, `path`, `child_process`, `os`, `crypto` for Node crypto, etc.)
- Electron APIs (`remote`, `shell`, `BrowserWindow`).
- Native binaries spawned via `child_process`.
- Any npm package that in turn depends on the above.

When `isDesktopOnly` is `false`, your plugin must load and run on iOS and Android without errors. The reviewer will check on mobile.

### 2.5 Funding URL

- `fundingUrl` must link to an actual donation/sponsorship page (Buy Me a Coffee, GitHub Sponsors, Patreon, Ko-fi, etc.).
- Do not point it at your product page or an unrelated marketing site.
- If you don't accept donations, omit the field entirely — don't leave the sample plugin's placeholder URL in place.

### 2.6 Required repository files

At the root of your repo:

```
├── README.md          # Clear description and usage
├── LICENSE            # Any OSI license; MIT is typical
├── manifest.json      # Must match the release manifest
├── versions.json      # Compatibility map (see §3)
└── …
```

### 2.7 Required GitHub release assets

Every GitHub release must attach these as **individual binary files** (not inside the auto-generated source zip):

- `main.js` — required.
- `manifest.json` — required; must be byte-identical to the one in the repo root at this tag.
- `styles.css` — only if your plugin has styles.

The release's **tag name** must exactly equal `manifest.json`'s `version` field. No `v` prefix.

Obsidian ignores **draft** and **pre-release** releases when checking for updates, so make sure the release is published as a regular release.

### 2.8 Remove the sample template scaffolding

Before you submit, delete or replace:

- The `MyPlugin` / `SampleModal` / `SampleSettingTab` classes.
- The ribbon icon and command that exist only to demonstrate the API.
- The `console.log('click')` global click handler.
- The `setInterval` demo that logs to the console.

The sample is a learning artifact, not a starter feature set.

### 2.9 README expectations

- One-line description at the top.
- Install instructions (even "Install from Community Plugins" is fine).
- Usage section with at least one example.
- Any required configuration steps.
- Attribution if you adapted code from another plugin.
- Mention of network usage, account requirements, or external services, if applicable (this is also a developer-policies requirement).

### 2.10 Pull request to `obsidian-releases`

Submission is a single PR to [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) that appends an entry to `community-plugins.json`:

```json
{
  "id": "my-plugin-id",
  "name": "My Plugin",
  "author": "Your Name",
  "description": "Does a specific useful thing.",
  "repo": "your-gh-user/your-repo-name"
}
```

The `id`, `name`, and `author` here must match `manifest.json` exactly.

### 2.11 Review workflow

1. The validation bot runs within minutes of PR open; it checks manifest presence, release assets, version match, and ID uniqueness.
2. If the bot fails, fix the issues in place and **update the same GitHub release** with new assets. Don't cut a new version — just replace the release artifacts.
3. Comment on the PR after you've pushed fixes so reviewers know to re-check.
4. A human reviewer then checks for guideline compliance (§1 above).
5. Once approved, a team member merges. Don't rebase or force-push to the PR branch while waiting — if GitHub shows merge conflicts, the team resolves them at merge time.
6. After merge, your plugin shows up in the browser within a few hours.

---

## 3. `versions.json`

This file lives at your repo root alongside `manifest.json` and tells Obsidian which of your released plugin versions are compatible with which Obsidian versions.

### 3.1 Shape

```json
{
  "1.0.1": "0.15.0",
  "1.1.0": "1.0.0",
  "1.2.0": "1.1.0"
}
```

Keys are your plugin versions. Values are the corresponding `minAppVersion` at the time that plugin version was released.

### 3.2 Why it exists

When a user on an older Obsidian build checks for plugin updates, Obsidian looks at:

1. Your repo's `manifest.json` → latest plugin version and its `minAppVersion`.
2. If the user's Obsidian is older than that `minAppVersion`, Obsidian walks `versions.json` backwards looking for the newest plugin version whose required Obsidian version is ≤ the user's Obsidian version.
3. Obsidian installs that older but compatible plugin version.

Without `versions.json`, users on older Obsidian versions get stuck at whatever plugin version they already had — or can't install at all.

### 3.3 When to update

Every time you bump `minAppVersion` in `manifest.json`, append an entry to `versions.json` before cutting the tag:

```
# 1.  Bump minAppVersion in manifest.json manually.
# 2.  Run:
npm version patch
```

The sample plugin's `version-bump.mjs` is already wired up so that `npm version` updates `manifest.json`, `package.json`, and `versions.json` in one commit. Read that script once — it's short and worth knowing.

### 3.4 Don't delete old entries

Keep every published version's entry. Removing old keys breaks the fallback path for users still on older Obsidian builds.

---

## 4. `manifest.json`

The full schema for `manifest.json`. Obsidian reads this file to decide whether your plugin can run in the current app, and the community browser displays its metadata.

### 4.1 Minimal manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "minAppVersion": "0.15.0",
  "description": "Does one specific useful thing.",
  "author": "Your Name",
  "isDesktopOnly": false
}
```

### 4.2 Full field reference

| Field             | Type              | Required | Notes                                                                                                     |
|-------------------|-------------------|----------|-----------------------------------------------------------------------------------------------------------|
| `id`              | string            | Yes      | Kebab-case, unique, no `"obsidian"`, must match the plugin folder name.                                   |
| `name`            | string            | Yes      | Human-readable display name. Sentence case preferred; no `"Obsidian"` / `"plugin"`.                       |
| `version`         | string            | Yes      | Strict semver `x.y.z`. Must match the GitHub release tag exactly.                                         |
| `minAppVersion`   | string            | Yes      | Minimum Obsidian version supporting the APIs you use. Use the Obsidian version number, not the installer. |
| `description`     | string            | Yes      | ≤ 250 chars, sentence case, ends with period. Shown in the community browser.                             |
| `author`          | string            | Yes      | Author name or organization.                                                                              |
| `authorUrl`       | string            | No       | Link to the author's homepage / profile. Don't point at the plugin's own repo.                            |
| `helpUrl`         | string            | No       | Link to docs or support page.                                                                             |
| `isDesktopOnly`   | boolean           | Yes      | `true` if you use Node.js or Electron APIs; must be `false` for mobile support.                           |
| `fundingUrl`      | string \| object  | No       | Donation link, or an object mapping platform name → URL. Omit if you don't accept donations.              |

### 4.3 `fundingUrl` shapes

**Single source:**

```json
{
  "fundingUrl": "https://buymeacoffee.com/yourname"
}
```

**Multiple sources:**

```json
{
  "fundingUrl": {
    "Buy Me a Coffee": "https://buymeacoffee.com/yourname",
    "GitHub Sponsors": "https://github.com/sponsors/yourname",
    "Patreon": "https://www.patreon.com/yourname"
  }
}
```

Keys in the object become the labels Obsidian renders in the plugin detail view. Keep them short.

### 4.4 Constraints worth repeating

- **Folder match:** The `id` field must equal the folder name under `.obsidian/plugins/<id>/` or `onExternalSettingsChange` won't fire for your plugin.
- **Substring ban:** The string `obsidian` cannot appear anywhere in `id`.
- **Semver only:** No `v1.0.0`, no `1.0.0-beta`, no `1.0`. Just `1.0.0`.
- **Restart to reload:** Changes to `manifest.json` require a full Obsidian restart, not just toggling the plugin off and on.
- **Two copies:** `manifest.json` must live both in the repo root and as a binary asset on each GitHub release. Obsidian reads the repo copy to check the latest version, then downloads the release copy when installing.

### 4.5 Keep `minAppVersion` honest

Set `minAppVersion` to the lowest Obsidian version that actually exposes every API you call. A common mistake is leaving it at whatever the sample plugin shipped with (e.g. `0.15.0`) while using APIs introduced in `1.4.0` — the plugin then crashes on older Obsidian builds. If you're not sure which version added an API, check the [Obsidian API changelog](https://github.com/obsidianmd/obsidian-api/blob/master/CHANGELOG.md).

---

## Quick pre-submission checklist

- [ ] `id`, `name`, `author`, `description` all follow the rules in §2.
- [ ] `id` does not contain `obsidian`; it's unique in `community-plugins.json`.
- [ ] `version` is strict semver and equals the GitHub release tag.
- [ ] `minAppVersion` reflects the APIs actually used.
- [ ] `isDesktopOnly` is correct (and tested on mobile if `false`).
- [ ] `versions.json` is present and up to date.
- [ ] GitHub release has `main.js`, `manifest.json`, and (if applicable) `styles.css` attached as binaries.
- [ ] `LICENSE` and `README.md` are in the repo root.
- [ ] No placeholder names from the sample plugin remain.
- [ ] No `innerHTML` / `outerHTML` with dynamic strings.
- [ ] Event handlers, intervals, DOM events are all registered through the framework.
- [ ] No `console.log` on hot paths.
- [ ] UI text is sentence case; commands don't repeat the plugin name.