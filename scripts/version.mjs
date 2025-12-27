/**
 * =============================================================================
 * Version Management Script
 * =============================================================================
 *
 * This script updates version information across Obsidian plugin files.
 * It's designed to work with both npm lifecycle hooks and direct CLI usage.
 *
 * Usage:
 *   - Via npm:  `npm version <version>`  (uses npm_package_version env var)
 *   - Via CLI:  `node scripts/version.mjs 1.2.3`
 *   - Via CI:   Called by release-please workflow during releases
 *
 * What it does:
 *   1. Updates the `version` field in manifest.json
 *   2. Conditionally updates versions.json (Obsidian compatibility tracking)
 *
 * Files modified:
 *   - manifest.json:  Plugin manifest with version and minAppVersion
 *   - versions.json:  Maps plugin versions to minimum Obsidian versions
 *
 * Note: versions.json is only updated when minAppVersion changes to avoid
 * creating redundant entries for each release.
 *
 * =============================================================================
 */

import { readFileSync, writeFileSync } from "fs";

// -----------------------------------------------------------------------------
// Version Resolution
// -----------------------------------------------------------------------------
// Support both npm lifecycle (npm_package_version) and CLI argument.
// Priority: CLI argument > npm_package_version environment variable
// -----------------------------------------------------------------------------
const targetVersion = process.env.npm_package_version || process.argv[2];

if (!targetVersion) {
	console.error("No version specified. Use via npm version or pass as argument.");
	process.exit(1);
}

// -----------------------------------------------------------------------------
// Update manifest.json
// -----------------------------------------------------------------------------
// Read the current manifest, update the version, and write it back.
// The minAppVersion is preserved and used for versions.json updates.
// -----------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// -----------------------------------------------------------------------------
// Update versions.json (Conditional)
// -----------------------------------------------------------------------------
// Obsidian uses versions.json to determine the minimum app version required
// for each plugin version. We only add a new entry when minAppVersion changes
// to keep the file clean and avoid redundant entries.
//
// Format: { "plugin-version": "min-obsidian-version", ... }
// -----------------------------------------------------------------------------
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!Object.values(versions).includes(minAppVersion)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
}

// Log the version update for visibility in CI/CD logs
console.log(`Version: ${targetVersion}, minAppVersion: ${minAppVersion}`);
