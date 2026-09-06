/**
 * Post-turn finisher: at turn_end, apply staged overlay changes to disk.
 * Changes inside the project root are auto-approved; changes outside it
 * require confirmation (ctx.ui.confirm) or, headless, the
 * PI_OVERLAYFS_OUTSIDE_PROJECT=approve env var. Denied changes are dropped
 * from the overlay (never applied). Apply-or-drop: a failure during
 * confirm/apply discards the unapplied remainder and reports it — no staged
 * change survives across turns.
 *
 * Dependencies are injected so the partition/apply/drop logic is testable
 * against a real sandbox on temp dirs without a pi runtime.
 */
import type { AgentSandbox, SandboxChangeSet, SandboxWrite } from "@jerryan/just-bash";
import { hostPathsEqual, type PathMapper } from "./paths.js";

export interface FinisherDeps {
	diff(): SandboxChangeSet;
	applyChanges(subset: SandboxChangeSet): Promise<void>;
	/** Drop pending staged entries by real host path (never applied). */
	drop(realPaths: string[]): void;
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
	/** Outside-project paths DENIED by the user or the headless policy → dropped. */
	denied: string[];
	/**
	 * Approved but FAILED to apply (apply or confirm error) → dropped per the
	 * apply-or-drop policy. paths excludes no-op directory scaffolding.
	 */
	failed: { error: string; paths: string[] } | null;
}

function isNoOpDirectoryWrite(write: SandboxWrite, isExistingDirectory: (p: string) => boolean): boolean {
	// The overlay stages the whole parent dir chain for every write. Directory
	// entries whose target already exists on disk are mkdir -p no-ops — never
	// bother the user with them; just drop them.
	return write.nodeType === "directory" && isExistingDirectory(write.path);
}

function emptyChangeSet(): SandboxChangeSet {
	return { writes: [], deletions: [] };
}

/**
 * Partition a change set into inside-project and outside-project subsets.
 * No-op directory writes in the outside set are split out for silent dropping.
 */
export function partitionChanges(
	changes: SandboxChangeSet,
	isUnderProject: (p: string) => boolean,
	isExistingDirectory: (p: string) => boolean,
): { inside: SandboxChangeSet; outside: SandboxChangeSet; noOpDirs: string[] } {
	const inside = emptyChangeSet();
	const outside = emptyChangeSet();
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

function realPathsOf(changes: SandboxChangeSet): string[] {
	return [...changes.deletions, ...changes.writes.map((w) => w.path)];
}

export async function runFinisher(deps: FinisherDeps): Promise<FinisherReport> {
	const report: FinisherReport = { applied: 0, denied: [], failed: null };
	const changes = deps.diff();
	if (changes.writes.length === 0 && changes.deletions.length === 0) return report;

	const { inside, outside, noOpDirs } = partitionChanges(
		changes,
		deps.isUnderProject,
		deps.isExistingDirectory,
	);

	if (noOpDirs.length > 0) {
		deps.drop(noOpDirs);
	}

	try {
		if (inside.writes.length > 0 || inside.deletions.length > 0) {
			await deps.applyChanges(inside);
			report.applied += inside.writes.length + inside.deletions.length;
		}

		if (outside.writes.length > 0 || outside.deletions.length > 0) {
			const outsidePaths = realPathsOf(outside);
			const approved = deps.confirm
				? await deps.confirm(outsidePaths)
				: deps.outsidePolicy()?.toLowerCase() === "approve";

			if (approved) {
				await deps.applyChanges(outside);
				report.applied += outsidePaths.length;
			} else {
				deps.drop(outsidePaths);
				report.denied = outsidePaths;
			}
		}
	} catch (error) {
		// Apply-or-drop: a failure never leaves pending residue across turns.
		// (applyChanges drops the entries it already applied, so the remaining
		// diff is exactly the unapplied remainder.) Drop it and report it —
		// the model must learn its changes did not persist.
		const remaining = deps.diff();
		const remainingPaths = realPathsOf(remaining);
		if (remainingPaths.length > 0) {
			try {
				deps.drop(remainingPaths);
			} catch {
				/* drop is best-effort */
			}
		}
		report.failed = {
			error: error instanceof Error ? error.message : String(error),
			paths: [
				...remaining.deletions,
				...remaining.writes
					.filter((w) => !isNoOpDirectoryWrite(w, deps.isExistingDirectory))
					.map((w) => w.path),
			],
		};
	}
	return report;
}

/**
 * Drop pending staged entries by real host path, grouped per overlay so each
 * OverlayFs.drop() call gets its full list (drop handles nested paths
 * deepest-first; dropping one path per call would leave parent dir nodes
 * behind whenever their children are dropped afterwards).
 */
export function dropStagedPaths(
	sandbox: Pick<AgentSandbox, "overlays">,
	mapper: Pick<PathMapper, "realToOverlayRelative">,
	realPaths: string[],
): void {
	const byOverlay = new Map<string, { fs: { drop(paths: string[]): void }; relPaths: string[] }>();
	for (const realPath of realPaths) {
		const found = mapper.realToOverlayRelative(realPath);
		if (!found) {
			console.warn(`pi-overlayfs: cannot drop staged path (under no overlay root): ${realPath}`);
			continue;
		}
		// Normalization-aware match: the mapper's (canonicalized) root spelling
		// can diverge from the sandbox's (plain-realpath) root on casing — an
		// exact === would silently skip the drop and the finisher would
		// re-prompt forever.
		const entry = [...sandbox.overlays.values()].find((o) => hostPathsEqual(o.root, found.overlayRoot));
		if (!entry) {
			console.warn(`pi-overlayfs: cannot drop staged path (no overlay for root ${found.overlayRoot}): ${realPath}`);
			continue;
		}
		let group = byOverlay.get(found.overlayRoot);
		if (!group) {
			group = { fs: entry.fs, relPaths: [] };
			byOverlay.set(found.overlayRoot, group);
		}
		group.relPaths.push(found.overlayRelativePath);
	}
	for (const group of byOverlay.values()) {
		group.fs.drop(group.relPaths);
	}
}
