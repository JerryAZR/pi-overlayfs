/**
 * Custom "python" tool: run sandboxed CPython (just-bash python option) in a
 * fresh COW fork per call. Inline code is staged to a fresh
 * /tmp/.pi-py-<n>.py script (shared scratch, visible to all forks); script
 * paths accept host or virtual POSIX forms.
 */
import path from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { BashExecResult } from "@jerryan/just-bash";
import { Type } from "typebox";
import { DEFAULT_TIMEOUT_SECONDS, resolveTimeoutMs } from "../exec.js";
import type { OverlayVfs, ToolPathResolver } from "./file-ops.js";

export interface PythonBash {
	exec(command: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<BashExecResult>;
}

export interface PythonToolDeps<F extends OverlayVfs> {
	/** Fresh python-enabled Bash over a fresh template fork, per call. */
	forkBash(): { bash: PythonBash; fork: F };
	/** Register a successful call's fork for the turn_end merge. */
	registerFork(fork: F): void;
	/** paths.ts resolveToolPath for absolute inputs. */
	resolveAbsolute: ToolPathResolver;
	/** Virtual cwd of the project inside the sandbox. */
	virtualCwd: string;
	/** Timeout (seconds) when the model omits `timeout`. Defaults to DEFAULT_TIMEOUT_SECONDS. */
	defaultTimeoutSeconds?: number;
}

const parameters = Type.Object({
	code: Type.Optional(Type.String({ description: "Inline Python 3 source to execute" })),
	path: Type.Optional(
		Type.String({ description: "Path to a Python script (host path or virtual POSIX path, e.g. /tmp/x.py)" }),
	),
	args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the script" })),
	cwd: Type.Optional(
		Type.String({ description: "Working directory (host path or virtual POSIX path). Defaults to the project." }),
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, defaults to 300)" })),
});

type PythonParams = {
	code?: string;
	path?: string;
	args?: string[];
	cwd?: string;
	timeout?: number;
};

/** Single-quote escape for embedding an argument in a shell command line. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toVirtual(input: string, virtualCwd: string, resolveAbsolute: ToolPathResolver): string {
	const trimmed = input.trim();
	if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
		return resolveAbsolute(trimmed);
	}
	return path.posix.normalize(path.posix.join(virtualCwd, trimmed));
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

export function createPythonToolDefinition<F extends OverlayVfs>(deps: PythonToolDeps<F>) {
	let scriptCounter = 0;

	return {
		name: "python",
		label: "python",
		description:
			"Run Python 3 (standard library only) for scripting, file operations, and data processing. " +
			"Provide exactly one of code (inline source) or path (a script, POSIX path like /tmp/x.py or a project path). " +
			"For the project's own Python environment or third-party packages, run python via the bash tool instead.",
		promptSnippet: "Run Python 3 scripts (standard library only)",
		promptGuidelines: [
			"Use the python tool for dependency-free Python 3 scripting; when you need the project's Python environment or installed packages, run python through the bash tool instead.",
		],
		parameters,
		async execute(
			_toolCallId: string,
			params: PythonParams,
			signal?: AbortSignal,
			_onUpdate?: unknown,
		) {
			const hasCode = typeof params.code === "string" && params.code.length > 0;
			const hasPath = typeof params.path === "string" && params.path.trim().length > 0;
			if (hasCode === hasPath) {
				throw new Error("python: exactly one of 'code' or 'path' is required");
			}
			// Same validation/messages as pi's bash tool (throws on invalid input).
			const timeoutSeconds = params.timeout ?? deps.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
			const timeoutMs = resolveTimeoutMs(timeoutSeconds);

			if (signal?.aborted) throw new Error("aborted");

			const { bash, fork } = deps.forkBash();
			const virtualCwd = params.cwd
				? toVirtual(params.cwd, deps.virtualCwd, deps.resolveAbsolute)
				: deps.virtualCwd;

			// The CPython worker expects /tmp to exist in the vfs (shared
			// scratch — immediately visible to every fork).
			await fork.mkdir("/tmp", { recursive: true });

			let scriptPath: string;
			if (hasCode) {
				scriptPath = `/tmp/.pi-py-${scriptCounter++}.py`;
				await fork.mkdir(path.posix.dirname(scriptPath), { recursive: true });
				await fork.writeFile(scriptPath, params.code as string, { encoding: "utf8" });
			} else {
				scriptPath = toVirtual(params.path as string, virtualCwd, deps.resolveAbsolute);
				if (!(await fork.exists(scriptPath))) {
					throw new Error(`python: script not found: ${params.path}`);
				}
			}

			const args = (params.args ?? []).map(shellQuote);
			const command = [`python3 ${shellQuote(scriptPath)}`, ...args].join(" ");

			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			let timedOut = false;
			const timer =
				timeoutMs !== undefined
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeoutMs)
					: undefined;

			let result: BashExecResult;
			try {
				result = await bash.exec(command, { cwd: virtualCwd, signal: controller.signal });
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeoutSeconds}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
			if (signal?.aborted) throw new Error("aborted");
			if (timedOut) {
				// Preserve hang diagnostics: partial output rides along with the
				// timeout error message.
				let detail = "";
				if (result.stdout) detail += `\n${result.stdout}`;
				if (result.stderr) detail += `\n--- stderr ---\n${result.stderr}`;
				throw new Error(`timeout:${timeoutSeconds}${detail}`);
			}

			// The call succeeded: its project writes land in the merge.
			deps.registerFork(fork);

			let text = result.stdout;
			if (result.stderr) text += `\n--- stderr ---\n${result.stderr}`;
			const truncation = truncateHead(text);
			if (truncation.truncated) {
				text = `${truncation.content}\n\n[Output truncated: ${truncation.totalLines} lines total, showing first ${truncation.outputLines}]`;
			}
			text += `\n(exit ${result.exitCode})`;
			return textResult(text);
		},
	};
}
