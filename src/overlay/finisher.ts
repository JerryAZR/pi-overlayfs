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

/**
 * A staged change with a git-status-style code (A/M/D, `git status --short`
 * vocabulary). The overlay has no rename detection: a move is D + A, a
 * symlink replacing a file is D + A. `target` is the symlink target for
 * symlink writes.
 */
export interface LabeledChange {
	code: "A" | "M" | "D";
	path: string;
	target?: string;
}

export function formatLabeledChange(change: LabeledChange): string {
	return ` ${change.code} ${change.path}${change.target !== undefined ? ` -> ${change.target}` : ""}`;
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
	/** True when the real path currently exists on disk (A vs M labels). */
	pathExists(realPath: string): boolean;
	/** Ask the user once about the outside-project changes. Undefined when headless. */
	confirm?(outside: LabeledChange[]): Promise<boolean>;
	/** Headless policy from PI_OVERLAYFS_OUTSIDE_PROJECT ("approve" | anything else = drop). */
	outsidePolicy(): string | undefined;
}

export interface FinisherReport {
	/** Entries applied to disk (inside-project auto-approved + approved outside). */
	applied: number;
	/** Outside-project changes DENIED by the user or the headless policy → not applied. */
	denied: LabeledChange[];
	/**
	 * Approved but FAILED: per-entry apply errors (kind "apply") or a confirm
	 * that threw (kind "confirm" — the user never answered; nothing was
	 * applied). failures names exactly what was lost, with per-path errors.
	 */
	failed: { kind: "apply" | "confirm"; error: string; failures: { change: LabeledChange; error: string }[] } | null;
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
 * No-op directory writes (the staged parent chain of dirs that already
 * exist on disk) are silently excluded from the outside set — never
 * applied, never prompted about.
 */
export function partitionChanges(
	changes: OverlayDiff,
	isUnderProject: (p: string) => boolean,
	isExistingDirectory: (p: string) => boolean,
): { inside: OverlayDiff; outside: OverlayDiff } {
	const inside = emptyDiff();
	const outside = emptyDiff();

	for (const write of changes.writes) {
		if (isUnderProject(write.path)) {
			inside.writes.push(write);
		} else if (!isNoOpDirectoryWrite(write, isExistingDirectory)) {
			outside.writes.push(write);
		}
	}
	for (const deletion of changes.deletions) {
		if (isUnderProject(deletion)) inside.deletions.push(deletion);
		else outside.deletions.push(deletion);
	}
	return { inside, outside };
}

function realPathsOf(changes: OverlayDiff): string[] {
	return [...changes.deletions, ...changes.writes.map((w) => w.path)];
}

const textDecoder = new TextDecoder();

function labelWrite(write: OverlayWrite, pathExists: (p: string) => boolean): LabeledChange {
	if (write.nodeType === "symlink") {
		return {
			code: pathExists(write.path) ? "M" : "A",
			path: write.path,
			target: textDecoder.decode(write.content),
		};
	}
	if (write.metadataOnly) return { code: "M", path: write.path };
	// Directory entries whose target already exists are filtered before
	// labeling (mkdir -p no-ops); a staged directory that reaches here is new.
	return { code: pathExists(write.path) ? "M" : "A", path: write.path };
}

/** Git-status-style labels for a change set (A/M/D — see LabeledChange).
 * The A/M verdict is an existence probe at finish time — a TOCTOU by design:
 * disk can change between diff and apply (native-route calls, the user), and
 * a dangling symlink probes as absent → "A". Cosmetic only: labels feed
 * dialogs and reports, never the apply decision. */
export function labelChanges(changes: OverlayDiff, pathExists: (p: string) => boolean): LabeledChange[] {
	return [
		...changes.deletions.map((path): LabeledChange => ({ code: "D", path })),
		...changes.writes.map((w) => labelWrite(w, pathExists)),
	];
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
	// Deepest-first deletions: an ancestor path is always a strictly shorter
	// string, and whiteouts never nest within one overlay — so string length
	// is a valid depth proxy (not a hack to "fix").
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
	let confirmThrew = false;
	// Labels for every staged path (inside and outside) so reports and the
	// confirm can all speak in A/M/D. A path staged as both deletion and
	// write is an odd race survivor; last label wins, the apply decides.
	const labels = new Map(labelChanges(changes, deps.pathExists).map((l) => [l.path, l]));
	const labeled = (path: string): LabeledChange => labels.get(path) ?? { code: "M", path };

	if (inside.writes.length > 0 || inside.deletions.length > 0) {
		const failed = await deps.applyChanges(inside);
		failures.push(...failed);
		report.applied += inside.writes.length + inside.deletions.length - failed.length;
	}

	if (outside.writes.length > 0 || outside.deletions.length > 0) {
		const outsideChanges = realPathsOf(outside).map(labeled);
		let approved = false;
		let confirmError: unknown;
		try {
			approved = deps.confirm
				? await deps.confirm(outsideChanges)
				: deps.outsidePolicy()?.toLowerCase() === "approve";
		} catch (error) {
			confirmError = error;
		}

		if (confirmError !== undefined) {
			confirmThrew = true;
			const message = errorMessage(confirmError);
			failures.push(...realPathsOf(outside).map((p) => ({ path: p, error: message })));
		} else if (approved) {
			const failed = await deps.applyChanges(outside);
			failures.push(...failed);
			report.applied += outsideChanges.length - failed.length;
		} else {
			report.denied = outsideChanges;
		}
	}

	if (failures.length > 0) {
		report.failed = {
			kind: confirmThrew ? "confirm" : "apply",
			error: failures[0]!.error,
			failures: failures.map((f) => ({ change: labeled(f.path), error: f.error })),
		};
	}
	return report;
}
