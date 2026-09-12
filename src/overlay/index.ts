/**
 * pi-overlayfs — route pi's file-touching tools (bash, read, write, edit +
 * a new python tool) through per-call copy-on-write filesystem forks
 * (@jerryan/just-bash createVfsTemplate).
 *
 * Every tool call gets a fresh COW fork over the real home (and project, when
 * outside home) dirs; /tmp is shared scratch. Calls run fully concurrently —
 * isolation comes from the topology, not from locking. At turn_end the
 * turn's forks are merged (deterministic: later changedAt wins) into one
 * change set, which a finisher applies to disk: auto-approved inside the
 * project root, user-confirmed (ctx.ui.confirm) outside it. Headless (no
 * UI), outside-project changes are dropped unless
 * PI_OVERLAYFS_OUTSIDE_PROJECT=approve. Calls that ABORT, time out, or fall
 * back to native never register their fork, so their partial writes never
 * reach the merge; completed calls register regardless of exit code (effects
 * before a failure are legitimate).
 *
 * Tool construction is shared with read-only subagent sandboxes — see
 * tool-surface.ts; this file is the rw configuration plus the finisher.
 */
import { existsSync, statSync } from "node:fs";
import { createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Bash, type MountableFs, type VfsTemplate } from "@jerryan/just-bash";
import { applyChangeSetPerEntry, runFinisher } from "./finisher.js";
import type { PathMapper } from "./paths.js";
import { createForkedToolSurface } from "./tool-surface.js";

/**
 * Proactive form of the mixed-call rule enforced in exec.ts: the model should
 * know BEFORE composing a command that deletion verbs can't ride along with
 * natively-routed dev tools. The error message is the backstop that names
 * the specific violation. Keep the two texts consistent.
 */
const BASH_SPLIT_GUIDELINE =
	"The bash tool runs file commands (rm, mv, cp, ls, grep, ...) in a sandbox and dev-toolchain commands " +
	"(git, npm, cargo, node, python, ...) natively on the host. Never combine rm, mv or rmdir with host-run " +
	"dev tools in a single call - the deletion must be its own separate bash call. Combining rm/mv with " +
	"other file commands in one call is fine.";

interface SessionState {
	template: VfsTemplate;
	mapper: PathMapper;
	virtualCwd: string;
	/** Forks of this turn's successful mutating calls, merged at turn_end. */
	turnForks: MountableFs[];
}

export default function (pi: ExtensionAPI) {
	let state: SessionState | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// The rw configuration of the shared tool surface: native fallback
		// (localOps), real fork registration for the turn_end merge, and
		// fail-fast unresolved detection (the fallback decision needs it).
		let active: SessionState;
		const surface = createForkedToolSurface({
			cwd: ctx.cwd,
			forkBash: ({ template, virtualCwd, virtualHome }) => {
				const fork = template.fork();
				return {
					bash: new Bash({
						fs: fork,
						cwd: virtualCwd,
						env: { HOME: virtualHome },
						abortOnUnresolvedCommands: true,
					}),
					fork,
				};
			},
			registerFork: (fork) => {
				active.turnForks.push(fork);
			},
			localOps: createLocalBashOperations(),
			bashGuidelines: [BASH_SPLIT_GUIDELINE],
		});
		active = {
			template: surface.template,
			mapper: surface.mapper,
			virtualCwd: surface.virtualCwd,
			turnForks: [],
		};
		state = active;

		pi.registerTool(surface.tools.bash);
		pi.registerTool(surface.tools.read);
		pi.registerTool(surface.tools.write);
		pi.registerTool(surface.tools.edit);
		pi.registerTool(surface.tools.python);

		ctx.ui.notify(
			`pi-overlayfs: sandboxing bash/read/write/edit/python over ${surface.mounts.map((m) => m.at).join(", ")}`,
			"info",
		);
	});

	pi.on("session_shutdown", async () => {
		state = undefined;
	});

	// The finisher runs once per turn at turn_end. pi fully awaits every tool
	// execution in the batch BEFORE emitting turn_end (agent-loop), and awaits
	// this handler before the next LLM call — so nothing can be in flight when
	// the turn's forks are merged and applied. getSteeringMessages() is polled
	// immediately after turn_end, so drop warnings land before the model's
	// next call.
	pi.on("turn_end", async (_event, ctx) => {
		const active = state;
		if (!active || active.turnForks.length === 0) return;
		const forks = active.turnForks;
		active.turnForks = [];

		const merged = await active.template.merge(forks);
		const hostDiff = merged.diff({ space: "host" });
		let report;
		try {
			report = await runFinisher({
				diff: () => hostDiff,
				applyChanges: (subset) => applyChangeSetPerEntry(subset),
				isUnderProject: (p) => active.mapper.isUnderProject(p),
				isExistingDirectory: (p) => {
					try {
						return existsSync(p) && statSync(p).isDirectory();
					} catch {
						return false;
					}
				},
				confirm: ctx.hasUI
					? (outsidePaths) =>
							ctx.ui.confirm(
								`${outsidePaths.length} staged change${outsidePaths.length === 1 ? "" : "s"} outside project root`,
								`The sandbox staged changes outside the project root:\n\n${outsidePaths.join("\n")}\n\nApply them to disk?`,
							)
					: undefined,
				outsidePolicy: () => process.env.PI_OVERLAYFS_OUTSIDE_PROJECT,
			});
		} catch (error) {
			// Defensive: runFinisher reports apply/confirm failures as data.
			const message = error instanceof Error ? error.message : String(error);
			console.error(`pi-overlayfs: finisher failed: ${message}`);
			try {
				ctx.ui.notify(`pi-overlayfs: failed to apply staged changes: ${message}`, "error");
			} catch {
				/* no UI */
			}
			return;
		}

		if (report.failed) {
			try {
				ctx.ui.notify(`pi-overlayfs: failed to apply staged changes: ${report.failed.error}`, "error");
			} catch {
				/* no UI */
			}
		}
		// Rejection/failure honesty: tool results stay untouched (success in
		// the overlay IS success), and the model hears about discarded changes
		// via a steering message before its next LLM call.
		const sections: string[] = [];
		if (report.denied.length > 0) {
			const paths = report.denied;
			sections.push(
				`${paths.length} change${paths.length === 1 ? "" : "s"} outside the project root ` +
					`were rejected and discarded without touching disk:\n${paths.map((p) => `- ${p}`).join("\n")}`,
			);
		}
		if (report.failed && report.failed.paths.length > 0) {
			const paths = report.failed.paths;
			sections.push(
				`${paths.length} staged change${paths.length === 1 ? "" : "s"} could not be written to disk ` +
					`and were discarded:\n${paths.map((p) => `- ${p}`).join("\n")}`,
			);
		}
		if (sections.length > 0) {
			try {
				pi.sendMessage(
					{
						customType: "pi-overlayfs",
						display: true,
						content:
							sections.join("\n") +
							"\nThey existed only in a temporary filesystem; subsequent reads will not find them.",
					},
					{ deliverAs: "steer" },
				);
			} catch (error) {
				console.error(`pi-overlayfs: failed to send discard warning: ${error instanceof Error ? error.message : error}`);
			}
		}
	});
}
