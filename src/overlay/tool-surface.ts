/**
 * Shared tool-surface assembly: one VfsTemplate + the five forked tool
 * definitions (bash, read, write, edit, python), wired identically for the
 * main session and for read-only subagent children. The rw/ro differences
 * are injected as knobs:
 *
 *   - forkBash:      the Bash flavor for the bash tool (main: fail-fast on
 *                    unresolved commands for the native-fallback decision;
 *                    read-only: just-git inside, fs-error conversion)
 *   - registerFork:  main pushes to the turn's merge list; read-only is a
 *                    no-op (nothing is ever merged)
 *   - localOps:      present = native fallback enabled (main); absent =
 *                    fail-closed, nothing ever runs natively (read-only)
 *   - bashGuidelines: extra prompt guidelines (main appends the mixed-call
 *                    split rule; read-only has no native route, so none)
 *
 * The python tool needs no bash knob: its forkBash is identical at both
 * call sites (only registerFork differed).
 */
import os from "node:os";
import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Bash, createVfsTemplate, type MountableFs, type VfsTemplate } from "@jerryan/just-bash";
import { Type } from "typebox";
import { createOverlayBashOperations, DEFAULT_TIMEOUT_SECONDS, type SandboxBash } from "./exec.js";
import { computeOverlayTopology, type PathMapper } from "./paths.js";
import { createOverlayEditOps, createOverlayReadOps, createOverlayWriteOps } from "./tools/file-ops.js";
import { createPythonToolDefinition } from "./tools/python.js";

/** Context handed to the forkBash knob: everything a Bash flavor needs. */
export interface ForkBashContext {
	template: VfsTemplate;
	virtualCwd: string;
	virtualHome: string;
}

export interface ForkedToolSurfaceOptions {
	/** Host cwd of the session (topology input). */
	cwd: string;
	/** Host home dir (topology input). Defaults to os.homedir(). */
	home?: string;
	/** Bash flavor for the bash tool, over a fresh fork per call. */
	forkBash(ctx: ForkBashContext): { bash: SandboxBash; fork: MountableFs };
	/** Register a completed call's fork for the turn_end merge (no-op for read-only). */
	registerFork(fork: MountableFs): void;
	/** Native fallback ops; omit for fail-closed (read-only) sandboxes. */
	localOps?: BashOperations;
	/** Extra bash prompt guidelines (main session's mixed-call split rule). */
	bashGuidelines?: string[];
}

export interface ForkedToolSurface {
	template: VfsTemplate;
	mapper: PathMapper;
	mounts: { at: string; root: string }[];
	virtualCwd: string;
	virtualHome: string;
	tools: {
		bash: ToolDefinition<any>;
		read: ToolDefinition<any>;
		write: ToolDefinition<any>;
		edit: ToolDefinition<any>;
		python: ToolDefinition<any>;
	};
}

export function createForkedToolSurface(options: ForkedToolSurfaceOptions): ForkedToolSurface {
	const { cwd, mounts, mapper, virtualCwd, virtualHome } = computeOverlayTopology(
		options.cwd,
		options.home ?? os.homedir(),
	);
	const template = createVfsTemplate({ mounts });
	const forkCtx: ForkBashContext = { template, virtualCwd, virtualHome };
	const resolve = mapper.resolveToolPath;

	const bashOps = createOverlayBashOperations({
		forkBash: () => options.forkBash(forkCtx),
		registerFork: options.registerFork,
		mapCwd: (hostCwd) => mapper.hostToVirtual(hostCwd),
		localOps: options.localOps,
	});
	const bashDef = createBashToolDefinition(cwd, { operations: bashOps });
	const bashTool = {
		...bashDef,
		promptGuidelines: [...(bashDef.promptGuidelines ?? []), ...(options.bashGuidelines ?? [])],
		// The built-in schema says "no default timeout"; the operations layer
		// applies one (see exec.ts), so the schema must not lie.
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: `Timeout in seconds (optional, defaults to ${DEFAULT_TIMEOUT_SECONDS})` }),
			),
		}),
	};

	// read: fresh fork per call (live disk); never registered.
	const readDef = createReadToolDefinition(cwd);
	const readTool = {
		...readDef,
		execute: (
			id: string,
			params: { path: string; offset?: number; limit?: number },
			signal: AbortSignal | undefined,
			onUpdate: undefined,
		) =>
			createReadTool(cwd, { operations: createOverlayReadOps(template.fork(), resolve) }).execute(
				id,
				params,
				signal,
				onUpdate,
			),
	};

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
			options.registerFork(fork);
			return result;
		}) as T["execute"];
		return wrapped;
	};

	const writeDef = createWriteToolDefinition(cwd);
	const writeTool = {
		...writeDef,
		execute: forkedFileToolExecute((fork) => createWriteTool(cwd, { operations: createOverlayWriteOps(fork, resolve) })),
	};

	const editDef = createEditToolDefinition(cwd);
	const editTool = {
		...editDef,
		execute: forkedFileToolExecute((fork) => createEditTool(cwd, { operations: createOverlayEditOps(fork, resolve) })),
	};

	const pythonTool = createPythonToolDefinition({
		forkBash: () => {
			const fork = template.fork();
			return {
				bash: new Bash({ fs: fork, python: true, cwd: virtualCwd, env: { HOME: virtualHome } }),
				fork,
			};
		},
		registerFork: options.registerFork,
		resolveAbsolute: resolve,
		virtualCwd,
	});

	return {
		template,
		mapper,
		mounts,
		virtualCwd,
		virtualHome,
		tools: {
			bash: bashTool as ToolDefinition<any>,
			read: readTool as ToolDefinition<any>,
			write: writeTool as ToolDefinition<any>,
			edit: editTool as ToolDefinition<any>,
			python: pythonTool as ToolDefinition<any>,
		},
	};
}
