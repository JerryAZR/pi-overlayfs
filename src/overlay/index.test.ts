import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index.js";
import { canonicalizeHostPathFs, virtualMountPointFor } from "./paths.js";

/**
 * Wiring test: drives the extension's default export with a minimal fake pi
 * (no pi runtime) and a real sandbox on temp dirs. Asserts registration
 * shape, guideline appends, path mapping through a symlinked cwd, and the
 * turn_end finisher wiring end to end.
 */

// The ExtensionAPI surface we use, structurally faked (cast below — a full
// ExtensionAPI mock would drown the test in unrelated members).
type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

interface FakePi {
	handlers: Map<string, Handler>;
	tools: { name: string; promptGuidelines?: readonly string[]; execute: (...args: unknown[]) => unknown }[];
	messages: { msg: Record<string, unknown>; opts?: Record<string, unknown> }[];
	pi: object;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, Handler>();
	const tools: FakePi["tools"] = [];
	const messages: FakePi["messages"] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (def: FakePi["tools"][number]) => tools.push(def),
		sendMessage: (msg: Record<string, unknown>, opts?: Record<string, unknown>) => {
			messages.push({ msg, opts });
		},
	};
	return { handlers, tools, messages, pi };
}

let tmpRoot: string;
let home: string;
let project: string;

beforeEach(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlayfs-index-"));
	home = path.join(tmpRoot, "home");
	project = path.join(home, "project");
	await mkdir(project, { recursive: true });
	// Point the sandbox home at the temp dir (os.homedir reads these per call).
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("HOME", home);
	delete process.env.PI_OVERLAYFS_OUTSIDE_PROJECT;
});

afterEach(async () => {
	vi.unstubAllEnvs();
	delete process.env.PI_OVERLAYFS_OUTSIDE_PROJECT;
	await rm(tmpRoot, { recursive: true, force: true });
});

function fakeCtx(
	cwd: string,
	opts: {
		hasUI?: boolean;
		confirm?: (title: string, message: string) => Promise<boolean>;
		notifications?: string[];
	} = {},
) {
	return {
		cwd,
		hasUI: opts.hasUI ?? false,
		ui: {
			notify: (msg: string) => opts.notifications?.push(msg),
			confirm: opts.confirm ?? (async () => true),
		},
	};
}

async function startSession(fake: FakePi, cwd: string, ctx = fakeCtx(cwd)) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake pi is intentionally partial
	extension(fake.pi as any);
	// Pin the event names the extension must register — a typo'd or renamed
	// event would otherwise surface as a cryptic undefined-handler crash below.
	expect(fake.handlers.has("session_start")).toBe(true);
	expect(fake.handlers.has("turn_end")).toBe(true);
	await fake.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	return ctx;
}

function toolByName(fake: FakePi, name: string) {
	const tool = fake.tools.find((t) => t.name === name);
	expect(tool, `tool ${name} registered`).toBeDefined();
	return tool!;
}

/** Fire the turn_end event the way pi does after a tool batch completes. */
function turnEnd(fake: FakePi, ctx: unknown) {
	return fake.handlers.get("turn_end")!(
		{ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] },
		ctx,
	);
}

describe("extension wiring (fake pi, real sandbox)", () => {
	it("registers bash/read/write/edit/python", async () => {
		const fake = makeFakePi();
		await startSession(fake, project);
		expect(fake.tools.map((t) => t.name).sort()).toEqual(["bash", "edit", "python", "read", "write"]);
	});

	it("bash carries its built-in prompt metadata unchanged", async () => {
		const fake = makeFakePi();
		await startSession(fake, project);
		const bash = toolByName(fake, "bash");
		const guidelines = bash.promptGuidelines ?? [];
		// Built-in guideline preserved, nothing appended:
		expect(guidelines.some((g) => g.includes("PI_*"))).toBe(true);
		expect(guidelines.some((g) => g.includes("without isolation"))).toBe(false);
	});

	it("bash timeout parameter documents the default", async () => {
		const fake = makeFakePi();
		await startSession(fake, project);
		const bash = toolByName(fake, "bash");
		// The rebuilt schema must not claim "no default timeout" (we apply one).
		const schema = JSON.stringify((bash as { parameters?: unknown }).parameters ?? {});
		expect(schema).toContain("defaults to 300");
		expect(schema).not.toContain("no default timeout");
	});

	it("bash carries the mixed-call split guideline; other tools do not", async () => {
		const fake = makeFakePi();
		await startSession(fake, project);
		const bashGuidelines = toolByName(fake, "bash").promptGuidelines ?? [];
		expect(bashGuidelines.some((g) => g.includes("Never combine rm, mv or rmdir"))).toBe(true);
		for (const name of ["read", "write", "edit", "python"]) {
			const guidelines = toolByName(fake, name).promptGuidelines ?? [];
			expect(guidelines.some((g) => g.includes("Never combine rm, mv or rmdir"))).toBe(false);
		}
	});

	it("read/write/edit carry their built-in guidelines unchanged", async () => {
		const fake = makeFakePi();
		await startSession(fake, project);
		const expected: Record<string, string> = {
			read: "instead of cat or sed",
			write: "complete rewrites",
			edit: "oldText",
		};
		for (const [name, builtIn] of Object.entries(expected)) {
			const guidelines = toolByName(fake, name).promptGuidelines ?? [];
			expect(guidelines.some((g) => g.includes(builtIn))).toBe(true);
			expect(guidelines.some((g) => g.includes("throwaway in-memory"))).toBe(false);
		}
	});

	it("write tool stages via overlay; turn_end finisher auto-applies inside-project changes", async () => {
		const notifications: string[] = [];
		const fake = makeFakePi();
		const ctx = await startSession(fake, project, fakeCtx(project, { notifications }));
		const write = toolByName(fake, "write");

		const target = path.join(project, "made.txt");
		await write.execute("call-1", { path: target, content: "hello\n" }, undefined, undefined);
		// Staged only, not yet on disk:
		expect(existsSync(target)).toBe(false);

		await turnEnd(fake, ctx);
		expect(readFileSync(target, "utf8")).toBe("hello\n");
	});

	it("bash sandboxed call registers its fork; turn_end applies it", async () => {
		const fake = makeFakePi();
		const ctx = await startSession(fake, project);
		const bash = toolByName(fake, "bash");

		const target = path.join(project, "bash-made.txt");
		await bash.execute("call-1", { command: "echo hi > bash-made.txt" }, undefined, undefined);
		expect(existsSync(target)).toBe(false);

		await turnEnd(fake, ctx);
		expect(readFileSync(target, "utf8")).toBe("hi\n");
	});

	it("pins mid-turn isolation: a read before turn_end sees disk, after turn_end sees the applied write", async () => {
		const fake = makeFakePi();
		const ctx = await startSession(fake, project);
		const write = toolByName(fake, "write");
		const read = toolByName(fake, "read");
		const target = path.join(project, "pinned.txt");

		await write.execute("call-1", { path: target, content: "v1\n" }, undefined, undefined);
		// Same turn: forks are isolated until the merge — the read still sees
		// live disk, where the file does not exist yet.
		await expect(read.execute("call-2", { path: target }, undefined, undefined)).rejects.toThrow(
			/ENOENT|not found/i,
		);
		// After the barrier the write is applied and visible.
		await turnEnd(fake, ctx);
		const after = await read.execute("call-3", { path: target }, undefined, undefined);
		expect(JSON.stringify(after)).toContain("v1");
	});

	it("a failed edit call never reaches the merge", async () => {
		const fake = makeFakePi();
		const ctx = await startSession(fake, project);
		const target = path.join(project, "seed-edit.txt");
		await writeFile(target, "hello\n");
		const edit = toolByName(fake, "edit");

		await expect(
			edit.execute("call-1", { path: target, oldText: "NOT PRESENT", newText: "x" }, undefined, undefined),
		).rejects.toThrow();
		await turnEnd(fake, ctx);
		expect(readFileSync(target, "utf8")).toBe("hello\n");
		expect(fake.messages).toHaveLength(0);
	});

	it("turn_end applies completed calls' changes even when the turn ended abnormally", async () => {
		const fake = makeFakePi();
		const ctx = await startSession(fake, project);
		const write = toolByName(fake, "write");

		// A completed call staged a change; the turn then ended abnormally
		// (user abort / stream error → pi emits turn_end with toolResults: []).
		const target = path.join(project, "abort-turn.txt");
		await write.execute("call-1", { path: target, content: "x\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(readFileSync(target, "utf8")).toBe("x\n");
	});

	it("finisher failure (confirm throws) → drops, notifies, and steers with the failed paths", async () => {
		const notifications: string[] = [];
		const fake = makeFakePi();
		const ctx = fakeCtx(project, {
			hasUI: true,
			notifications,
			confirm: async () => {
				throw new Error("ui exploded");
			},
		});
		await startSession(fake, project, ctx);
		const write = toolByName(fake, "write");
		const outside = path.join(home, "failed.txt");

		await write.execute("call-1", { path: outside, content: "x\n" }, undefined, undefined);
		await turnEnd(fake, ctx);

		expect(existsSync(outside)).toBe(false);
		expect(notifications.some((n) => n.includes("ui exploded"))).toBe(true);
		expect(fake.messages).toHaveLength(1);
		const content = String(fake.messages[0]!.msg.content);
		expect(content).toContain("failed.txt");
		expect(content).toMatch(/could not be written/i);
	});

	it("sends a steering warning when outside-project changes are denied (UI deny)", async () => {
		const fake = makeFakePi();
		const ctx = fakeCtx(project, { hasUI: true, confirm: async () => false });
		await startSession(fake, project, ctx);
		const write = toolByName(fake, "write");
		const outside = path.join(home, "denied-ui.txt");

		await write.execute("call-1", { path: outside, content: "x\n" }, undefined, undefined);
		await turnEnd(fake, ctx);

		expect(existsSync(outside)).toBe(false);
		expect(fake.messages).toHaveLength(1);
		const { msg, opts } = fake.messages[0]!;
		expect(String(msg.content)).toContain("denied-ui.txt");
		expect(String(msg.content)).toContain("discarded");
		expect(msg.display).toBe(true);
		expect(opts?.deliverAs).toBe("steer");
	});

	it("sends the warning on headless deny too; sends nothing when approved", async () => {
		const fake = makeFakePi();
		const ctx = await startSession(fake, project); // headless, env unset → deny
		const write = toolByName(fake, "write");
		const outside = path.join(home, "denied-headless.txt");

		await write.execute("call-1", { path: outside, content: "x\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(fake.messages).toHaveLength(1);
		expect(String(fake.messages[0]!.msg.content)).toContain("denied-headless.txt");

		process.env.PI_OVERLAYFS_OUTSIDE_PROJECT = "approve";
		await write.execute("call-2", { path: outside, content: "y\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(readFileSync(outside, "utf8")).toBe("y\n");
		expect(fake.messages).toHaveLength(1); // no new warning
		// And inside-project auto-apply never warns either.
		const inside = path.join(project, "plain.txt");
		await write.execute("call-3", { path: inside, content: "z\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(fake.messages).toHaveLength(1);
	});

	it("H3: mapping works when the session cwd reaches us through a symlink", async () => {
		const link = path.join(tmpRoot, "cwd-link");
		await symlink(project, link, process.platform === "win32" ? "junction" : "dir");
		const fake = makeFakePi();
		const ctx = await startSession(fake, link);
		const write = toolByName(fake, "write");

		const viaLink = path.join(link, "linked.txt");
		await write.execute("call-1", { path: viaLink, content: "x\n" }, undefined, undefined);
		await turnEnd(fake, ctx);

		expect(readFileSync(path.join(project, "linked.txt"), "utf8")).toBe("x\n");
	});

	it("headless finisher drops outside-project changes unless PI_OVERLAYFS_OUTSIDE_PROJECT=approve", async () => {
		const fake = makeFakePi();
		const ctx = await startSession(fake, project);
		const write = toolByName(fake, "write");
		const outside = path.join(home, "outside.txt");

		await write.execute("call-1", { path: outside, content: "nope\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(existsSync(outside)).toBe(false);

		process.env.PI_OVERLAYFS_OUTSIDE_PROJECT = "approve";
		await write.execute("call-2", { path: outside, content: "yes\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(readFileSync(outside, "utf8")).toBe("yes\n");
	});

	it("with UI, the confirm dialog receives the outside paths and approval applies them", async () => {
		const asked: { title: string; message: string }[] = [];
		const fake = makeFakePi();
		const ctx = fakeCtx(project, {
			hasUI: true,
			confirm: async (title, message) => {
				asked.push({ title, message });
				return true;
			},
		});
		await startSession(fake, project, ctx);
		const write = toolByName(fake, "write");
		const outside = path.join(home, "asked.txt");

		await write.execute("call-1", { path: outside, content: "y\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(asked).toHaveLength(1);
		// Loose on presentation (that's a UI choice), strict on content: the
		// outside path AND its change code (git status --short vocabulary:
		// A/M/D) must reach the dialog — asked.txt is new, so "A".
		expect(asked[0]!.message).toContain("asked.txt");
		expect(asked[0]!.message).toMatch(/ A .*asked\.txt/);
		expect(readFileSync(outside, "utf8")).toBe("y\n");
	});
});

describe("project-outside-home topology (two real-layout mounts)", () => {
	it("project writes auto-apply; home writes prompt; notify lists both mounts", async () => {
		const standalone = path.join(tmpRoot, "standalone");
		await mkdir(standalone);
		const notifications: string[] = [];
		const asked: string[] = [];
		const fake = makeFakePi();
		const ctx = fakeCtx(standalone, {
			hasUI: true,
			notifications,
			confirm: async (_title, message) => {
				asked.push(message);
				return false;
			},
		});
		await startSession(fake, standalone, ctx);

		// Both mounts announced at session start (real-layout mount points).
		const vHome = virtualMountPointFor(canonicalizeHostPathFs(home));
		const vStandalone = virtualMountPointFor(canonicalizeHostPathFs(standalone));
		expect(notifications.some((n) => n.includes(vHome) && n.includes(vStandalone))).toBe(true);

		const write = toolByName(fake, "write");
		// Inside the project → auto-approved, no dialog.
		const insideFile = path.join(standalone, "in.txt");
		await write.execute("c1", { path: insideFile, content: "x\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(readFileSync(insideFile, "utf8")).toBe("x\n");
		expect(asked).toHaveLength(0);

		// Into home (outside project) → dialog; denied here.
		const homeFile = path.join(home, "out.txt");
		await write.execute("c2", { path: homeFile, content: "y\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("out.txt");
		expect(existsSync(homeFile)).toBe(false);
	});
});
