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
 */
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import { Type } from "typebox";
import {
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createLocalBashOperations,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Bash, createVfsTemplate, type MountableFs, type VfsTemplate } from "@jerryan/just-bash";
import { createOverlayBashOperations, DEFAULT_TIMEOUT_SECONDS } from "./exec.js";
import { applyChangeSetPerEntry, runFinisher } from "./finisher.js";
import { computeOverlayTopology, type PathMapper } from "./paths.js";
import { createOverlayEditOps, createOverlayReadOps, createOverlayWriteOps } from "./tools/file-ops.js";
import { createPythonToolDefinition } from "./tools/python.js";

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
		// Same topology as read-only subagent sandboxes (see
		// computeOverlayTopology): the project is a subpath of the home overlay
		// when inside home, a second mount at /project otherwise.
		const { cwd, mounts, mapper, virtualCwd, virtualHome } = computeOverlayTopology(ctx.cwd, os.homedir());
		const template = createVfsTemplate({ mounts });
		const active: SessionState = { template, mapper, virtualCwd, turnForks: [] };
		state = active;

		const resolve = mapper.resolveToolPath;
		const localBashOps = createLocalBashOperations();
		const registerFork = (fork: MountableFs) => {
			active.turnForks.push(fork);
		};

		// bash: operations carry the fork routing; the built-in definition
		// (prompt, renderers, truncation) is reused unchanged.
		const bashOps = createOverlayBashOperations({
			forkBash: () => {
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
			registerFork,
			mapCwd: (hostCwd) => mapper.hostToVirtual(hostCwd),
			localOps: localBashOps,
		});
		const bashDef = createBashToolDefinition(cwd, { operations: bashOps });
		pi.registerTool({
			...bashDef,
			promptGuidelines: [...(bashDef.promptGuidelines ?? []), BASH_SPLIT_GUIDELINE],
			// The built-in schema says "no default timeout"; this extension
			// applies a default (see exec.ts), so the schema must not lie.
			parameters: Type.Object({
				command: Type.String({ description: "Shell command to execute" }),
				timeout: Type.Optional(
					Type.Number({ description: `Timeout in seconds (optional, defaults to ${DEFAULT_TIMEOUT_SECONDS})` }),
				),
			}),
		});

		// read/write/edit: built-in definitions; each call runs against a fresh
		// fork (live disk for reads; registered for the merge on write success).
		const readDef = createReadToolDefinition(cwd);
		pi.registerTool({
			...readDef,
			execute: (id, params, signal, onUpdate) =>
				createReadTool(cwd, { operations: createOverlayReadOps(template.fork(), resolve) }).execute(
					id,
					params,
					signal,
					onUpdate,
				),
			});

		// write/edit share one shape: fresh fork → execute → register on
		// completion (pi's tools throw on failure, so registration is
		// success-gated; a failed call's fork — and any partial write — is
		// simply never registered).
		const forkedFileToolExecute = <T extends { execute: (...args: never[]) => Promise<unknown> }>(
			makeTool: (fork: MountableFs) => T,
		): T["execute"] => {
			const wrapped = (async (...args: unknown[]) => {
				const fork = template.fork();
				const result = await makeTool(fork).execute(...(args as never[]));
				registerFork(fork);
				return result;
			}) as T["execute"];
			return wrapped;
		};

		const writeDef = createWriteToolDefinition(cwd);
		pi.registerTool({
			...writeDef,
			execute: forkedFileToolExecute(
				(fork) => createWriteTool(cwd, { operations: createOverlayWriteOps(fork, resolve) }),
			),
		});

		const editDef = createEditToolDefinition(cwd);
		pi.registerTool({
			...editDef,
			execute: forkedFileToolExecute(
				(fork) => createEditTool(cwd, { operations: createOverlayEditOps(fork, resolve) }),
			),
		});

		pi.registerTool(
			createPythonToolDefinition({
				forkBash: () => {
					const fork = template.fork();
					return {
						bash: new Bash({ fs: fork, python: true, cwd: virtualCwd, env: { HOME: virtualHome } }),
						fork,
					};
				},
				registerFork,
				resolveAbsolute: resolve,
				virtualCwd,
			}),
		);

		ctx.ui.notify(
			`pi-overlayfs: sandboxing bash/read/write/edit/python over ${mounts.map((m) => m.at).join(", ")}`,
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
