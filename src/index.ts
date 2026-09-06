/**
 * pi-overlayfs — route pi's file-touching tools (bash, read, write, edit +
 * a new python tool) through a virtual overlay filesystem
 * (@jerryan/just-bash createAgentSandbox).
 *
 * Writes stage in a copy-on-write memory layer over the real home/project
 * dirs. After each mutating tool call a finisher applies staged changes to
 * disk: auto-approved inside the project root, user-confirmed
 * (ctx.ui.confirm) outside it. Headless (no UI), outside-project changes are
 * dropped unless PI_OVERLAYFS_OUTSIDE_PROJECT=approve.
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
import { type AgentSandbox, createAgentSandbox } from "@jerryan/just-bash";
import { createOverlayBashOperations, DEFAULT_TIMEOUT_SECONDS } from "./exec.js";

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
import { dropStagedPaths, runFinisher } from "./finisher.js";
import { AsyncMutex } from "./mutex.js";
import { canonicalizeHostPathFs, createPathMapper, type PathMapper } from "./paths.js";
import { createOverlayEditOps, createOverlayReadOps, createOverlayWriteOps, type OverlayVfs } from "./tools/file-ops.js";
import { createPythonBash, createPythonToolDefinition } from "./tools/python.js";

interface SessionState {
	sandbox: AgentSandbox;
	mapper: PathMapper;
	virtualCwd: string;
}

export default function (pi: ExtensionAPI) {
	// Serializes MUTATING executions (bash sandboxed route, python, write,
	// edit) so the H1 abort-discard never eats a concurrent sibling's staged
	// writes — path-level before/after attribution cannot separate same-window
	// writers. Phase 2 replaces this with per-call overlay branches + merge
	// (the branch IS the attribution), after which executions go concurrent.
	const mutex = new AsyncMutex();
	let state: SessionState | undefined;

	pi.on("session_start", async (_event, ctx) => {
		// Canonicalize up front (symlinked cwd / $HOME, e.g. macOS /tmp): the
		// sandbox realpaths its overlay roots internally, and the mapper must
		// compare against the same canonical spelling or every lookup misses
		// (silent native fallback + outside-project misclassification).
		const cwd = canonicalizeHostPathFs(ctx.cwd);
		const home = canonicalizeHostPathFs(os.homedir());
		const sandbox = createAgentSandbox({
			home,
			project: cwd,
			abortOnUnresolvedCommands: true,
		});
		const mapper = createPathMapper({
			overlays: [...sandbox.overlays.entries()].map(([mountPoint, { root }]) => ({ mountPoint, root })),
			projectRoot: cwd,
		});
		const virtualCwd = mapper.hostToVirtual(cwd)?.virtualPath ?? "/";
		const vfs: OverlayVfs = sandbox.bash.fs;
		const pythonBash = createPythonBash(sandbox.bash.fs, virtualCwd);
		state = { sandbox, mapper, virtualCwd };

		const resolve = (absolutePath: string) => mapper.resolveToolPath(absolutePath);
		const localBashOps = createLocalBashOperations();

		// bash: operations carry the sandbox routing; the built-in definition
		// (prompt, renderers, truncation) is reused unchanged.
		const bashOps = createOverlayBashOperations({
			bash: sandbox.bash,
			mapCwd: (hostCwd) => mapper.hostToVirtual(hostCwd)?.virtualPath ?? null,
			localOps: localBashOps,
			runExclusive: (fn) => mutex.run(fn),
			getStagedPaths: () => [...sandbox.diff().deletions, ...sandbox.diff().writes.map((w) => w.path)],
			dropStagedPathsExcept: (keepPaths) => {
				// NOTE (path granularity): the keep-set is path-based. If the
				// aborted run overwrote a path that was ALREADY pending before the
				// run (only reachable after a prior finisher failure), that path
				// keeps the aborted run's content and a later finisher retry may
				// apply it over the native rerun's result — accepted narrow case.
				const keep = new Set(keepPaths);
				const pending = sandbox.diff();
				const stale = [
					...pending.deletions.filter((p) => !keep.has(p)),
					...pending.writes.map((w) => w.path).filter((p) => !keep.has(p)),
				];
				dropStagedPaths(sandbox, mapper, stale);
			},
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

		// read/write/edit: built-in definitions, execute delegated to built-in
		// tools created with overlay operations (hoisted here, closing over vfs).
		const readTool = createReadTool(cwd, { operations: createOverlayReadOps(vfs, resolve) });
		const readDef = createReadToolDefinition(cwd);
		pi.registerTool({
			...readDef,
			execute: (id, params, signal, onUpdate) => readTool.execute(id, params, signal, onUpdate),
		});

		const writeTool = createWriteTool(cwd, { operations: createOverlayWriteOps(vfs, resolve) });
		const writeDef = createWriteToolDefinition(cwd);
		pi.registerTool({
			...writeDef,
			execute: (id, params, signal, onUpdate) =>
				mutex.run(() => writeTool.execute(id, params, signal, onUpdate)),
		});

		const editTool = createEditTool(cwd, { operations: createOverlayEditOps(vfs, resolve) });
		const editDef = createEditToolDefinition(cwd);
		pi.registerTool({
			...editDef,
			execute: (id, params, signal, onUpdate) =>
				mutex.run(() => editTool.execute(id, params, signal, onUpdate)),
		});

		pi.registerTool(
			createPythonToolDefinition({
				vfs,
				pythonBash,
				resolveAbsolute: resolve,
				virtualCwd,
				runExclusive: (fn) => mutex.run(fn),
			}),
		);

		ctx.ui.notify(
			`pi-overlayfs: sandboxing bash/read/write/edit/python over ${[...sandbox.overlays.keys()].join(", ")}`,
			"info",
		);
	});

	pi.on("session_shutdown", async () => {
		state = undefined;
	});

	// The finisher runs once per turn at turn_end. pi fully awaits every tool
	// execution in the batch BEFORE emitting turn_end (agent-loop), and awaits
	// this handler before the next LLM call — so nothing can be in flight and
	// the finisher sees only quiescent staged state. getSteeringMessages() is
	// polled immediately after turn_end, so drop warnings land before the
	// model's next call.
	pi.on("turn_end", async (_event, ctx) => {
		const active = state;
		if (!active) return;
		// Fast path: nothing staged → nothing to finish.
		const pending = active.sandbox.diff();
		if (pending.writes.length === 0 && pending.deletions.length === 0) return;
		// Uncontended today (all executions completed before turn_end); the
		// lock merely preserves the executions-vs-finisher invariant if
		// background execution ever appears.
		const report = await mutex.run(async () => {
			try {
				return await runFinisher({
					diff: () => active.sandbox.diff(),
					applyChanges: (subset) => active.sandbox.applyChanges(subset),
					drop: (realPaths) => dropStagedPaths(active.sandbox, active.mapper, realPaths),
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
				// A finisher failure must never break the session; unapplied
				// entries stay pending and retry on the next turn_end.
				const message = error instanceof Error ? error.message : String(error);
				console.error(`pi-overlayfs: finisher failed: ${message}`);
				try {
					ctx.ui.notify(`pi-overlayfs: failed to apply staged changes: ${message}`, "error");
				} catch {
					/* no UI */
				}
				return undefined;
			}
		});
		// Rejection honesty: tool results stay untouched (success in the
		// overlay IS success), and the model hears about discarded changes via
		// a steering message before its next LLM call.
		if (report && report.droppedDenied.length > 0) {
			const paths = report.droppedDenied;
			try {
				pi.sendMessage(
					{
						customType: "pi-overlayfs",
						display: true,
						content:
							`${paths.length} change${paths.length === 1 ? "" : "s"} outside the project root ` +
							`were rejected and discarded without touching disk:\n${paths.map((p) => `- ${p}`).join("\n")}\n` +
							`They existed only in a temporary filesystem; subsequent reads will not find them.`,
					},
					{ deliverAs: "steer" },
				);
			} catch (error) {
				console.error(`pi-overlayfs: failed to send discard warning: ${error instanceof Error ? error.message : error}`);
			}
		}
	});
}

