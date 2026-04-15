/**
 * Pure-function decision table for three-way sync reconciliation.
 *
 * Given a {@link DecisionInput} (local/remote classification plus conflict
 * state), returns the {@link SyncPlanItem} action to execute.  The function
 * is deterministic and side-effect-free — all I/O happens in SyncPlanner
 * (before) and SyncExecutor (after).
 */

import {
	ConflictMode,
	DecisionInput,
	SyncAction,
	SyncPlanItem,
} from '../types';

/**
 * Decide the sync action for a single file path.
 *
 * The decision is split into three modes:
 * 1. **Unresolved conflict** — artifacts present or user resolved
 * 2. **No baseline** — first sync for this file
 * 3. **Baseline exists** — standard three-way comparison
 */
export function decide(input: DecisionInput): SyncPlanItem {
	if (input.hasUnresolvedConflict) {
		return decideConflictMode(input);
	}

	const isFirstSync = input.local === 'L+' || input.remote === 'R+';

	if (isFirstSync) {
		return decideNoBaseline(input);
	}

	if (!input.hasBaseline) {
		return decideNoBaseline(input);
	}

	return decideWithBaseline(input);
}

/**
 * Mode 1: An unresolved conflict record exists for this path.
 *
 * | Local original | Artifacts present | Action         |
 * |----------------|-------------------|----------------|
 * | any            | yes               | skip           |
 * | exists         | no                | upload (resolved) |
 * | absent + R exists  | no            | delete-remote  |
 * | absent + R absent  | no            | forget         |
 */
function decideConflictMode(input: DecisionInput): SyncPlanItem {
	if (input.hasConflictArtifacts) {
		return plan(input.path, 'skip', 'Unresolved conflict — artifacts still present');
	}

	if (input.localExists) {
		return plan(input.path, 'upload', 'Conflict resolved — uploading local version');
	}

	if (input.remoteExists) {
		return plan(input.path, 'delete-remote', 'Conflict resolved — local deleted, cleaning up remote');
	}

	return plan(input.path, 'forget', 'Conflict resolved — both sides absent, removing baseline');
}

/**
 * Mode 2: No baseline exists (first sync for this file).
 *
 * | Local | Remote | Action                                  |
 * |-------|--------|-----------------------------------------|
 * | L0    | R0     | skip                                    |
 * | L+    | R0     | upload                                  |
 * | L0    | R+     | download                                |
 * | L+    | R+     | adopt (same fingerprint) / conflict(both) |
 */
function decideNoBaseline(input: DecisionInput): SyncPlanItem {
	const { local, remote, path } = input;

	if (local === 'L0' && remote === 'R0') {
		return plan(path, 'skip', 'Neither local nor remote exists');
	}

	if (local === 'L+' && remote === 'R0') {
		return plan(path, 'upload', 'New local file — no remote counterpart');
	}

	if (local === 'L0' && remote === 'R+') {
		return plan(path, 'download', 'New remote file — no local counterpart');
	}

	if (local === 'L+' && remote === 'R+') {
		if (fingerprintsMatch(input)) {
			return plan(path, 'adopt', 'First sync — local and remote content identical');
		}
		return planConflict(path, 'both', 'First sync — local and remote content differ');
	}

	return plan(path, 'skip', 'No action needed');
}

/**
 * Mode 3: Baseline exists — standard three-way comparison.
 *
 * | Local | Remote | Action                                          |
 * |-------|--------|-------------------------------------------------|
 * | L=    | R=     | skip                                            |
 * | LΔ    | R=     | upload                                          |
 * | L=    | RΔ     | download                                        |
 * | LΔ    | RΔ     | adopt (same fingerprint) / conflict(both)       |
 * | L0    | R=     | delete-remote                                   |
 * | L=    | R0     | delete-local                                    |
 * | L0    | R0     | forget                                          |
 * | LΔ    | R0     | conflict(local-only) — local edited, remote gone |
 * | L0    | RΔ     | conflict(remote-only) — remote edited, local gone |
 */
function decideWithBaseline(input: DecisionInput): SyncPlanItem {
	const { local, remote, path } = input;

	if (local === 'L=' && remote === 'R=') {
		return plan(path, 'skip', 'Both sides match baseline');
	}

	if (local === 'LΔ' && remote === 'R=') {
		return plan(path, 'upload', 'Local modified, remote unchanged');
	}

	if (local === 'L=' && remote === 'RΔ') {
		return plan(path, 'download', 'Remote modified, local unchanged');
	}

	if (local === 'LΔ' && remote === 'RΔ') {
		if (fingerprintsMatch(input)) {
			return plan(path, 'adopt', 'Both sides changed to identical content');
		}
		return planConflict(path, 'both', 'Both sides modified with different content');
	}

	if (local === 'L0' && remote === 'R=') {
		return plan(path, 'delete-remote', 'Locally deleted, remote unchanged');
	}

	if (local === 'L=' && remote === 'R0') {
		return plan(path, 'delete-local', 'Remotely deleted, local unchanged');
	}

	if (local === 'L0' && remote === 'R0') {
		return plan(path, 'forget', 'Both sides deleted — removing stale baseline');
	}

	if (local === 'LΔ' && remote === 'R0') {
		return planConflict(path, 'local-only', 'Local modified but remote was deleted');
	}

	if (local === 'L0' && remote === 'RΔ') {
		return planConflict(path, 'remote-only', 'Remote modified but local was deleted');
	}

	return plan(path, 'skip', `Unhandled state: local=${local} remote=${remote}`);
}

function fingerprintsMatch(input: DecisionInput): boolean {
	return (
		input.localFingerprint !== undefined &&
		input.remoteFingerprint !== undefined &&
		input.localFingerprint === input.remoteFingerprint
	);
}

function plan(path: string, action: SyncAction, reason: string): SyncPlanItem {
	return { path, action, reason };
}

function planConflict(path: string, mode: ConflictMode, reason: string): SyncPlanItem {
	return { path, action: 'conflict', conflictMode: mode, reason };
}
