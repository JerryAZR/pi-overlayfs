/**
 * Sandboxed bash execution with native fallback — the analyze -> sandboxed ->
 * native-fallback decision, factored behind injected dependencies so it can be
 * unit-tested against a real sandbox on temp dirs (no pi runtime).
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Which route a command ended up taking (returned for observability/tests). */
export type ExecRoute =
	| "native-unmappable-cwd"
	| "native-unparseable"
	| "native-unresolved-static"
	| "sandboxed"
	| "native-unresolved-runtime";

export interface ExecOutcome {
	exitCode: number | null;
	route: ExecRoute;
}

export interface SandboxRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	unresolvedCommands?: string[];
}

/**
 * Commands whose effects are irreversible deletions/moves. When such a verb
 * is mixed into a command that also needs host-only tooling, the whole call
 * is rejected instead of routed native — the model is asked to split it, so
 * the deletion always goes through the overlay (and the finisher's gate).
 * Benign verbs (mkdir, touch, cp) are deliberately absent: they are
 * ubiquitous in build plumbing and auto-applied inside the project anyway.
 */
const SENSITIVE_COMMANDS = new Set(["rm", "mv", "rmdir"]);

export interface BashExecDeps {
	/** Static pre-flight analysis of the command (Bash.analyzeCommands). */
	analyze(command: string): Promise<{ commands: string[]; unresolved: string[] }>;
	/**
	 * Execute in the overlay sandbox. Must already enforce timeout/abort.
	 * Output is returned buffered — it is NOT streamed, so an aborted run
	 * that falls back to native never double-prints (see H2 in README).
	 */
	execSandboxed(command: string, virtualCwd: string): Promise<SandboxRunResult>;
	/** Execute natively on the host (pi's local shell operations). Streams itself. */
	execNative(command: string, hostCwd: string): Promise<{ exitCode: number | null }>;
}

export interface BashExecRequest {
	command: string;
	/** Host cwd handed to the tool by pi. */
	hostCwd: string;
	/** Virtual cwd mapped from hostCwd, or null when the cwd is under no overlay root. */
	virtualCwd: string | null;
	/** Streamed output sink (pi's BashOperations onData). */
	onData(data: Buffer): void;
}

/**
 * Decision flow:
 *  1. cwd not mappable into the sandbox          -> native passthrough.
 *  2. static analysis finds unresolved commands   -> native passthrough (no asking).
 *  3. sandboxed execution; output emitted only now (buffered until the route
 *     is decided, so fallbacks never duplicate output).
 *  4. runtime unresolved commands (fail-fast abort surfaced in the result)
 *     -> rerun natively. The aborted run's fork is simply never registered
 *     (see createOverlayBashOperations), so its partial writes never reach
 *     the merge — that is the whole H1 discard, by topology.
 */
export async function execBashWithFallback(
	request: BashExecRequest,
	deps: BashExecDeps,
): Promise<ExecOutcome> {
	if (request.virtualCwd === null) {
		const result = await deps.execNative(request.command, request.hostCwd);
		return { exitCode: result.exitCode, route: "native-unmappable-cwd" };
	}

	// If static analysis cannot even parse the command (e.g. Windows
	// cmd-style syntax: %VAR%, backslash quoting, 2>nul), we cannot know what
	// it would do — degrade to native like any other unroutable command
	// rather than failing the tool call with a raw parse error.
	let analysis: { commands: string[]; unresolved: string[] };
	try {
		analysis = await deps.analyze(request.command);
	} catch {
		const result = await deps.execNative(request.command, request.hostCwd);
		return { exitCode: result.exitCode, route: "native-unparseable" };
	}
	if (analysis.unresolved.length > 0) {
		const sensitive = analysis.commands.filter((name) => SENSITIVE_COMMANDS.has(name));
		if (sensitive.length > 0) {
			// Run NOTHING. A native route would let the deletion bypass the
			// overlay (and its outside-project gate); a sandboxed route cannot
			// run the host-only parts. The model must split the call.
			throw new Error(
				`Rejected: this call combines ${sensitive.join(", ")} with host-run commands (${analysis.unresolved.join(", ")}). ` +
					`Rule: rm, mv and rmdir always run in the sandbox, so they cannot share a bash call with commands that run ` +
					`natively on the host. Split the call: ${sensitive.join(", ")} must run on its own, in a separate bash call from the rest.`,
			);
		}
		const result = await deps.execNative(request.command, request.hostCwd);
		return { exitCode: result.exitCode, route: "native-unresolved-static" };
	}

	const sandboxed = await deps.execSandboxed(request.command, request.virtualCwd);
	if (sandboxed.unresolvedCommands && sandboxed.unresolvedCommands.length > 0) {
		const result = await deps.execNative(request.command, request.hostCwd);
		return { exitCode: result.exitCode, route: "native-unresolved-runtime" };
	}

	// Route stays sandboxed: now emit the buffered output (stdout then stderr).
	if (sandboxed.stdout) request.onData(Buffer.from(sandboxed.stdout, "utf8"));
	if (sandboxed.stderr) request.onData(Buffer.from(sandboxed.stderr, "utf8"));
	return { exitCode: sandboxed.exitCode, route: "sandboxed" };
}

/** Options pi's bash tool hands to BashOperations.exec. */
export interface BashExecCallOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

/** Default timeout applied when a tool call omits `timeout` (both bash routes and the python tool). */
export const DEFAULT_TIMEOUT_SECONDS = 300;

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * Timeout validation identical to pi's own resolveTimeoutMs
 * (packages/coding-agent/src/core/tools/bash.ts): same rules, same messages.
 * Returns the timeout in milliseconds, or undefined when no timeout was given.
 */
export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

/** Drop non-string env entries so the result is a plain Record. */
export function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

/** Minimal shape of the sandbox Bash instance used here (structural, test-friendly). */
export interface SandboxBash {
	exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
	): Promise<SandboxRunResult>;
	analyzeCommands(command: string): Promise<{ commands: string[]; unresolved: string[] }>;
}

/**
 * Run a command in the sandbox, enforcing pi's documented bash semantics:
 * timeout throws Error("timeout:<seconds>"), abort throws Error("aborted").
 *
 * Output is returned buffered and NOT emitted on success — the caller emits
 * only once the route is known to stay sandboxed. On timeout/abort the
 * partial output captured so far IS emitted via onData before throwing, so
 * hang diagnostics are not lost (matching native execution, which streams
 * partial output up to the kill).
 */
export async function runSandboxed(
	bash: SandboxBash,
	command: string,
	options: BashExecCallOptions & { virtualCwd: string },
): Promise<SandboxRunResult> {
	const timeoutMs = resolveTimeoutMs(options.timeout);
	if (options.signal?.aborted) throw new Error("aborted");

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	let timedOut = false;
	const timer =
		timeoutMs !== undefined
			? setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, timeoutMs)
			: undefined;

	const emitPartial = (result: SandboxRunResult) => {
		if (result.stdout) options.onData(Buffer.from(result.stdout, "utf8"));
		if (result.stderr) options.onData(Buffer.from(result.stderr, "utf8"));
	};

	try {
		const result = await bash.exec(command, {
			cwd: options.virtualCwd,
			env: sanitizeEnv(options.env),
			signal: controller.signal,
		});
		if (options.signal?.aborted) {
			emitPartial(result);
			throw new Error("aborted");
		}
		if (timedOut) {
			emitPartial(result);
			throw new Error(`timeout:${options.timeout}`);
		}
		return result;
	} catch (error) {
		if (options.signal?.aborted && !(error instanceof Error && error.message === "aborted")) {
			throw new Error("aborted");
		}
		if (timedOut && !(error instanceof Error && error.message.startsWith("timeout:"))) {
			throw new Error(`timeout:${options.timeout}`);
		}
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Build BashOperations that route through per-call COW forks with native
 * fallback. Each call with a mappable cwd gets a fresh fork + Bash
 * (`forkBash`); when the route stays sandboxed the fork is handed to
 * `registerFork` for the turn_end merge. Native routes and aborted/failed
 * runs never register — their fork (and its partial writes) is discarded,
 * which is what makes concurrent execution safe without any locking.
 * `localOps` is pi's createLocalBashOperations() result.
 */
export function createOverlayBashOperations<F>(options: {
	/** Fresh Bash over a fresh template fork, plus the fork to register on success. */
	forkBash(): { bash: SandboxBash; fork: F };
	/** Register a sandboxed run's fork for the turn_end merge. */
	registerFork(fork: F): void;
	mapCwd: (hostCwd: string) => string | null;
	localOps: BashOperations;
	/**
	 * Timeout (seconds) applied when the model omits `timeout` — covers BOTH
	 * the sandboxed and native routes. Defaults to DEFAULT_TIMEOUT_SECONDS;
	 * pass a tiny value in tests to exercise the timeout path quickly.
	 */
	defaultTimeoutSeconds?: number;
}): BashOperations {
	return {
		exec: async (command, hostCwd, callOptions) => {
			const effectiveCallOptions =
				callOptions.timeout === undefined
					? { ...callOptions, timeout: options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS }
					: callOptions;
			const virtualCwd = options.mapCwd(hostCwd);
			if (virtualCwd === null) {
				const result = await options.localOps.exec(command, hostCwd, effectiveCallOptions);
				return { exitCode: result.exitCode };
			}
			const { bash, fork } = options.forkBash();
			const outcome = await execBashWithFallback(
				{ command, hostCwd, virtualCwd, onData: effectiveCallOptions.onData },
				{
					analyze: (cmd) => bash.analyzeCommands(cmd),
					execSandboxed: (cmd, cwd) => runSandboxed(bash, cmd, { ...effectiveCallOptions, virtualCwd: cwd }),
					execNative: (cmd, cwd) => options.localOps.exec(cmd, cwd, effectiveCallOptions),
				},
			);
			if (outcome.route === "sandboxed") options.registerFork(fork);
			return { exitCode: outcome.exitCode };
		},
	};
}
