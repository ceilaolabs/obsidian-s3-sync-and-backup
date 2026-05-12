/**
 * Path Utility Module
 *
 * Pure utility functions for S3 key ↔ vault path conversion, glob matching, and
 * conflict file detection. This module is intentionally browser-safe — it does NOT
 * use Node.js's `path` module, which is unavailable in the Obsidian runtime.
 *
 * Responsibilities:
 * - Normalize path separators and S3 key prefixes (always forward-slash, no leading/trailing slashes)
 * - Decompose paths into directory, filename, and extension components
 * - Join path segments safely, collapsing duplicate separators
 * - Match vault paths against glob patterns (supports `*` and `**`)
 * - Add/remove S3 prefix segments to translate between vault paths and S3 keys
 * - Detect and decode conflict artifact filenames (`LOCAL_*` / `REMOTE_*`)
 *
 * Used by: `SyncPathCodec`, `SyncPlanner`, `SnapshotCreator`, `RetentionManager`, and others.
 */

/**
 * Normalize path separators to forward slashes.
 *
 * Replaces all backslashes (`\`) with forward slashes (`/`). This is needed because
 * Windows-style paths may appear in user input or Obsidian's vault metadata on Windows,
 * but S3 keys always use forward slashes.
 *
 * @param path - The path string to normalize (may contain backslashes).
 * @returns The same path with every `\` replaced by `/`.
 *
 * @example
 * normalizePath('folder\\note.md') // → 'folder/note.md'
 */
export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
}

/**
 * Normalize a user-configured S3 prefix.
 *
 * Applies the following transformations in order so that the resulting prefix is
 * safe to use as an S3 key segment:
 * 1. Normalize backslashes to forward slashes (via `normalizePath`).
 * 2. Trim leading/trailing whitespace.
 * 3. Strip any leading slashes (S3 keys must not start with `/`).
 * 4. Strip any trailing slashes (avoids double-slash when joining with a path).
 * 5. Collapse consecutive interior slashes into a single `/`.
 *
 * @param prefix - The raw prefix string supplied by the user in plugin settings.
 * @returns A clean prefix string with no leading/trailing slashes or whitespace,
 *          and no consecutive interior slashes.
 *
 * @example
 * normalizePrefix('  /my//vault/ ') // → 'my/vault'
 * normalizePrefix('')               // → ''
 */
export function normalizePrefix(prefix: string): string {
    return normalizePath(prefix)
        // Remove surrounding whitespace that might come from copy-paste in settings UI
        .trim()
        // S3 keys must not begin with a slash
        .replace(/^\/+/, '')
        // Strip trailing slash so that joining with a path never produces double slashes
        .replace(/\/+$/, '')
        // Collapse any remaining consecutive slashes (e.g. "a//b" → "a/b")
        .replace(/\/+/g, '/');
}

/**
 * Get the directory portion of a path (everything before the last `/`).
 *
 * @param path - A file path (may use backslashes; they are normalized internally).
 * @returns The directory segment, or an empty string if the path contains no `/`.
 *
 * @example
 * getDirectory('folder/sub/note.md') // → 'folder/sub'
 * getDirectory('note.md')            // → ''
 */
export function getDirectory(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(0, lastSlash) : '';
}

/**
 * Get the filename portion of a path (everything after the last `/`).
 *
 * @param path - A file path (may use backslashes; they are normalized internally).
 * @returns The filename (including extension), or the entire string if no `/` is found.
 *
 * @example
 * getFilename('folder/sub/note.md') // → 'note.md'
 * getFilename('note.md')            // → 'note.md'
 */
export function getFilename(path: string): string {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

/**
 * Get the file extension of a path, without the leading dot.
 *
 * @param path - A file path (may use backslashes; they are normalized internally).
 * @returns The lowercase extension string without the dot, or an empty string if the
 *          filename has no extension.
 *
 * @example
 * getExtension('folder/note.md') // → 'md'
 * getExtension('archive.tar.gz') // → 'gz'
 * getExtension('Makefile')       // → ''
 */
export function getExtension(path: string): string {
    const filename = getFilename(path);
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.substring(lastDot + 1) : '';
}

/**
 * Join one or more path segments into a single forward-slash-separated path.
 *
 * Empty segments are discarded, and consecutive slashes in the joined result are
 * collapsed to a single `/`. This is the safe alternative to Node.js `path.join()`
 * for the browser environment.
 *
 * @param segments - Any number of path segments to join. Backslashes are normalized.
 * @returns The joined path with normalized separators and no duplicate slashes.
 *
 * @example
 * joinPath('vault', 'folder', 'note.md') // → 'vault/folder/note.md'
 * joinPath('vault/', '/note.md')         // → 'vault/note.md'
 * joinPath('vault', '', 'note.md')       // → 'vault/note.md'
 */
export function joinPath(...segments: string[]): string {
    return segments
        .map((s) => normalizePath(s))
        .filter((s) => s.length > 0)
        .join('/')
        .replace(/\/+/g, '/');
}

/**
 * Check whether a vault path matches a glob pattern.
 *
 * Supported glob syntax:
 * - `*`  — matches any sequence of characters **except** `/` (single path segment wildcard).
 * - `**` — matches any sequence of characters **including** `/` (multi-segment wildcard).
 * - All other characters are matched literally (dots are escaped so `.` does not act as a
 *   regex wildcard).
 *
 * @param path    - The vault-relative file path to test (backslashes are normalized).
 * @param pattern - The glob pattern string.
 * @returns `true` if the path matches the pattern from start to end; `false` otherwise.
 *
 * @example
 * matchGlob('notes/daily/2024-01-01.md', 'notes/daily/*.md') // → true
 * matchGlob('notes/deep/sub/note.md',    'notes/**')         // → true
 * matchGlob('attachments/img.png',       '*.md')             // → false
 */
export function matchGlob(path: string, pattern: string): boolean {
    const normalized = normalizePath(path);

    // Convert glob pattern to a regex string step-by-step:
    const regexPattern = pattern
        // 1. Temporarily replace glob wildcards with placeholders so they survive
        //    the regex-escape step below unchanged.
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '<<<STAR>>>')
        // 2. Escape ALL remaining regex metacharacters (dots, brackets, parens, etc.)
        //    so that literal characters in the pattern are matched exactly.
        //    e.g. ".obsidian" → "\\.obsidian", "(project)" → "\\(project\\)"
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        // 3. Restore single * as [^/]* — matches anything except a path separator
        //    e.g. "*.md" → "[^/]*\\.md"
        .replace(/<<<STAR>>>/g, '[^/]*')
        // 4. Restore ** as .* — matches any character including /
        //    e.g. "notes/**" → "notes/.*"
        .replace(/<<<GLOBSTAR>>>/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(normalized);
}

/**
 * Check whether a path matches any pattern in a list of glob patterns.
 *
 * Delegates each pattern check to `matchGlob`. Returns `true` as soon as the
 * first matching pattern is found (short-circuit evaluation).
 *
 * @param path     - The vault-relative file path to test.
 * @param patterns - An array of glob pattern strings.
 * @returns `true` if the path matches at least one pattern; `false` if none match.
 *
 * @example
 * matchesAnyGlob('notes/note.md', ['*.png', '**' + '/*.md']) // → true
 * matchesAnyGlob('notes/note.md', ['*.png', '*.jpg'])        // → false
 */
export function matchesAnyGlob(path: string, patterns: string[]): boolean {
    return patterns.some((pattern) => matchGlob(path, pattern));
}

/**
 * Prepend an S3 prefix to a vault-relative path, producing a full S3 key.
 *
 * Both the prefix and path are normalized before joining. If either is empty after
 * normalization, the other is returned as-is to avoid producing keys that start or
 * end with a stray slash.
 *
 * @param path   - The vault-relative file path (e.g. `"Notes/note.md"`).
 * @param prefix - The S3 key prefix from plugin settings (e.g. `"vault"`).
 * @returns The full S3 key (e.g. `"vault/Notes/note.md"`), or the non-empty
 *          component alone if the other is empty.
 *
 * @example
 * addPrefix('Notes/note.md', 'vault') // → 'vault/Notes/note.md'
 * addPrefix('Notes/note.md', '')      // → 'Notes/note.md'
 * addPrefix('', 'vault')              // → 'vault'
 */
export function addPrefix(path: string, prefix: string): string {
    const normalizedPrefix = normalizePrefix(prefix);
    const normalizedPath = normalizePath(path).replace(/^\/+/, '');

    if (!normalizedPrefix) {
        return normalizedPath;
    }

    if (!normalizedPath) {
        return normalizedPrefix;
    }

    return `${normalizedPrefix}/${normalizedPath}`;
}

/**
 * Remove an S3 prefix from a full S3 key, returning the vault-relative path.
 *
 * Both arguments are normalized before comparison. Three outcomes are possible:
 * - The key equals the prefix exactly → returns `''` (the prefix itself is the path root).
 * - The key starts with `prefix/`     → returns the portion after `prefix/`.
 * - The key does not start with the prefix → returns `null` (key is outside this prefix).
 *
 * @param path   - The full S3 key to strip the prefix from.
 * @param prefix - The S3 key prefix to remove (from plugin settings).
 * @returns The vault-relative path string, an empty string if the key equals the prefix,
 *          or `null` if the key does not belong to this prefix.
 *
 * @example
 * removePrefix('vault/Notes/note.md', 'vault') // → 'Notes/note.md'
 * removePrefix('vault', 'vault')               // → ''
 * removePrefix('backups/snapshot', 'vault')    // → null
 * removePrefix('Notes/note.md', '')            // → 'Notes/note.md'
 */
export function removePrefix(path: string, prefix: string): string | null {
    const normalizedPath = normalizePath(path);
    const normalizedPrefix = normalizePrefix(prefix);

    if (!normalizedPrefix) {
        return normalizedPath;
    }

    const prefixWithSlash = `${normalizedPrefix}/`;

    if (normalizedPath === normalizedPrefix) {
        return '';
    }

    if (normalizedPath.startsWith(prefixWithSlash)) {
        return normalizedPath.substring(prefixWithSlash.length);
    }

    return null;
}

/**
 * Determine whether a path represents a sync conflict artifact.
 *
 * The sync engine creates conflict files by prepending `LOCAL_` or `REMOTE_` to the
 * original filename when the same file has diverged on both sides of a sync. This
 * function inspects only the filename component (not the directory) to avoid false
 * positives from folder names.
 *
 * @param path - The vault-relative file path to inspect.
 * @returns `true` if the filename starts with `LOCAL_` or `REMOTE_`; `false` otherwise.
 *
 * @example
 * isConflictFile('Notes/LOCAL_note.md')  // → true
 * isConflictFile('Notes/REMOTE_note.md') // → true
 * isConflictFile('Notes/note.md')        // → false
 */
export function isConflictFile(path: string): boolean {
    const filename = getFilename(path);
    return filename.startsWith('LOCAL_') || filename.startsWith('REMOTE_');
}

/**
 * Derive the original vault path from a conflict artifact path.
 *
 * Strips the `LOCAL_` (6 chars) or `REMOTE_` (7 chars) prefix from the filename and
 * reconstructs the full path with the original directory. Returns `null` if the path
 * is not a recognized conflict artifact (i.e. `isConflictFile` would return `false`).
 *
 * @param conflictPath - The vault-relative path of the conflict artifact
 *                       (e.g. `"Notes/LOCAL_note.md"`).
 * @returns The original vault path (e.g. `"Notes/note.md"`), or `null` if the path
 *          is not a conflict file.
 *
 * @example
 * getOriginalFromConflict('Notes/LOCAL_note.md')  // → 'Notes/note.md'
 * getOriginalFromConflict('Notes/REMOTE_note.md') // → 'Notes/note.md'
 * getOriginalFromConflict('LOCAL_note.md')         // → 'note.md'
 * getOriginalFromConflict('Notes/note.md')         // → null
 */
/**
 * The plugin's manifest ID, used to construct the hardcoded exclusion path.
 * Must match the `id` field in `manifest.json`.
 */
const PLUGIN_ID = 'simple-storage-sync-and-backup';

/**
 * Check whether a vault-relative path falls inside this plugin's own settings directory.
 *
 * This is a hardcoded, non-overridable exclusion to prevent the plugin from syncing
 * its own `data.json` (which may contain a saved passphrase) or any other plugin
 * artefact (`main.js`, `manifest.json`, `styles.css`) to S3.
 *
 * @param path      - The vault-relative file path to test.
 * @param configDir - The vault config directory name (from `app.vault.configDir`,
 *                    typically `".obsidian"`).
 * @returns `true` if the path is inside the plugin's settings folder.
 */
export function isPluginOwnPath(path: string, configDir: string): boolean {
	const normalized = normalizePath(path);
	const pluginDir = `${normalizePath(configDir)}/plugins/${PLUGIN_ID}/`;
	return normalized.startsWith(pluginDir) || normalized === pluginDir.slice(0, -1);
}

export function getOriginalFromConflict(conflictPath: string): string | null {
    const dir = getDirectory(conflictPath);
    const filename = getFilename(conflictPath);

    let originalFilename: string;
    if (filename.startsWith('LOCAL_')) {
        originalFilename = filename.substring(6);
    } else if (filename.startsWith('REMOTE_')) {
        originalFilename = filename.substring(7);
    } else {
        return null;
    }

    return dir ? `${dir}/${originalFilename}` : originalFilename;
}
