import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bash, createVfsTemplate, type MountableFs, type VfsTemplate } from "@jerryan/just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyChangeSetPerEntry } from "../finisher.js";
import { createPathMapper, type PathMapper } from "../paths.js";
import { createOverlayEditOps, createOverlayReadOps, createOverlayWriteOps } from "./file-ops.js";
import { createPythonToolDefinition, shellQuote, type PythonBash } from "./python.js";

let tmpRoot: string;
let home: string;
let project: string;
let template: VfsTemplate;
let mapper: PathMapper;
let virtualCwd: string;

beforeEach(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlayfs-tools-"));
	home = path.join(tmpRoot, "home");
	project = path.join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(path.join(project, "hello.txt"), "hello\n");
	// Fixture mount name is arbitrary (these tests exercise exec/finisher/python machinery,
	// not topology); production mounts are real-layout — see computeOverlayTopology.
	template = createVfsTemplate({ mounts: [{ at: "/home/user", root: home }] });
	mapper = createPathMapper({
		overlays: [{ mountPoint: "/home/user", root: home }],
		projectRoot: project,
	});
	virtualCwd = mapper.hostToVirtual(project)!;
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

const resolve = (p: string) => mapper.resolveToolPath(p);

describe("file-ops adapters (fresh fork per call)", () => {
	it("reads host paths through the overlay", async () => {
		const ops = createOverlayReadOps(template.fork(), resolve);
		const buf = await ops.readFile(path.join(project, "hello.txt"));
		expect(buf).toBeInstanceOf(Buffer);
		expect(buf.toString("utf8")).toBe("hello\n");
		await expect(ops.access(path.join(project, "hello.txt"))).resolves.toBeUndefined();
		await expect(ops.access(path.join(project, "missing.txt"))).rejects.toThrow("ENOENT");
	});

	it("detects image mime types by extension", async () => {
		const ops = createOverlayReadOps(template.fork(), resolve);
		expect(await ops.detectImageMimeType!(path.join(project, "a.PNG"))).toBe("image/png");
		expect(await ops.detectImageMimeType!(path.join(project, "a.txt"))).toBeNull();
	});

	it("writes via virtual POSIX passthrough land in shared scratch (/tmp)", async () => {
		const writeOps = createOverlayWriteOps(template.fork(), resolve);
		await writeOps.mkdir("/tmp/a/b");
		await writeOps.writeFile("/tmp/a/b/x.txt", "data");
		// /tmp is the shared scratch base: visible to every fork immediately.
		const readOps = createOverlayReadOps(template.fork(), resolve);
		expect((await readOps.readFile("/tmp/a/b/x.txt")).toString()).toBe("data");
	});

	it("edit ops write through to the fork's private staged changes", async () => {
		const fork = template.fork();
		const editOps = createOverlayEditOps(fork, resolve);
		await editOps.access(path.join(project, "hello.txt"));
		const before = await editOps.readFile(path.join(project, "hello.txt"));
		await editOps.writeFile(path.join(project, "hello.txt"), before.toString().replace("hello", "goodbye"));
		expect((await editOps.readFile(path.join(project, "hello.txt"))).toString()).toBe("goodbye\n");
		// Staged only: disk still has the original until merge+apply.
		expect(readFileSync(path.join(project, "hello.txt"), "utf8")).toBe("hello\n");
		expect(fork.diff({ space: "vfs" }).writes.map((w) => path.posix.basename(w.path))).toContain("hello.txt");
	});
});

describe("shellQuote", () => {
	it("wraps in single quotes and escapes embedded quotes", () => {
		expect(shellQuote("plain")).toBe("'plain'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		expect(shellQuote("a b$`c")).toBe("'a b$`c'");
	});
});

describe("python tool (real sandboxed CPython)", () => {
	function makeTool(): { tool: ReturnType<typeof createPythonToolDefinition>; registered: MountableFs[] } {
		const registered: MountableFs[] = [];
		const tool = createPythonToolDefinition({
			forkBash: () => {
				const fork = template.fork();
				return {
					bash: new Bash({ fs: fork, python: true, cwd: virtualCwd, env: { HOME: "/home/user" } }),
					fork,
				};
			},
			registerFork: (f) => registered.push(f),
			resolveAbsolute: resolve,
			virtualCwd,
		});
		return { tool, registered };
	}

	it("rejects calls without exactly one of code/path", async () => {
		const { tool } = makeTool();
		await expect(tool.execute("id", {}, undefined, undefined)).rejects.toThrow("exactly one");
		await expect(
			tool.execute("id", { code: "print(1)", path: "x.py" }, undefined, undefined),
		).rejects.toThrow("exactly one");
	});

	it("runs inline code over the overlay filesystem and preserves output", async () => {
		const { tool } = makeTool();
		const scriptPath = path.posix.join(virtualCwd, "hello.txt").replace(/\\/g, "/");
		const result = await tool.execute(
			"id",
			{ code: `import sys\nprint(open(${JSON.stringify(scriptPath)}).read().strip())\nprint('warn', file=sys.stderr)` },
			undefined,
			undefined,
		);
		const text = result.content[0]!.text;
		expect(text).toContain("hello");
		expect(text).toContain("--- stderr ---");
		expect(text).toContain("warn");
		expect(text).toMatch(/\(exit 0\)$/);
	});

	it("project writes register the fork and reach disk via merge+apply", async () => {
		const { tool, registered } = makeTool();
		const result = await tool.execute(
			"id",
			{ code: "open('made-by-python.txt', 'w').write('py\\n')" },
			undefined,
			undefined,
		);
		expect(result.content[0]!.text).toMatch(/\(exit 0\)$/);
		expect(existsSync(path.join(project, "made-by-python.txt"))).toBe(false);

		expect(registered).toHaveLength(1);
		const merged = await template.merge(registered);
		await applyChangeSetPerEntry(merged.diff({ space: "host" }));
		expect(existsSync(path.join(project, "made-by-python.txt"))).toBe(true);
	});

	it("a non-zero exit still registers the fork: effects before failure are legitimate", async () => {
		const { tool, registered } = makeTool();
		const result = await tool.execute("id", { code: "raise SystemExit(3)" }, undefined, undefined);
		expect(result.content[0]!.text).toMatch(/\(exit 3\)$/);
		// Non-zero exit is still a completed call — the fork IS registered
		// (the script's writes before the failure are legitimate effects).
		expect(registered).toHaveLength(1);
	});

	it("runs a script by host path with args", async () => {
		const { tool } = makeTool();
		await writeFile(path.join(project, "script.py"), "import sys\nprint(sys.argv[1])");
		const result = await tool.execute(
			"id",
			{ path: path.join(project, "script.py"), args: ["arg one"] },
			undefined,
			undefined,
		);
		expect(result.content[0]!.text).toContain("arg one");
		expect(result.content[0]!.text).toMatch(/\(exit 0\)$/);
	});

	it("throws a clear error for a missing script", async () => {
		const { tool, registered } = makeTool();
		await expect(tool.execute("id", { path: "nope.py" }, undefined, undefined)).rejects.toThrow(
			"script not found",
		);
		expect(registered).toHaveLength(0);
	});
});

describe("python tool params.cwd + abort", () => {
	it("honors params.cwd (host path and virtual POSIX)", async () => {
		const seenCwd: (string | undefined)[] = [];
		const spyBash: PythonBash = {
			exec: async (_cmd, opts) => {
				seenCwd.push(opts?.cwd);
				return { stdout: "", stderr: "", exitCode: 0, env: {} };
			},
		};
		const tool = createPythonToolDefinition({
			forkBash: () => ({ bash: spyBash, fork: template.fork() }),
			registerFork: () => {},
			resolveAbsolute: resolve,
			virtualCwd,
		});
		await tool.execute("id", { code: "pass", cwd: project }, undefined, undefined);
		expect(seenCwd[0]).toBe(virtualCwd);
		await tool.execute("id", { code: "pass", cwd: "/tmp" }, undefined, undefined);
		expect(seenCwd[1]).toBe("/tmp");
	});

	it("aborted python call rejects and does not register its fork", async () => {
		const registered: MountableFs[] = [];
		let execEntered!: () => void;
		const entered = new Promise<void>((r) => {
			execEntered = r;
		});
		const hangingBash: PythonBash = {
			exec: (_cmd, opts) => {
				execEntered();
				return new Promise((resolve) => {
					opts?.signal?.addEventListener("abort", () =>
						resolve({ stdout: "", stderr: "", exitCode: 1, env: {} }),
					);
				});
			},
		};
		const tool = createPythonToolDefinition({
			forkBash: () => ({ bash: hangingBash, fork: template.fork() }),
			registerFork: (f) => registered.push(f),
			resolveAbsolute: resolve,
			virtualCwd,
		});
		const controller = new AbortController();
		const pending = tool.execute("id", { code: "pass" }, controller.signal, undefined);
		// Abort only once the exec is in flight (its abort listener attached) —
		// deterministic, no timing race with the /tmp staging steps.
		await entered;
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		expect(registered).toHaveLength(0);
	});
});

describe("python tool timeout + truncation (injected bash)", () => {
	function makeToolWith(pythonBash: PythonBash, defaultTimeoutSeconds?: number) {
		return createPythonToolDefinition({
			forkBash: () => ({ bash: pythonBash, fork: template.fork() }),
			registerFork: () => {},
			resolveAbsolute: resolve,
			virtualCwd,
			...(defaultTimeoutSeconds !== undefined && { defaultTimeoutSeconds }),
		});
	}

	const okBash: PythonBash = {
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0, env: {} }),
	};

	it("validates timeout exactly like pi's bash tool", async () => {
		const tool = makeToolWith(okBash);
		await expect(tool.execute("id", { code: "pass", timeout: 0 }, undefined, undefined)).rejects.toThrow(
			"Invalid timeout: must be a finite number of seconds",
		);
		await expect(
			tool.execute("id", { code: "pass", timeout: Number.NaN }, undefined, undefined),
		).rejects.toThrow("Invalid timeout: must be a finite number of seconds");
		await expect(
			tool.execute("id", { code: "pass", timeout: 2_147_483.648 }, undefined, undefined),
		).rejects.toThrow("Invalid timeout: maximum is 2147483.647 seconds");
	});

	it("throws Error('timeout:<s>') with partial output attached when the timeout fires", async () => {
		const slowBash: PythonBash = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 1200));
				return { stdout: "partial-output\n", stderr: "", exitCode: 124, env: {} };
			},
		};
		const tool = makeToolWith(slowBash);
		await expect(tool.execute("id", { code: "pass", timeout: 1 }, undefined, undefined)).rejects.toThrow(
			/timeout:1[\s\S]*partial-output/,
		);
	});

	it("applies a default timeout when the model omits it", async () => {
		const hangingBash: PythonBash = {
			exec: (_cmd, opts) =>
				new Promise((resolve) => {
					opts?.signal?.addEventListener("abort", () =>
						resolve({ stdout: "", stderr: "", exitCode: 1, env: {} }),
					);
				}),
		};
		const tool = makeToolWith(hangingBash, 0.05);
		await expect(tool.execute("id", { code: "pass" }, undefined, undefined)).rejects.toThrow("timeout:0.05");
	});

	it("truncates oversized output with a note", async () => {
		const bigOutput = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
		const loudBash: PythonBash = {
			exec: async () => ({ stdout: bigOutput, stderr: "", exitCode: 0, env: {} }),
		};
		const tool = makeToolWith(loudBash);
		const result = await tool.execute("id", { code: "pass" }, undefined, undefined);
		const text = result.content[0]!.text;
		expect(text).toContain("[Output truncated");
		expect(text).toMatch(/\(exit 0\)$/);
		expect(text.length).toBeLessThan(bigOutput.length);
	});
});
