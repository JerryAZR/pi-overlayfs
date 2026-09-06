import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index.js";

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

function fakeCtx(cwd: string, opts: { hasUI?: boolean; confirm?: () => Promise<boolean>; notifications?: string[] } = {}) {
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

	it("write tool stages via overlay; tool_result finisher auto-applies inside-project changes", async () => {
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

	it("finisher runs at turn_end: staged changes from the batch are applied", async () => {
		const fake = makeFakePi();
		const ctx = await startSession(fake, project);
		const write = toolByName(fake, "write");

		const target = path.join(project, "via-read.txt");
		await write.execute("call-1", { path: target, content: "x\n" }, undefined, undefined);
		expect(existsSync(target)).toBe(false);

		await turnEnd(fake, ctx);
		expect(readFileSync(target, "utf8")).toBe("x\n");
	});

	it("finisher also runs on turns whose tool calls were aborted (toolResults empty)", async () => {
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

	it("with UI, the confirm dialog lists outside paths and approval applies them", async () => {
		const asked: string[][] = [];
		const fake = makeFakePi();
		const ctx = fakeCtx(project, {
			hasUI: true,
			confirm: async () => {
				asked.push([]);
				return true;
			},
		});
		await startSession(fake, project, ctx);
		const write = toolByName(fake, "write");
		const outside = path.join(home, "asked.txt");

		await write.execute("call-1", { path: outside, content: "y\n" }, undefined, undefined);
		await turnEnd(fake, ctx);
		expect(asked).toHaveLength(1);
		expect(readFileSync(outside, "utf8")).toBe("y\n");
	});
});
