/**
 * Integration tests for the read-only sandbox tools (sandbox-bash.ts).
 *
 * These run the real just-bash interpreter (over real VfsTemplate forks on
 * real temp dirs) — the fail-closed routing and the just-git capability
 * layer are the things under test, so mocks would test nothing.
 *
 * TODO: once the upstream readOnly mount option lands, add tests pinning
 * write-denial (EROFS) against the project mount. Until then writes are
 * only dropped (never merged), not denied — there is nothing to pin.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createReadOnlyTools } from "./read-only-tools.js";

let repoDir: string;
let tools: ToolDefinition<any>[];
let bashTool: ToolDefinition<any>;
let pythonTool: ToolDefinition<any>;

function run(command: string) {
	return bashTool.execute("test", { command }, undefined, undefined, undefined as any);
}

/** Output text of a successful call. */
async function textOf(command: string) {
	const result = await run(command);
	return result.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("") as string;
}

/** The built-in bash tool throws on non-zero exit; the message carries the output plus the code. */
async function errorOf(command: string) {
	try {
		await run(command);
	} catch (err: any) {
		return err.message as string;
	}
	throw new Error(`expected non-zero exit: ${command}`);
}

beforeAll(() => {
	// Requires a real git binary on PATH to build the fixture repository.
	repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-sandbox-"));
	fs.writeFileSync(path.join(repoDir, "hello.txt"), "hello world\n");
	fs.mkdirSync(path.join(repoDir, "src"));
	fs.writeFileSync(path.join(repoDir, "src", "app.ts"), "export const x = 1;\n");
	const git = (args: string) =>
		execFileSync("git", args.split(" "), { cwd: repoDir, stdio: "pipe" });
	git("init -q");
	git("config user.email test@example.com");
	git("config user.name Test");
	git("add .");
	git("commit -q -m initial");

	tools = createReadOnlyTools({ cwd: repoDir });
	bashTool = tools.find((t) => t.name === "bash")!;
	pythonTool = tools.find((t) => t.name === "python")!;
});

afterAll(() => {
	fs.rmSync(repoDir, { recursive: true, force: true });
});

describe("tool surface", () => {
	it("returns the sandboxed bash and python tools", () => {
		expect(tools.map((t) => t.name).sort()).toEqual(["bash", "python"]);
	});
});

describe("sandboxed bash: basic execution", () => {
	it("runs pipelines with cwd at the project root", async () => {
		const out = await textOf("cat hello.txt | grep -n world");
		expect(out).toMatch(/1:hello world/);
	});

	it("resolves relative paths against the project root", async () => {
		const out = await textOf("cat src/app.ts");
		expect(out).toMatch(/export const x = 1/);
	});

	it("reports non-zero exit codes", async () => {
		const msg = await errorOf("grep -q zzzz hello.txt");
		expect(msg).toMatch(/Command exited with code 1/);
	});
});

describe("sandboxed bash: fail-closed routing", () => {
	it("host dev tools 127 in-band — nothing runs natively", async () => {
		const msg = await errorOf("npm --version");
		expect(msg).toMatch(/Command exited with code 127/);
		expect(msg).toMatch(/command not found/);
	});

	it("bogus commands 127 in-band", async () => {
		const msg = await errorOf("definitely-not-a-real-command-xyz --help");
		expect(msg).toMatch(/Command exited with code 127/);
		expect(msg).toMatch(/command not found/);
	});
});

describe("sandboxed bash: /tmp scratch persists across calls", () => {
	it("a file written via bash is visible to a later call (shared template scratch)", async () => {
		await textOf("echo scratch > /tmp/pi-sandbox-marker.txt");
		const out = await textOf("cat /tmp/pi-sandbox-marker.txt");
		expect(out).toMatch(/scratch/);
	});
});

describe("sandboxed bash: git", () => {
	it("read-only git commands work (just-git against the mounted repo)", async () => {
		const log = await textOf("git log --oneline");
		expect(log).toMatch(/initial/);
		const show = await textOf("git show --stat HEAD");
		expect(show).toMatch(/hello\.txt/);
		// status compares the working tree; just exit-success matters here.
		const status = await textOf("git status --short; echo done=$?");
		expect(status).toMatch(/done=0/);
	});

	it("pure-mutator git verbs are disabled with a clean error", async () => {
		for (const verb of ["add hello.txt", "commit -m x", "checkout -b x", "reset --hard", "clean -f"]) {
			const msg = await errorOf(`git ${verb}`);
			expect(msg, `git ${verb}`).toMatch(/not available in this environment/);
		}
		// Nothing was staged or committed: still exactly one commit.
		const count = await textOf("git log --oneline | wc -l");
		expect(count).toMatch(/1/);
	});
});

describe("python tool", () => {
	it("executes stdlib code in the sandbox", async () => {
		const result = await pythonTool.execute(
			"test",
			{ code: "import sys, json\nprint(json.dumps({'major': sys.version_info[0]}))" },
			undefined,
			undefined,
			undefined as any,
		);
		const text = result.content.map((c: any) => c.text).join("");
		expect(text).toContain('"major": 3');
		expect(text).toContain("(exit 0)");
	});
});
