/**
 * Read-only tool surface (bash + python) for review/explore child sessions —
 * the ro preset of the shared forked tool surface (src/overlay/tool-surface.ts).
 *
 * Same engine as the main session: one VfsTemplate per child, a fresh
 * copy-on-write fork per call, same mount topology. The ro knobs:
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

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Bash } from "@jerryan/just-bash";
import { createGit, type GitCommandName } from "just-git";
import type { SandboxBash } from "../overlay/exec.js";
import { createForkedToolSurface } from "../overlay/tool-surface.js";

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
export function createReadOnlyTools(options: { cwd: string }): ToolDefinition<any>[] {
	// TODO: mounts are read-write for now — add `readOnly: true` to each
	// mount once the just-bash mount option lands upstream (one-line change,
	// in tool-surface.ts). Until then the no-op registerFork below is the
	// write barrier: staged writes are dropped with each per-call fork.
	const surface = createForkedToolSurface({
		cwd: options.cwd,
		forkBash: ({ template, virtualCwd, virtualHome }) => {
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
		// Read-only children never merge: with read-write mounts this is
		// interim drop-semantics until the readOnly mount option lands.
		registerFork: () => {},
		// No localOps: fail-closed — nothing ever runs natively.
	});

	return [surface.tools.bash, surface.tools.python];
}
