/**
 * Spawn-configuration contract tests: what defaultSpawnSession actually
 * hands to createAgentSession per role.
 *
 * The spawnSession test seam used by agents.test.ts bypasses
 * defaultSpawnSession entirely, so a regression in the role wiring — e.g.
 * "write" joining the reader allowlist — would slip past the whole suite.
 * That matters because the allowlist is the boundary keeping pi's NATIVE
 * write/edit tools out of read-only children: EROFS enforces bash/python,
 * but the native write tool would bypass the sandbox entirely.
 *
 * This file mocks the SDK, spawns through the real AgentManager without a
 * spawnSession seam, and captures the createAgentSession options.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: { sessionOptions?: any; loaderOptions?: any }[] = [];

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		createAgentSession: vi.fn(async (options: any) => {
			captured.push({ sessionOptions: options });
			const messages: any[] = [];
			return {
				session: {
					messages,
					subscribe: () => () => {},
					async bindExtensions() {},
					async prompt(task: string) {
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: `done: ${task}` }],
							stopReason: "stop",
							usage: { input: 1, output: 1, totalTokens: 2 },
						});
					},
					async abort() {},
					getContextUsage: () => undefined,
					async compact() {},
					dispose() {},
				},
			};
		}),
		DefaultResourceLoader: class {
			constructor(options: any) {
				captured.push({ loaderOptions: options });
			}
			async reload() {}
		},
		getAgentDir: () => "C:\\fake-agent-dir",
		ModelRuntime: { create: async () => ({}) },
		SessionManager: { inMemory: () => ({ kind: "in-memory" }) },
		SettingsManager: { create: () => ({}) },
	};
});

import { AgentManager } from "./agents.js";

const fakeCtx: any = {
	cwd: process.cwd(),
	ui: undefined,
	model: undefined,
	thinkingLevel: "off",
	isProjectTrusted: () => false,
};

async function spawnRole(role: "delegate" | "review" | "explore") {
	const manager = new AgentManager({ runtime: async () => ({}) as any });
	await manager.spawn({ role, task: "t", cwd: process.cwd(), ctx: fakeCtx });
	const entry = captured.find((c) => c.sessionOptions);
	const loader = captured.find((c) => c.loaderOptions);
	if (!entry?.sessionOptions || !loader?.loaderOptions) throw new Error("spawn did not reach the SDK");
	return { options: entry.sessionOptions, loader: loader.loaderOptions };
}

beforeEach(() => {
	captured.length = 0;
});

describe("reader roles (review, explore)", () => {
	it("get exactly the read-only allowlist — native write/edit stay out", async () => {
		for (const role of ["review", "explore"] as const) {
			const { options, loader } = await spawnRole(role);
			expect(options.tools, role).toEqual(["read", "bash", "python"]);
			expect(options.tools, role).not.toContain("write");
			expect(options.tools, role).not.toContain("edit");
			// The sandboxed customs shadow the builtin bash/python.
			expect(
				options.customTools.map((t: any) => t.name).sort(),
				role,
			).toEqual(["bash", "python", "read"]);
			// No extensions, in-memory session.
			expect(loader.noExtensions, role).toBe(true);
			expect(loader.extensionsOverride, role).toBeUndefined();
			expect(options.sessionManager, role).toEqual({ kind: "in-memory" });
		}
	});
});

describe("delegate role", () => {
	it("gets no allowlist, no customs, the recursion guard, and filtered extension discovery", async () => {
		const { options, loader } = await spawnRole("delegate");
		expect(options.tools).toBeUndefined();
		expect(options.customTools).toBeUndefined();
		expect(options.excludeTools).toContain("delegate");
		expect(loader.noExtensions).toBe(false);
		expect(typeof loader.extensionsOverride).toBe("function");
	});
});
