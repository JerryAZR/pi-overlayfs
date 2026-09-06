import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type AgentSandbox, createAgentSandbox } from "@jerryan/just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createOverlayBashOperations,
	DEFAULT_TIMEOUT_SECONDS,
	execBashWithFallback,
	resolveTimeoutMs,
	runSandboxed,
	sanitizeEnv,
	type BashExecDeps,
	type SandboxBash,
} from "./exec.js";
import { dropStagedPaths, runFinisher } from "./finisher.js";
import { AsyncMutex } from "./mutex.js";
import { createPathMapper, type PathMapper } from "./paths.js";

let tmpRoot: string;
let home: string;
let project: string;
let sandbox: AgentSandbox;
let mapper: PathMapper;

beforeEach(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlayfs-exec-"));
	home = path.join(tmpRoot, "home");
	project = path.join(home, "project");
	await mkdir(project, { recursive: true });
	sandbox = createAgentSandbox({ home, project, abortOnUnresolvedCommands: true });
	mapper = createPathMapper({
		overlays: [...sandbox.overlays.entries()].map(([mountPoint, { root }]) => ({ mountPoint, root })),
		projectRoot: project,
	});
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

function realDeps(sandboxBash: SandboxBash, nativeCalls: string[]): BashExecDeps {
	return {
		analyze: (cmd) => sandboxBash.analyzeCommands(cmd),
		execSandboxed: (cmd, cwd) => runSandboxed(sandboxBash, cmd, { virtualCwd: cwd, onData: () => {} }),
		execNative: async (cmd) => {
			nativeCalls.push(cmd);
			return { exitCode: 0 };
		},
	};
}

const noOp = () => {};

describe("execBashWithFallback (real sandbox on temp dirs)", () => {
	it("runs resolvable commands in the sandbox; writes stay staged in memory", async () => {
		const nativeCalls: string[] = [];
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;

		const outcome = await execBashWithFallback(
			{ command: "echo hello > out.txt", hostCwd: project, virtualCwd, onData: noOp },
			realDeps(sandbox.bash, nativeCalls),
		);

		expect(outcome.route).toBe("sandboxed");
		expect(outcome.exitCode).toBe(0);
		expect(nativeCalls).toEqual([]);
		// Staged in the overlay, not on disk:
		expect(sandbox.diff().writes.map((w) => path.basename(w.path))).toContain("out.txt");
		expect(existsSync(path.join(project, "out.txt"))).toBe(false);
	});

	it("emits buffered stdout then stderr exactly once on the sandboxed route", async () => {
		const chunks: Buffer[] = [];
		const outcome = await execBashWithFallback(
			{ command: "echo out; echo err 1>&2", hostCwd: project, virtualCwd: "/home/user/project", onData: (d) => chunks.push(d) },
			realDeps(sandbox.bash, []),
		);
		expect(outcome.route).toBe("sandboxed");
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toBeInstanceOf(Buffer);
		expect(chunks[0]!.toString()).toBe("out\n");
		expect(chunks[1]!.toString()).toBe("err\n");
	});

	it("falls back to native when static analysis finds unresolved commands", async () => {
		const nativeCalls: string[] = [];
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;

		const outcome = await execBashWithFallback(
			{ command: "definitely-not-a-real-command-xyz --flag", hostCwd: project, virtualCwd, onData: noOp },
			realDeps(sandbox.bash, nativeCalls),
		);

		expect(outcome.route).toBe("native-unresolved-static");
		expect(nativeCalls).toEqual(["definitely-not-a-real-command-xyz --flag"]);
	});

	it("falls back to native when static analysis cannot parse the command (cmd-style syntax)", async () => {
		const nativeCalls: string[] = [];
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;
		// Windows cmd-style: %VAR% and backslash quoting make just-bash's parser throw.
		const command = 'ls -la "%USERPROFILE%\\.pi\\agent\\" 2>nul || echo missing';

		const outcome = await execBashWithFallback(
			{ command, hostCwd: project, virtualCwd, onData: noOp },
			realDeps(sandbox.bash, nativeCalls),
		);

		expect(outcome.route).toBe("native-unparseable");
		expect(nativeCalls).toEqual([command]);
	});

	it("rejects a command mixing rm with host-only commands — nothing runs", async () => {
		const nativeCalls: string[] = [];
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;
		await writeFile(path.join(project, "scratch.txt"), "x");

		const error = await execBashWithFallback(
			{ command: "rm scratch.txt && cargo build", hostCwd: project, virtualCwd, onData: noOp },
			realDeps(sandbox.bash, nativeCalls),
		).then(
			() => {
				throw new Error("expected rejection");
			},
			(e: Error) => e,
		);
		// The message must name the sensitive verb, the host-only blocker, and
		// instruct a split into separate calls (wording pinned loosely — the
		// exact text is user-facing and may be refined).
		expect(error.message).toContain("rm");
		expect(error.message).toContain("cargo");
		expect(error.message).toMatch(/separate/i);

		// Nothing ran: no native call, no staged deletion, file intact on disk.
		expect(nativeCalls).toEqual([]);
		expect(sandbox.diff().deletions).toEqual([]);
		expect(existsSync(path.join(project, "scratch.txt"))).toBe(true);
	});

	it.each([
		["mv a.txt b.txt && npm install", "mv", "npm"],
		["rmdir old-dir && cargo build", "rmdir", "cargo"],
	])("rejects mixed sensitive+native: %s", async (command, verb, blocker) => {
		const nativeCalls: string[] = [];
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;

		await expect(
			execBashWithFallback(
				{ command, hostCwd: project, virtualCwd, onData: noOp },
				realDeps(sandbox.bash, nativeCalls),
			),
		).rejects.toThrow(new RegExp(`${verb}[^]*${blocker}|${blocker}[^]*${verb}`));
		expect(nativeCalls).toEqual([]);
	});

	it("does not reject rm as a non-command token (git rm, echo rm)", async () => {
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;
		for (const command of ["git rm --cached scratch.txt", "echo rm -rf / \u0026\u0026 cargo build"]) {
			const nativeCalls: string[] = [];
			const outcome = await execBashWithFallback(
				{ command, hostCwd: project, virtualCwd, onData: noOp },
				realDeps(sandbox.bash, nativeCalls),
			);
			expect(outcome.route).toBe("native-unresolved-static");
			expect(nativeCalls).toEqual([command]);
		}
	});

	it("does not reject benign verbs (mkdir, touch) mixed with host-only commands", async () => {
		const nativeCalls: string[] = [];
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;
		const command = "mkdir -p build \u0026\u0026 touch build/.keep \u0026\u0026 cargo build";

		const outcome = await execBashWithFallback(
			{ command, hostCwd: project, virtualCwd, onData: noOp },
			realDeps(sandbox.bash, nativeCalls),
		);
		expect(outcome.route).toBe("native-unresolved-static");
		expect(nativeCalls).toEqual([command]);
	});

	it("rm alone still runs sandboxed: deletion staged, disk untouched", async () => {
		const nativeCalls: string[] = [];
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;
		await writeFile(path.join(project, "doomed.txt"), "x");

		const outcome = await execBashWithFallback(
			{ command: "rm doomed.txt", hostCwd: project, virtualCwd, onData: noOp },
			realDeps(sandbox.bash, nativeCalls),
		);
		expect(outcome.route).toBe("sandboxed");
		expect(nativeCalls).toEqual([]);
		expect(existsSync(path.join(project, "doomed.txt"))).toBe(true);
		expect(sandbox.diff().deletions).toHaveLength(1);
	});

	it("falls back to native when the cwd maps to no overlay", async () => {
		const nativeCalls: string[] = [];

		const outcome = await execBashWithFallback(
			{ command: "echo hi", hostCwd: tmpRoot, virtualCwd: null, onData: noOp },
			realDeps(sandbox.bash, nativeCalls),
		);

		expect(outcome.route).toBe("native-unmappable-cwd");
		expect(nativeCalls).toEqual(["echo hi"]);
	});

	it("reruns natively when the sandboxed run reports runtime unresolved commands", async () => {
		const nativeCalls: string[] = [];
		const outcome = await execBashWithFallback(
			{ command: "whatever", hostCwd: project, virtualCwd: "/project", onData: noOp },
			{
				analyze: async () => ({ commands: ["whatever"], unresolved: [] }),
				execSandboxed: async () => ({
					exitCode: 127,
					stdout: "",
					stderr: "nope: command not found",
					unresolvedCommands: ["nope"],
				}),
				execNative: async (cmd) => {
					nativeCalls.push(cmd);
					return { exitCode: 3 };
				},
			},
		);

		expect(outcome.route).toBe("native-unresolved-runtime");
		expect(outcome.exitCode).toBe(3);
		expect(nativeCalls).toEqual(["whatever"]);
	});
});

/**
 * H1/H2 regression: a command whose prefix stages writes before hitting an
 * unresolved command at runtime (fail-fast abort). The fallback must discard
 * the aborted run's staged state BEFORE the native rerun (no stale
 * double-apply by the finisher) and must not emit the aborted run's output.
 */
describe("runtime fallback safety (real sandbox)", () => {
	// Passes static analysis (the unresolved name is produced by a command
	// substitution), stages ts.txt, then aborts on the unresolved command.
	const TRICKY = "echo prefixout; echo staged > ts.txt && $(echo someunknowncmd)";

	function makeOps(nativeCalls: string[], nativeWrites: (() => Promise<void>) | undefined, chunks: Buffer[]) {
		const localOps: BashOperations = {
			exec: async (cmd, _cwd, { onData }) => {
				nativeCalls.push(cmd);
				onData(Buffer.from("prefixout\nnative\n"));
				await nativeWrites?.();
				return { exitCode: 0 };
			},
		};
		return createOverlayBashOperations({
			bash: sandbox.bash,
			mapCwd: (hostCwd) => mapper.hostToVirtual(hostCwd)?.virtualPath ?? null,
			localOps,
			getStagedPaths: () => [...sandbox.diff().deletions, ...sandbox.diff().writes.map((w) => w.path)],
			dropStagedPathsExcept: (keepPaths) => {
				const keep = new Set(keepPaths);
				const pending = sandbox.diff();
				const stale = [
					...pending.deletions.filter((p) => !keep.has(p)),
					...pending.writes.map((w) => w.path).filter((p) => !keep.has(p)),
				];
				dropStagedPaths(sandbox, mapper, stale);
			},
		});
	}

	it("H1: the aborted run's staged writes are discarded before the native rerun — finisher finds nothing stale", async () => {
		const nativeCalls: string[] = [];
		const tsPath = path.join(project, "ts.txt");
		const ops = makeOps(
			nativeCalls,
			async () => {
				// Native run produces its own (newer) version of the file.
				await import("node:fs/promises").then((fs) => fs.writeFile(tsPath, "native\n"));
			},
			[],
		);

		const result = await ops.exec(TRICKY, project, { onData: noOp });
		expect(result.exitCode).toBe(0);
		expect(nativeCalls).toEqual([TRICKY]);

		// The finisher must find nothing left over from the aborted sandboxed
		// run — otherwise it would apply STALE staged content over the native
		// run's newer file.
		expect(sandbox.diff().writes).toHaveLength(0);
		expect(sandbox.diff().deletions).toHaveLength(0);
		const report = await runFinisher({
			diff: () => sandbox.diff(),
			applyChanges: (subset) => sandbox.applyChanges(subset),
			drop: () => {},
			isUnderProject: (p) => mapper.isUnderProject(p),
			isExistingDirectory: () => true,
			outsidePolicy: () => "approve",
		});
		expect(report).toEqual({ applied: 0, denied: [], failed: null });
		expect(await import("node:fs/promises").then((fs) => fs.readFile(tsPath, "utf8"))).toBe("native\n");
	});

	it("H2: the aborted run's output is not emitted — no duplication with the native rerun", async () => {
		const chunks: Buffer[] = [];
		const ops = makeOps([], undefined, chunks);

		await ops.exec(TRICKY, project, { onData: (d) => chunks.push(d) });

		const emitted = Buffer.concat(chunks).toString();
		// Exactly the native run's output, once. The sandboxed prefix output
		// ("prefixout" from the aborted attempt) must not appear.
		expect(emitted).toBe("prefixout\nnative\n");
	});

	it("pre-existing staged state (defense-in-depth keep-set) survives the fallback discard", async () => {
		// Stage something BEFORE the bash run, simulating a prior failed apply.
		const prior = await sandbox.exec("echo prior > prior.txt");
		expect(prior.exitCode).toBe(0);
		const priorPaths = [...sandbox.diff().deletions, ...sandbox.diff().writes.map((w) => w.path)];
		expect(priorPaths.length).toBeGreaterThan(0);

		const ops = makeOps([], undefined, []);
		await ops.exec(TRICKY, project, { onData: noOp });

		// The aborted run's ts.txt is gone, but the pre-existing staged entries remain.
		const after = [...sandbox.diff().deletions, ...sandbox.diff().writes.map((w) => w.path)];
		expect(after).toEqual(priorPaths);
		expect(after.some((p) => p.endsWith("ts.txt"))).toBe(false);
	});

	it("RACE: discard runs inside the mutex — a concurrent tool stages strictly before or after it", async () => {
		const mutex = new AsyncMutex();
		const virtualCwd = mapper.hostToVirtual(project)!.virtualPath;
		const stagedPaths = () => [...sandbox.diff().deletions, ...sandbox.diff().writes.map((w) => w.path)];

		// Structural probe: record whether the discard executes while the lock
		// is held. Deterministic — no timing involved.
		let lockHolds = 0;
		let holdsDuringDiscard: number | undefined;

		// Signal when the sandboxed run inside the fallback attempt resolves —
		// the discard happens next; whether it is still under the lock is the
		// invariant under test.
		let markSandboxedResolved!: () => void;
		const sandboxedResolved = new Promise<void>((resolve) => {
			markSandboxedResolved = resolve;
		});
		const gatedBash: SandboxBash = {
			exec: async (command, execOptions) => {
				const result = await sandbox.bash.exec(command, execOptions);
				markSandboxedResolved();
				return result;
			},
			analyzeCommands: (cmd) => sandbox.bash.analyzeCommands(cmd),
		};

		const ops = createOverlayBashOperations({
			bash: gatedBash,
			mapCwd: (hostCwd) => mapper.hostToVirtual(hostCwd)?.virtualPath ?? null,
			localOps: { exec: async () => ({ exitCode: 0 }) },
			runExclusive: (fn) =>
				mutex.run(async () => {
					lockHolds++;
					try {
						return await fn();
					} finally {
						lockHolds--;
					}
				}),
			getStagedPaths: stagedPaths,
			dropStagedPathsExcept: (keepPaths) => {
				holdsDuringDiscard = lockHolds;
				const keep = new Set(keepPaths);
				const stale = stagedPaths().filter((p) => !keep.has(p));
				dropStagedPaths(sandbox, mapper, stale);
			},
		});

		const fallbackExec = ops.exec(TRICKY, project, { onData: noOp });
		await sandboxedResolved;

		// A concurrent mutating tool queues on the same mutex the instant the
		// sandboxed run resolves. Its FIRST action is a synchronous observation
		// of the pending set at entry — deterministic: if the discard ran
		// outside the lock, this tool enters first and still sees the aborted
		// run's ts.txt; if the discard ran inside, ts.txt is already gone.
		let tsTxtPendingAtEntry: boolean | undefined;
		const concurrentTool = mutex.run(async () => {
			tsTxtPendingAtEntry = stagedPaths().some((p) => p.endsWith("ts.txt"));
			const r = await sandbox.bash.exec("echo other > other.txt", { cwd: virtualCwd });
			expect(r.exitCode).toBe(0);
		});
		await Promise.all([fallbackExec, concurrentTool]);

		// Structural invariant: the discard itself executed under the lock.
		expect(holdsDuringDiscard).toBe(1);
		// Behavioral invariant: the concurrent tool observed a post-discard
		// world (its writes can never be caught by the discard)...
		expect(tsTxtPendingAtEntry).toBe(false);
		// ...its staged write survived, while the aborted run's was discarded.
		const pending = stagedPaths();
		expect(pending.some((p) => p.endsWith("other.txt"))).toBe(true);
		expect(pending.some((p) => p.endsWith("ts.txt"))).toBe(false);
	});
});

describe("runSandboxed semantics (real sandbox)", () => {
	it("returns buffered output without emitting on success", async () => {
		const chunks: Buffer[] = [];
		const result = await runSandboxed(sandbox.bash, "echo out; echo err 1>&2", {
			virtualCwd: "/home/user",
			onData: (d) => chunks.push(d),
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("out\n");
		expect(result.stderr).toBe("err\n");
		expect(chunks).toHaveLength(0);
	});

	it("throws Error('timeout:<seconds>') when the timeout fires, emitting output captured so far first (M2)", async () => {
		// just-bash discards accumulated stdout on signal abort (verified in
		// the fork: builtin-dispatch throws with empty stdout) but preserves
		// the abort diagnostic — whatever the sandbox captured must reach
		// onData BEFORE the throw, never silently vanish.
		const chunks: Buffer[] = [];
		await expect(
			runSandboxed(sandbox.bash, "echo before-hang; sleep 30", {
				virtualCwd: "/home/user",
				onData: (d) => chunks.push(d),
				timeout: 1,
			}),
		).rejects.toThrow("timeout:1");
		expect(Buffer.concat(chunks).toString()).toContain("bash: execution aborted");
	});

	it("emits preserved partial stdout before throwing on abort (M2 invariant, injected bash)", async () => {
		const controller = new AbortController();
		const fakeBash: SandboxBash = {
			exec: async () => {
				controller.abort();
				return { exitCode: 124, stdout: "before-hang\n", stderr: "" };
			},
			analyzeCommands: async () => ({ commands: [], unresolved: [] }),
		};
		const chunks: Buffer[] = [];
		await expect(
			runSandboxed(fakeBash, "whatever", {
				virtualCwd: "/home/user",
				onData: (d) => chunks.push(d),
				signal: controller.signal,
			}),
		).rejects.toThrow("aborted");
		expect(Buffer.concat(chunks).toString()).toContain("before-hang");
	});

	it("emits preserved partial stdout before throwing on timeout (M2 invariant, injected bash)", async () => {
		const fakeBash: SandboxBash = {
			exec: async () => {
				// Resolve only after the 1s timeout has fired.
				await new Promise((resolve) => setTimeout(resolve, 1200));
				return { exitCode: 124, stdout: "partial\n", stderr: "" };
			},
			analyzeCommands: async () => ({ commands: [], unresolved: [] }),
		};
		const chunks: Buffer[] = [];
		await expect(
			runSandboxed(fakeBash, "whatever", {
				virtualCwd: "/home/user",
				onData: (d) => chunks.push(d),
				timeout: 1,
			}),
		).rejects.toThrow("timeout:1");
		expect(Buffer.concat(chunks).toString()).toContain("partial");
	});

	it("throws Error('aborted') when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runSandboxed(sandbox.bash, "echo hi", {
				virtualCwd: "/home/user",
				onData: noOp,
				signal: controller.signal,
			}),
		).rejects.toThrow("aborted");
	});
});

describe("default timeout (createOverlayBashOperations)", () => {
	function spyLocalOps(calls: { timeout?: number }[]): BashOperations {
		return {
			exec: async (_cmd, _cwd, opts) => {
				calls.push({ timeout: opts.timeout });
				return { exitCode: 0 };
			},
		};
	}

	/** A sandbox bash that never finishes on its own; resolves only on abort. */
	const hangingBash: SandboxBash = {
		analyzeCommands: async () => ({ commands: [], unresolved: [] }),
		exec: (_cmd, opts) =>
			new Promise((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "" }));
			}),
	};

	it("applies the default to the native route when timeout is omitted", async () => {
		const calls: { timeout?: number }[] = [];
		const ops = createOverlayBashOperations({
			bash: hangingBash,
			mapCwd: () => null, // forces the native route
			localOps: spyLocalOps(calls),
		});
		await ops.exec("anything", project, { onData: noOp });
		expect(calls).toEqual([{ timeout: DEFAULT_TIMEOUT_SECONDS }]);
	});

	it("applies the default to the sandboxed route: a hanging command is killed", async () => {
		const ops = createOverlayBashOperations({
			bash: hangingBash,
			mapCwd: () => "/home/user/project",
			localOps: spyLocalOps([]),
			defaultTimeoutSeconds: 0.05,
		});
		await expect(ops.exec("hang", project, { onData: noOp })).rejects.toThrow("timeout:0.05");
	});

	it("an explicit timeout overrides the default", async () => {
		const calls: { timeout?: number }[] = [];
		const ops = createOverlayBashOperations({
			bash: hangingBash,
			mapCwd: () => null,
			localOps: spyLocalOps(calls),
			defaultTimeoutSeconds: 0.05,
		});
		await ops.exec("anything", project, { onData: noOp, timeout: 7 });
		expect(calls).toEqual([{ timeout: 7 }]);
	});
});

describe("resolveTimeoutMs (parity with pi's own validation)", () => {
	it("accepts undefined and positive finite timeouts", () => {
		expect(resolveTimeoutMs(undefined)).toBeUndefined();
		expect(resolveTimeoutMs(1)).toBe(1000);
		expect(resolveTimeoutMs(2_147_483.647)).toBe(2_147_483_647);
	});

	it("rejects non-positive and non-finite timeouts with pi's message", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(() => resolveTimeoutMs(bad)).toThrow("Invalid timeout: must be a finite number of seconds");
		}
	});

	it("rejects timeouts beyond the 32-bit ms cap with pi's message", () => {
		expect(() => resolveTimeoutMs(2_147_483.648)).toThrow("Invalid timeout: maximum is 2147483.647 seconds");
	});
});

describe("sanitizeEnv", () => {
	it("drops non-string values", () => {
		expect(sanitizeEnv({ A: "1", B: undefined })).toEqual({ A: "1" });
		expect(sanitizeEnv(undefined)).toBeUndefined();
	});
});
