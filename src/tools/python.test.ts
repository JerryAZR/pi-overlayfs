import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bash, createAgentSandbox } from "@jerryan/just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncMutex } from "../mutex.js";
import { createPathMapper, type PathMapper } from "../paths.js";
import { createOverlayEditOps, createOverlayReadOps, createOverlayWriteOps } from "./file-ops.js";
import { createPythonBash, createPythonToolDefinition, shellQuote, type PythonBash } from "./python.js";

let tmpRoot: string;
let home: string;
let project: string;
let mapper: PathMapper;
let vfs: Bash["fs"];
let virtualCwd: string;
const mutex = new AsyncMutex();

beforeEach(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlayfs-tools-"));
	home = path.join(tmpRoot, "home");
	project = path.join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(path.join(project, "hello.txt"), "hello\n");
	const sandbox = createAgentSandbox({ home, project, abortOnUnresolvedCommands: true });
	mapper = createPathMapper({
		overlays: [...sandbox.overlays.entries()].map(([mountPoint, { root }]) => ({ mountPoint, root })),
		projectRoot: project,
	});
	vfs = sandbox.bash.fs;
	virtualCwd = mapper.hostToVirtual(project)!.virtualPath;
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

describe("file-ops adapters (real sandbox vfs)", () => {
	it("reads host paths through the overlay", async () => {
		const ops = createOverlayReadOps(vfs, (p) => mapper.resolveToolPath(p));
		const buf = await ops.readFile(path.join(project, "hello.txt"));
		expect(buf).toBeInstanceOf(Buffer);
		expect(buf.toString("utf8")).toBe("hello\n");
		await expect(ops.access(path.join(project, "hello.txt"))).resolves.toBeUndefined();
		await expect(ops.access(path.join(project, "missing.txt"))).rejects.toThrow("ENOENT");
	});

	it("detects image mime types by extension", async () => {
		const ops = createOverlayReadOps(vfs, (p) => mapper.resolveToolPath(p));
		expect(await ops.detectImageMimeType!(path.join(project, "a.PNG"))).toBe("image/png");
		expect(await ops.detectImageMimeType!(path.join(project, "a.txt"))).toBeNull();
	});

	it("writes via virtual POSIX passthrough and recursive mkdir", async () => {
		const writeOps = createOverlayWriteOps(vfs, (p) => mapper.resolveToolPath(p));
		await writeOps.mkdir("/tmp/a/b");
		await writeOps.writeFile("/tmp/a/b/x.txt", "data");
		const readOps = createOverlayReadOps(vfs, (p) => mapper.resolveToolPath(p));
		expect((await readOps.readFile("/tmp/a/b/x.txt")).toString()).toBe("data");
	});

	it("edit ops write through to staged overlay changes", async () => {
		const editOps = createOverlayEditOps(vfs, (p) => mapper.resolveToolPath(p));
		await editOps.access(path.join(project, "hello.txt"));
		const before = await editOps.readFile(path.join(project, "hello.txt"));
		await editOps.writeFile(path.join(project, "hello.txt"), before.toString().replace("hello", "goodbye"));
		expect((await editOps.readFile(path.join(project, "hello.txt"))).toString()).toBe("goodbye\n");
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
	function makeTool() {
		return createPythonToolDefinition({
			vfs,
			pythonBash: createPythonBash(vfs, virtualCwd),
			resolveAbsolute: (p) => mapper.resolveToolPath(p),
			virtualCwd,
			runExclusive: (fn) => mutex.run(fn),
		});
	}

	it("rejects calls without exactly one of code/path", async () => {
		const tool = makeTool();
		await expect(tool.execute("id", {}, undefined, undefined)).rejects.toThrow("exactly one");
		await expect(
			tool.execute("id", { code: "print(1)", path: "x.py" }, undefined, undefined),
		).rejects.toThrow("exactly one");
	});

	it("runs inline code over the overlay filesystem and preserves output", async () => {
		const tool = makeTool();
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

	it("runs a script by host path with args", async () => {
		const tool = makeTool();
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

	it("reports non-zero exits in the text without throwing", async () => {
		const tool = makeTool();
		const result = await tool.execute("id", { code: "raise SystemExit(3)" }, undefined, undefined);
		expect(result.content[0]!.text).toMatch(/\(exit 3\)$/);
	});

	it("throws a clear error for a missing script", async () => {
		const tool = makeTool();
		await expect(tool.execute("id", { path: "nope.py" }, undefined, undefined)).rejects.toThrow(
			"script not found",
		);
	});
});

describe("python tool timeout + truncation (injected bash)", () => {
	function makeToolWith(pythonBash: PythonBash) {
		return createPythonToolDefinition({
			vfs,
			pythonBash,
			resolveAbsolute: (p) => mapper.resolveToolPath(p),
			virtualCwd,
			runExclusive: (fn) => mutex.run(fn),
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
		const tool = createPythonToolDefinition({
			vfs,
			pythonBash: hangingBash,
			resolveAbsolute: (p) => mapper.resolveToolPath(p),
			virtualCwd,
			runExclusive: (fn) => mutex.run(fn),
			defaultTimeoutSeconds: 0.05,
		});
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
