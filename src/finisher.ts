/**
 * Post-turn finisher: at turn_end, apply the merged change set to disk.
 * Changes inside the project root are auto-approved; changes outside it
 * require confirmation (ctx.ui.confirm) or, headless, the
 * PI_OVERLAYFS_OUTSIDE_PROJECT=approve env var. Denied changes are simply
 * not applied (with the fork model there is no shared overlay to drop from).
 * Apply failures are collected per entry and reported — the model must learn
 * which changes did not persist.
 *
 * Dependencies are injected so the partition/apply/report logic is testable
 * against a real vfs template on temp dirs without a pi runtime.
 */
import nodePath from "node:path";
import { applyDiffToRealFs, type OverlayDiff, type OverlayWrite } from "@jerryan/just-bash";

/** One entry that could not be applied to disk. */
export interface ApplyFailure {
	path: string;
	error: string;
}

export interface FinisherDeps {
	/** The merged host-space change set for this turn. */
	diff(): OverlayDiff;
	/**
	 * Apply a subset, entry by entry. Returns the entries that FAILED
	 * (empty on full success) — failures are data, not exceptions.
	 */
	applyChanges(subset: OverlayDiff): Promise<ApplyFailure[]>;
	isUnderProject(realPath: string): boolean;
	/** True when the real path currently exists on disk as a directory. */
	isExistingDirectory(realPath: string): boolean;
	/** Ask the user once about the outside-project paths. Undefined when headless. */
	confirm?(outsidePaths: string[]): Promise<boolean>;
	/** Headless policy from PI_OVERLAYFS_OUTSIDE_PROJECT ("approve" | anything else = drop). */
	outsidePolicy(): string | undefined;
}

export interface FinisherReport {
	/** Entries applied to disk (inside-project auto-approved + approved outside). */
	applied: number;
	/** Outside-project paths DENIED by the user or the headless policy → not applied. */
	denied: string[];
	/**
	 * Approved but FAILED to apply (per-entry apply errors, or a confirm
	 * error). paths names exactly what was lost.
	 */
	failed: { error: string; paths: string[] } | null;
}

function isNoOpDirectoryWrite(write: OverlayWrite, isExistingDirectory: (p: string) => boolean): boolean {
	// The overlay stages the whole parent dir chain for every write. Directory
	// entries whose target already exists on disk are mkdir -p no-ops — never
	// bother the user with them; they are simply not applied.
	return write.nodeType === "directory" && isExistingDirectory(write.path);
}

function emptyDiff(): OverlayDiff {
	return { writes: [], deletions: [] };
}

/**
 * Partition a change set into inside-project and outside-project subsets.
 * No-op directory writes in the outside set are split out (never applied,
 * never prompted about).
 */
export function partitionChanges(
	changes: OverlayDiff,
	isUnderProject: (p: string) => boolean,
	isExistingDirectory: (p: string) => boolean,
): { inside: OverlayDiff; outside: OverlayDiff; noOpDirs: string[] } {
	const inside = emptyDiff();
	const outside = emptyDiff();
	const noOpDirs: string[] = [];

	for (const write of changes.writes) {
		if (isUnderProject(write.path)) {
			inside.writes.push(write);
		} else if (isNoOpDirectoryWrite(write, isExistingDirectory)) {
			noOpDirs.push(write.path);
		} else {
			outside.writes.push(write);
		}
	}
	for (const deletion of changes.deletions) {
		if (isUnderProject(deletion)) inside.deletions.push(deletion);
		else outside.deletions.push(deletion);
	}
	return { inside, outside, noOpDirs };
}

function realPathsOf(changes: OverlayDiff): string[] {
	return [...changes.deletions, ...changes.writes.map((w) => w.path)];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Host diffs join mount roots with "/" (browser-safe); normalize once up
 * front so confirms, reports, and applies all see native separators. */
function normalizeDiff(diff: OverlayDiff): OverlayDiff {
	return {
		writes: diff.writes.map((w) => ({ ...w, path: nodePath.normalize(w.path) })),
		deletions: diff.deletions.map((d) => nodePath.normalize(d)),
	};
}

/**
 * Apply a change set entry by entry (deletions deepest-first, then writes),
 * collecting per-entry failures instead of stopping at the first one — the
 * apply-or-drop warning wants to name exactly what was lost. Paths are
 * normalized first: host diffs join mount roots with "/" (browser-safe),
 * which applyDiffToRealFs rejects on Windows.
 */
export async function applyChangeSetPerEntry(
	subset: OverlayDiff,
	apply: (diff: OverlayDiff) => void | Promise<void> = applyDiffToRealFs,
): Promise<ApplyFailure[]> {
	const failures: ApplyFailure[] = [];
	const deletions = [...subset.deletions].sort((a, b) => b.length - a.length);
	for (const target of deletions) {
		try {
			await apply({ writes: [], deletions: [nodePath.normalize(target)] });
		} catch (error) {
			failures.push({ path: target, error: errorMessage(error) });
		}
	}
	for (const write of subset.writes) {
		try {
			await apply({ writes: [{ ...write, path: nodePath.normalize(write.path) }], deletions: [] });
		} catch (error) {
			failures.push({ path: write.path, error: errorMessage(error) });
		}
	}
	return failures;
}

export async function runFinisher(deps: FinisherDeps): Promise<FinisherReport> {
	const report: FinisherReport = { applied: 0, denied: [], failed: null };
	const changes = normalizeDiff(deps.diff());
	if (changes.writes.length === 0 && changes.deletions.length === 0) return report;

	const { inside, outside } = partitionChanges(changes, deps.isUnderProject, deps.isExistingDirectory);
	const failures: ApplyFailure[] = [];

	if (inside.writes.length > 0 || inside.deletions.length > 0) {
		const failed = await deps.applyChanges(inside);
		failures.push(...failed);
		report.applied += inside.writes.length + inside.deletions.length - failed.length;
	}

	if (outside.writes.length > 0 || outside.deletions.length > 0) {
		const outsidePaths = realPathsOf(outside);
		let approved = false;
		let confirmError: unknown;
		try {
			approved = deps.confirm
				? await deps.confirm(outsidePaths)
				: deps.outsidePolicy()?.toLowerCase() === "approve";
		} catch (error) {
			confirmError = error;
		}

		if (confirmError !== undefined) {
			const message = errorMessage(confirmError);
			failures.push(...outsidePaths.map((p) => ({ path: p, error: message })));
		} else if (approved) {
			const failed = await deps.applyChanges(outside);
			failures.push(...failed);
			report.applied += outsidePaths.length - failed.length;
		} else {
			report.denied = outsidePaths;
		}
	}

	if (failures.length > 0) {
		report.failed = { error: failures[0]!.error, paths: failures.map((f) => f.path) };
	}
	return report;
}
