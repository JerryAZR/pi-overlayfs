/**
 * Sandboxed read-only bash + python tools for review/explore child sessions.
 *
 * Read-only children run on the SAME execution model as the main session
 * (see src/overlay/index.ts): one VfsTemplate per child, a fresh copy-on-write
 * fork per call, and the same mount topology (canonicalized home at its
 * real-layout mount point, plus the project at its own when the child cwd
 * is outside home). The differences from the main session:
 *
 *   - Fail-closed: no localOps. Unresolved commands (npm, node, ...) 127
 *     bash-style in-band inside the sandbox — nothing ever runs natively.
 *   - No merge: registerFork is a no-op, so writes evaporate with the
 *     per-call fork (interim drop-semantics; see the readOnly TODO below).
 *   - just-git provides git inside the sandbox (no network; pure-mutator
 *     verbs disabled for clean UX errors).
 *
 * The `disabled` git list below is UX only (clean "not available" errors
 * for pure mutators); enforcement is the drop-semantics fork layer.
 * Dual-purpose verbs (branch, tag, stash, config, remote, worktree) stay
 * enabled so their read modes work; their write modes' changes are dropped
 * with the fork.
 */

import os from "node:os";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Bash, createVfsTemplate } from "@jerryan/just-bash";
import { createGit, type GitCommandName } from "just-git";
import { Type } from "typebox";
import { createOverlayBashOperations, DEFAULT_TIMEOUT_SECONDS, type SandboxBash } from "../overlay/exec.js";
import { computeOverlayTopology } from "../overlay/paths.js";
import { createPythonToolDefinition } from "../overlay/tools/python.js";

/** Pure-mutator git verbs, disabled for clean UX errors. Fork drop-semantics enforce the rest. */
const DISABLED_GIT: GitCommandName[] = [
	"init",
	"add",
	"commit",
	"checkout",
	"switch",
	"restore",
	"reset",
	"merge",
	"cherry-pick",
	"revert",
	"rebase",
	"mv",
	"rm",
	"clean",
	"bisect",
	"gc",
	"repack",
];

/**
 * Filesystem-style error codes the sandbox can raise. just-bash reports
 * command-level failures (touch, rm) as exit codes, but interpreter-level
 * failures — output redirections write through the interpreter's own FS
 * path — REJECT the exec promise with these. Both shapes mean the same
 * thing to the caller: the command failed. When the upstream readOnly mount
 * option lands, its EROFS rejections surface through exactly this path.
 * Anything outside this taxonomy is a genuine interpreter bug and is
 * rethrown, loudly.
 */
const FS_ERROR_PATTERN =
	/^(EROFS|EACCES|EPERM|ENOENT|EFBIG|ENOSPC|EISDIR|ENOTDIR|ELOOP|ENOTEMPTY|EEXIST|EINVAL|EBUSY|EXDEV|EIO)\b/;

/**
 * Build the read-only child tool surface: a sandboxed bash (shadowing the
 * built-in of the same name — fail-closed) plus the sandboxed python tool.
 * One template per factory call (i.e. per child session); per-call forks
 * share its /tmp scratch base, so temp scripts written via bash are visible
 * to later python calls.
 */
export function createReadOnlySandboxTools(options: { cwd: string }): ToolDefinition<any>[] {
	// Same mount topology as the main session's session_start (the helper is
	// shared with src/overlay/index.ts).
	//
	// TODO: mounts are read-write for now — add `readOnly: true` to each
	// mount once the just-bash mount option lands upstream (one-line change
	// here). Until then the no-op registerFork below is the write barrier:
	// staged writes are dropped with each per-call fork.
	const { cwd, mounts, mapper, virtualCwd, virtualHome } = computeOverlayTopology(options.cwd, os.homedir());
	const template = createVfsTemplate({ mounts });

	// Read-only children never merge: with read-write mounts this is interim
	// drop-semantics until the readOnly mount option lands (TODO above).
	const registerFork = () => {};

	const bashOps = createOverlayBashOperations({
		forkBash: () => {
			const fork = template.fork();
			const raw = new Bash({
				fs: fork,
				cwd: virtualCwd,
				env: { HOME: virtualHome },
				// abortOnUnresolvedCommands stays off (default): unresolved
				// commands 127 bash-style in-band — the fail-closed behavior.
				customCommands: [createGit({ network: false, disabled: DISABLED_GIT })],
			});
			// Defensive conversion of interpreter-level fs failures (see
			// FS_ERROR_PATTERN): same meaning as a command-level failure, so
			// emit the message and report exit 1 instead of rejecting.
			const bash: SandboxBash = {
				exec: async (command, execOptions) => {
					try {
						return await raw.exec(command, execOptions);
					} catch (err: any) {
						if (FS_ERROR_PATTERN.test(err?.message ?? "")) {
							return { stdout: "", stderr: err.message, exitCode: 1 };
						}
						throw err;
					}
				},
				analyzeCommands: (command) => raw.analyzeCommands(command),
			};
			return { bash, fork };
		},
		registerFork,
		mapCwd: (hostCwd) => mapper.hostToVirtual(hostCwd),
		// No localOps: fail-closed — nothing ever runs natively.
	});

	// Built exactly like the main session's bash: the built-in definition
	// (prompt, renderers, truncation) carries the fork routing via operations.
	const bashDef = createBashToolDefinition(cwd, { operations: bashOps });
	const bashTool = {
		...bashDef,
		// The built-in schema says "no default timeout"; the operations layer
		// applies one (see exec.ts), so the schema must not lie.
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: `Timeout in seconds (optional, defaults to ${DEFAULT_TIMEOUT_SECONDS})` }),
			),
		}),
	};

	const pythonTool = createPythonToolDefinition({
		forkBash: () => {
			const fork = template.fork();
			return {
				bash: new Bash({ fs: fork, python: true, cwd: virtualCwd, env: { HOME: virtualHome } }),
				fork,
			};
		},
		registerFork,
		resolveAbsolute: mapper.resolveToolPath,
		virtualCwd,
	});

	return [bashTool, pythonTool] as unknown as ToolDefinition<any>[];
}
