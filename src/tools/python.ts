/**
 * Custom "python" tool: run sandboxed CPython (just-bash python option) over
 * the same overlay filesystem as bash. Inline code is staged to a fresh
 * /tmp/.pi-py-<n>.py script; script paths accept host or virtual POSIX forms.
 */
import path from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Bash, type BashExecResult, type IFileSystem } from "@jerryan/just-bash";
import { Type } from "typebox";
import { normalizeDirectoryModes } from "../dir-modes.js";
import { DEFAULT_TIMEOUT_SECONDS, resolveTimeoutMs } from "../exec.js";
import type { OverlayVfs, ToolPathResolver } from "./file-ops.js";

export interface PythonBash {
	exec(command: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<BashExecResult>;
}

/**
 * Build the Bash instance backing the python tool: python enabled, directory
 * modes normalized for the Windows CPython worker (see dir-modes.ts), and
 * HOME=/home/user matching what createAgentSandbox sets for the main bash.
 */
export function createPythonBash(fs: IFileSystem, virtualCwd: string): Bash {
	return new Bash({
		fs: normalizeDirectoryModes(fs),
		python: true,
		cwd: virtualCwd,
		env: { HOME: "/home/user" },
	});
}

export interface PythonToolDeps {
	vfs: OverlayVfs;
	pythonBash: PythonBash;
	/** paths.ts resolveToolPath for absolute inputs. */
	resolveAbsolute: ToolPathResolver;
	/** Virtual cwd of the project inside the sandbox. */
	virtualCwd: string;
	/** Serialize with other mutating tools and the finisher. */
	runExclusive<T>(fn: () => Promise<T>): Promise<T>;
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

export function createPythonToolDefinition(deps: PythonToolDeps) {
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

			return deps.runExclusive(async () => {
				if (signal?.aborted) throw new Error("aborted");

				const virtualCwd = params.cwd
					? toVirtual(params.cwd, deps.virtualCwd, deps.resolveAbsolute)
					: deps.virtualCwd;

				// The CPython worker expects /tmp to exist in the vfs.
				await deps.vfs.mkdir("/tmp", { recursive: true });

				let scriptPath: string;
				if (hasCode) {
					scriptPath = `/tmp/.pi-py-${scriptCounter++}.py`;
					await deps.vfs.mkdir(path.posix.dirname(scriptPath), { recursive: true });
					await deps.vfs.writeFile(scriptPath, params.code as string, { encoding: "utf8" });
				} else {
					scriptPath = toVirtual(params.path as string, virtualCwd, deps.resolveAbsolute);
					if (!(await deps.vfs.exists(scriptPath))) {
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
					result = await deps.pythonBash.exec(command, { cwd: virtualCwd, signal: controller.signal });
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

				let text = result.stdout;
				if (result.stderr) text += `\n--- stderr ---\n${result.stderr}`;
				const truncation = truncateHead(text);
				if (truncation.truncated) {
					text = `${truncation.content}\n\n[Output truncated: ${truncation.totalLines} lines total, showing first ${truncation.outputLines}]`;
				}
				text += `\n(exit ${result.exitCode})`;
				return textResult(text);
			});
		},
	};
}
