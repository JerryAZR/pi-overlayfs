import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { Bash, createVfsTemplate, type MountableFs, type VfsTemplate } from "@jerryan/just-bash";
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
import { applyChangeSetPerEntry } from "./finisher.js";
import { createPathMapper, type PathMapper } from "./paths.js";

let tmpRoot: string;
let home: string;
let project: string;
let template: VfsTemplate;
let mapper: PathMapper;
let virtualProject: string;

beforeEach(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlayfs-exec-"));
	home = path.join(tmpRoot, "home");
	project = path.join(home, "project");
	await mkdir(project, { recursive: true });
	// Fixture mount name is arbitrary (these tests exercise exec/finisher/python machinery,
	// not topology); production mounts are real-layout — see computeOverlayTopology.
	template = createVfsTemplate({ mounts: [{ at: "/home/user", root: home }] });
	mapper = createPathMapper({
		overlays: [{ mountPoint: "/home/user", root: home }],
		projectRoot: project,
	});
	virtualProject = mapper.hostToVirtual(project)!;
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

function forkBash(): { bash: SandboxBash; fork: MountableFs } {
	const fork = template.fork();
	return {
		bash: new Bash({
			fs: fork,
			cwd: virtualProject,
			env: { HOME: "/home/user" },
			abortOnUnresolvedCommands: true,
		}),
		fork,
	};
}

/** Deps wired like the production bash operations: a fresh fork+Bash per call. */
function realDeps(nativeCalls: string[]): { deps: BashExecDeps; fork: MountableFs } {
	const { bash, fork } = forkBash();
	return {
		deps: {
			analyze: (cmd) => bash.analyzeCommands(cmd),
			execSandboxed: (cmd, cwd) => runSandboxed(bash, cmd, { virtualCwd: cwd, onData: () => {} }),
			execNative: async (cmd) => {
				nativeCalls.push(cmd);
				return { exitCode: 0 };
			},
		},
		fork,
	};
}

const noOp = () => {};

describe("execBashWithFallback (real vfs template on temp dirs)", () => {
	it("runs resolvable commands in the sandbox; writes stay in the private fork", async () => {
		const nativeCalls: string[] = [];
		const { deps, fork } = realDeps(nativeCalls);

		const outcome = await execBashWithFallback(
			{ command: "echo hello > out.txt", hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
		);

		expect(outcome.route).toBe("sandboxed");
		expect(outcome.exitCode).toBe(0);
		expect(nativeCalls).toEqual([]);
		// Staged in the fork's private overlay, not on disk:
		expect(fork.diff({ space: "vfs" }).writes.map((w) => path.posix.basename(w.path))).toContain("out.txt");
		expect(existsSync(path.join(project, "out.txt"))).toBe(false);
	});

	it("emits buffered stdout then stderr exactly once on the sandboxed route", async () => {
		const chunks: Buffer[] = [];
		const { deps } = realDeps([]);
		const outcome = await execBashWithFallback(
			{ command: "echo out; echo err 1>&2", hostCwd: project, virtualCwd: virtualProject, onData: (d) => chunks.push(d) },
			deps,
		);
		expect(outcome.route).toBe("sandboxed");
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toBeInstanceOf(Buffer);
		expect(chunks[0]!.toString()).toBe("out\n");
		expect(chunks[1]!.toString()).toBe("err\n");
	});

	it("a completed call registers its fork regardless of exit code: staged effects merge at turn_end", async () => {
		// Parity with the python tool's pin: a non-zero exit is still a
		// completed call — writes staged before the failure are legitimate
		// effects and must reach the merge.
		const registered: MountableFs[] = [];
		const ops = createOverlayBashOperations({
			forkBash,
			registerFork: (fork) => registered.push(fork),
			mapCwd: (hostCwd) => mapper.hostToVirtual(hostCwd),
			localOps: {
				exec: async () => {
					throw new Error("native route must not be taken");
				},
			},
		});

		const result = await ops.exec("echo staged > staged.txt; exit 3", project, { onData: noOp });
		expect(result.exitCode).toBe(3);
		expect(registered).toHaveLength(1);

		const merged = await template.merge(registered);
		await applyChangeSetPerEntry(merged.diff({ space: "host" }));
		expect(readFileSync(path.join(project, "staged.txt"), "utf8")).toBe("staged\n");
	});

	it("falls back to native when static analysis finds unresolved commands", async () => {
		const nativeCalls: string[] = [];
		const { deps } = realDeps(nativeCalls);

		const outcome = await execBashWithFallback(
			{ command: "definitely-not-a-real-command-xyz --flag", hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
		);

		expect(outcome.route).toBe("native-unresolved-static");
		expect(nativeCalls).toEqual(["definitely-not-a-real-command-xyz --flag"]);
	});

	it("falls back to native when static analysis cannot parse the command (cmd-style syntax)", async () => {
		const nativeCalls: string[] = [];
		const { deps } = realDeps(nativeCalls);
		// Windows cmd-style: %VAR% and backslash quoting make just-bash's parser throw.
		const command = 'ls -la "%USERPROFILE%\\.pi\\agent\\" 2>nul || echo missing';

		const outcome = await execBashWithFallback(
			{ command, hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
		);

		expect(outcome.route).toBe("native-unparseable");
		expect(nativeCalls).toEqual([command]);
	});

	it("rejects a command mixing rm with host-only commands — nothing runs", async () => {
		const nativeCalls: string[] = [];
		const { deps, fork } = realDeps(nativeCalls);
		await writeFile(path.join(project, "scratch.txt"), "x");

		const error = await execBashWithFallback(
			{ command: "rm scratch.txt && cargo build", hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
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
		expect(fork.diff({ space: "vfs" }).deletions).toEqual([]);
		expect(existsSync(path.join(project, "scratch.txt"))).toBe(true);
	});

	it.each([
		["mv a.txt b.txt && npm install", "mv", "npm"],
		["rmdir old-dir && cargo build", "rmdir", "cargo"],
	])("rejects mixed sensitive+native: %s", async (command, verb, blocker) => {
		const nativeCalls: string[] = [];
		const { deps } = realDeps(nativeCalls);

		await expect(
			execBashWithFallback(
				{ command, hostCwd: project, virtualCwd: virtualProject, onData: noOp },
				deps,
			),
		).rejects.toThrow(new RegExp(`${verb}[^]*${blocker}|${blocker}[^]*${verb}`));
		expect(nativeCalls).toEqual([]);
	});

	it("rejects rm mixed with a runtime-only unresolved command — no native rerun", async () => {
		const nativeCalls: string[] = [];
		const { deps } = realDeps(nativeCalls);
		await writeFile(path.join(project, "scratch.txt"), "x");
		// someunknowncmd is produced by a command substitution: static analysis
		// sees only [rm, echo] (both resolvable); the unresolved name appears
		// only at runtime. The mixed-call gate must hold on the runtime
		// fallback too — otherwise the rm executes natively, ungated.
		const command = "rm scratch.txt && $(echo someunknowncmd)";

		await expect(
			execBashWithFallback(
				{ command, hostCwd: project, virtualCwd: virtualProject, onData: noOp },
				deps,
			),
		).rejects.toThrow(/rm[^]*separate|separate[^]*rm/i);
		expect(nativeCalls).toEqual([]);
		expect(existsSync(path.join(project, "scratch.txt"))).toBe(true);
	});

	it("does not reject rm as a non-command token (git rm, echo rm)", async () => {
		for (const command of ["git rm --cached scratch.txt", "echo rm -rf / && cargo build"]) {
			const nativeCalls: string[] = [];
			const { deps } = realDeps(nativeCalls);
			const outcome = await execBashWithFallback(
				{ command, hostCwd: project, virtualCwd: virtualProject, onData: noOp },
				deps,
			);
			expect(outcome.route).toBe("native-unresolved-static");
			expect(nativeCalls).toEqual([command]);
		}
	});

	it("does not reject benign verbs (mkdir, touch) mixed with host-only commands", async () => {
		const nativeCalls: string[] = [];
		const { deps } = realDeps(nativeCalls);
		const command = "mkdir -p build && touch build/.keep && cargo build";

		const outcome = await execBashWithFallback(
			{ command, hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
		);
		expect(outcome.route).toBe("native-unresolved-static");
		expect(nativeCalls).toEqual([command]);
	});

	it("rm alone still runs sandboxed: deletion staged in the fork, disk untouched", async () => {
		const nativeCalls: string[] = [];
		const { deps, fork } = realDeps(nativeCalls);
		await writeFile(path.join(project, "doomed.txt"), "x");

		const outcome = await execBashWithFallback(
			{ command: "rm doomed.txt", hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
		);
		expect(outcome.route).toBe("sandboxed");
		expect(nativeCalls).toEqual([]);
		expect(existsSync(path.join(project, "doomed.txt"))).toBe(true);
		expect(fork.diff({ space: "vfs" }).deletions).toHaveLength(1);
	});

	it("falls back to native when the cwd maps to no overlay (ops-level short-circuit)", async () => {
		const calls: string[] = [];
		const localOps: BashOperations = {
			exec: async (cmd) => {
				calls.push(cmd);
				return { exitCode: 0 };
			},
		};
		const ops = createOverlayBashOperations({
			forkBash: () => {
				throw new Error("must not fork for the native route");
			},
			registerFork: () => {
				throw new Error("must not register");
			},
			mapCwd: () => null,
			localOps,
		});
		await ops.exec("echo hi", tmpRoot, { onData: noOp });
		expect(calls).toEqual(["echo hi"]);
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
 * H1/H2 regression, fork-model edition: a command whose prefix stages writes
 * before hitting an unresolved command at runtime (fail-fast abort) falls
 * back to a native rerun. The aborted run's fork is simply never registered,
 * so its partial writes can never reach the merge — no discard machinery, no
 * lock. And the aborted run's output is never emitted (no duplication).
 */
describe("runtime fallback safety (real vfs template)", () => {
	// Passes static analysis (the unresolved name is produced by a command
	// substitution), stages ts.txt, then aborts on the unresolved command.
	const TRICKY = "echo prefixout; echo staged > ts.txt && $(echo someunknowncmd)";

	function makeOps(
		nativeCalls: string[],
		nativeWrites: (() => Promise<void>) | undefined,
		registered: MountableFs[],
	) {
		const localOps: BashOperations = {
			exec: async (cmd, _cwd, { onData }) => {
				nativeCalls.push(cmd);
				onData(Buffer.from("prefixout\nnative\n"));
				await nativeWrites?.();
				return { exitCode: 0 };
			},
		};
		return createOverlayBashOperations({
			forkBash,
			registerFork: (fork) => registered.push(fork),
			mapCwd: (hostCwd) => mapper.hostToVirtual(hostCwd),
			localOps,
		});
	}

	it("H1: the aborted run's fork is never registered — the merge finds nothing stale", async () => {
		const nativeCalls: string[] = [];
		const registered: MountableFs[] = [];
		const tsPath = path.join(project, "ts.txt");
		const ops = makeOps(
			nativeCalls,
			async () => {
				// Native run produces its own (newer) version of the file.
				await import("node:fs/promises").then((fs) => fs.writeFile(tsPath, "native\n"));
			},
			registered,
		);

		const result = await ops.exec(TRICKY, project, { onData: noOp });
		expect(result.exitCode).toBe(0);
		expect(nativeCalls).toEqual([TRICKY]);

		// The whole discard: nothing was registered, so nothing stale can be
		// merged/applied over the native run's newer file.
		expect(registered).toHaveLength(0);
		const merged = await template.merge(registered);
		expect(merged.diff({ space: "vfs" }).writes).toHaveLength(0);
		expect(await import("node:fs/promises").then((fs) => fs.readFile(tsPath, "utf8"))).toBe("native\n");
	});

	it("H2: the aborted run's output is not emitted — no duplication with the native rerun", async () => {
		const chunks: Buffer[] = [];
		const ops = makeOps([], undefined, []);

		await ops.exec(TRICKY, project, { onData: (d) => chunks.push(d) });

		const emitted = Buffer.concat(chunks).toString();
		// Exactly the native run's output, once. The sandboxed prefix output
		// ("prefixout" from the aborted attempt) must not appear.
		expect(emitted).toBe("prefixout\nnative\n");
	});

	it("a concurrent sibling's runtime fallback never eats the survivor's writes", async () => {
		const registered: MountableFs[] = [];
		const ops = makeOps([], undefined, registered);

		await Promise.all([
			ops.exec(TRICKY, project, { onData: noOp }),
			ops.exec("echo b > b.txt", project, { onData: noOp }),
		]);

		// Only the surviving call registered its fork.
		expect(registered).toHaveLength(1);
		const merged = await template.merge(registered);
		const paths = merged.diff({ space: "vfs" }).writes.map((w) => path.posix.basename(w.path));
		expect(paths).toContain("b.txt");
		expect(paths).not.toContain("ts.txt");
	});

	it("two concurrent sandboxed calls merge cleanly — no locking anywhere", async () => {
		const registered: MountableFs[] = [];
		const ops = makeOps([], undefined, registered);

		await Promise.all([
			ops.exec("echo a > a.txt", project, { onData: noOp }),
			ops.exec("echo b > b.txt", project, { onData: noOp }),
		]);

		expect(registered).toHaveLength(2);
		const merged = await template.merge(registered);
		const paths = merged.diff({ space: "vfs" }).writes.map((w) => path.posix.basename(w.path));
		expect(paths).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
	});
});

describe("runSandboxed semantics (real vfs template)", () => {
	it("returns buffered output without emitting on success", async () => {
		const { bash } = forkBash();
		const chunks: Buffer[] = [];
		const result = await runSandboxed(bash, "echo out; echo err 1>&2", {
			virtualCwd: "/home/user",
			onData: (d) => chunks.push(d),
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("out\n");
		expect(result.stderr).toBe("err\n");
		expect(chunks).toHaveLength(0);
	});

	it("throws Error('timeout:<seconds>') when the timeout fires, emitting output captured so far first (M2)", async () => {
		const { bash } = forkBash();
		const chunks: Buffer[] = [];
		await expect(
			runSandboxed(bash, "echo before-hang; sleep 30", {
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

	it("a generic exec error while aborted surfaces as Error('aborted') (injected bash)", async () => {
		const controller = new AbortController();
		const fakeBash: SandboxBash = {
			exec: async () => {
				controller.abort();
				throw new Error("shell exploded");
			},
			analyzeCommands: async () => ({ commands: [], unresolved: [] }),
		};
		await expect(
			runSandboxed(fakeBash, "whatever", {
				virtualCwd: "/home/user",
				onData: noOp,
				signal: controller.signal,
			}),
		).rejects.toThrow(/^aborted$/);
	});

	it("a generic exec error after the timeout fires surfaces as Error('timeout:<s>') (injected bash)", async () => {
		const fakeBash: SandboxBash = {
			exec: (_cmd, opts) =>
				new Promise((_resolve, reject) => {
					// The timeout kills the run via the injected signal; the shell
					// reports it with its own (non-timeout) error.
					opts?.signal?.addEventListener("abort", () => reject(new Error("killed by shell")));
				}),
			analyzeCommands: async () => ({ commands: [], unresolved: [] }),
		};
		await expect(
			runSandboxed(fakeBash, "whatever", {
				virtualCwd: "/home/user",
				onData: noOp,
				timeout: 0.05,
			}),
		).rejects.toThrow("timeout:0.05");
	});

	it("a generic exec error with no abort/timeout propagates unchanged", async () => {
		const fakeBash: SandboxBash = {
			exec: async () => {
				throw new Error("shell exploded");
			},
			analyzeCommands: async () => ({ commands: [], unresolved: [] }),
		};
		await expect(
			runSandboxed(fakeBash, "whatever", { virtualCwd: "/home/user", onData: noOp }),
		).rejects.toThrow("shell exploded");
	});

	it("throws Error('aborted') when the signal is already aborted", async () => {
		const { bash } = forkBash();
		const controller = new AbortController();
		controller.abort();
		await expect(
			runSandboxed(bash, "echo hi", {
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

	const nullForkBash = () => ({ bash: hangingBash, fork: null });

	it("applies the default to the native route when timeout is omitted", async () => {
		const calls: { timeout?: number }[] = [];
		const ops = createOverlayBashOperations({
			forkBash: nullForkBash,
			registerFork: () => {},
			mapCwd: () => null, // forces the native route
			localOps: spyLocalOps(calls),
		});
		await ops.exec("anything", project, { onData: noOp });
		expect(calls).toEqual([{ timeout: DEFAULT_TIMEOUT_SECONDS }]);
	});

	it("applies the default to the sandboxed route: a hanging command is killed", async () => {
		const ops = createOverlayBashOperations({
			forkBash: nullForkBash,
			registerFork: () => {},
			mapCwd: () => "/home/user/project",
			localOps: spyLocalOps([]),
			defaultTimeoutSeconds: 0.05,
		});
		await expect(ops.exec("hang", project, { onData: noOp })).rejects.toThrow("timeout:0.05");
	});

	it("abort/timeout never registers the fork", async () => {
		const registered: unknown[] = [];
		const ops = createOverlayBashOperations({
			forkBash: nullForkBash,
			registerFork: (f) => registered.push(f),
			mapCwd: () => "/home/user/project",
			localOps: spyLocalOps([]),
			defaultTimeoutSeconds: 0.05,
		});
		await expect(ops.exec("hang", project, { onData: noOp })).rejects.toThrow("timeout:0.05");
		expect(registered).toHaveLength(0);
	});

	it("an explicit timeout overrides the default", async () => {
		const calls: { timeout?: number }[] = [];
		const ops = createOverlayBashOperations({
			forkBash: nullForkBash,
			registerFork: () => {},
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

describe("fail-closed mode (no native fallback — read-only agents)", () => {
	/** Same real-sandbox wiring, minus abortOnUnresolvedCommands and execNative. */
	function roDeps(): { deps: BashExecDeps; fork: MountableFs } {
		const fork = template.fork();
		const bash = new Bash({ fs: fork, cwd: virtualProject, env: { HOME: "/home/user" } });
		return {
			deps: {
				analyze: (cmd) => bash.analyzeCommands(cmd),
				execSandboxed: (cmd, cwd) => runSandboxed(bash, cmd, { virtualCwd: cwd, onData: () => {} }),
				// No execNative: any attempt to route native is a TypeError crash,
				// which is itself the assertion that no native route was taken.
			},
			fork,
		};
	}

	it("runs resolvable commands sandboxed, same as rw mode", async () => {
		const { deps, fork } = roDeps();
		const outcome = await execBashWithFallback(
			{ command: "echo hi > note.txt", hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
		);
		expect(outcome.route).toBe("sandboxed");
		expect(outcome.exitCode).toBe(0);
		expect(fork.diff({ space: "vfs" }).writes.map((w) => path.posix.basename(w.path))).toContain("note.txt");
	});

	it("statically unresolved commands run sandboxed and 127 bash-style, no native", async () => {
		const { deps } = roDeps();
		const chunks: Buffer[] = [];
		const outcome = await execBashWithFallback(
			{
				command: "echo before; definitely-not-a-real-command-xyz --flag; echo after",
				hostCwd: project,
				virtualCwd: virtualProject,
				onData: (d) => chunks.push(d),
			},
			deps,
		);
		expect(outcome.route).toBe("sandboxed");
		// Bash `;` lists return the LAST command's status (echo after → 0);
		// the miss itself is reported in-band. (The 127 case is pinned by the
		// runtime-composed test below.)
		expect(outcome.exitCode).toBe(0);
		const text = Buffer.concat(chunks).toString();
		expect(text).toContain("before");
		expect(text).toContain("after");
		expect(text).toMatch(/command not found/i);
	});

	it("runtime-composed unresolved commands 127 in-sandbox too", async () => {
		const { deps } = roDeps();
		const outcome = await execBashWithFallback(
			{ command: "$(echo someunknowncmd)", hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
		);
		expect(outcome.route).toBe("sandboxed");
		expect(outcome.exitCode).toBe(127);
	});

	it("rm mixed with unresolved commands is NOT rejected: the gate guards native reruns, which do not exist here", async () => {
		const { deps, fork } = roDeps();
		await writeFile(path.join(project, "scratch.txt"), "x\n");
		const outcome = await execBashWithFallback(
			{ command: "rm scratch.txt && faketool --run", hostCwd: project, virtualCwd: virtualProject, onData: noOp },
			deps,
		);
		expect(outcome.route).toBe("sandboxed");
		expect(outcome.exitCode).toBe(127);
		// The rm ran — inside the fork only; disk is untouched.
		expect(fork.diff({ space: "vfs" }).deletions.some((d) => d.endsWith("scratch.txt"))).toBe(true);
		expect(existsSync(path.join(project, "scratch.txt"))).toBe(true);
	});

	it("unparseable commands surface as a tool error (no native to degrade to)", async () => {
		const { deps } = roDeps();
		await expect(
			execBashWithFallback(
				{ command: 'ls "%USERPROFILE%\.pi\\" 2>nul', hostCwd: project, virtualCwd: virtualProject, onData: noOp },
				deps,
			),
		).rejects.toThrow(/could not be parsed/i);
	});

	it("createOverlayBashOperations without localOps: unmappable cwd is a tool error", async () => {
		const ops = createOverlayBashOperations({
			forkBash: () => {
				throw new Error("forkBash must not be reached");
			},
			registerFork: () => {},
			mapCwd: () => null,
		});
		await expect(ops.exec("ls", project, { onData: noOp })).rejects.toThrow(/cannot map cwd/i);
	});
});
