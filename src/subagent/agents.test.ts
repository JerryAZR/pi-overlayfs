/**
 * Tests for the agent manager (agents.ts)
 *
 * Validates:
 *   - Id issuance (sequential per role, monotonic)
 *   - Spawn result formatting (agent id footer)
 *   - CWD validation
 *   - Follow-up routing and unknown-id errors (with live agent list)
 *   - Follow-up compaction: threshold, ordering, benign vs real failures
 *   - Turn-based protection sweep (idle-only cleanup)
 *   - Abort and error propagation
 *   - disposeAll on shutdown
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { AgentManager, PROTECTION_TURNS } from "./agents.js";

// ---------------------------------------------------------------------------
// Fake session
// ---------------------------------------------------------------------------

function fakeSession(behavior: {
	respondText?: string;
	stopReason?: string;
	errorMessage?: string;
	hang?: boolean;
	/** Context usage percent. null → unknown (percent: null); omitted → low default. */
	contextPercent?: number | null;
	/** When set, compact() throws Error(compactError). */
	compactError?: string;
	/** When true, getContextUsage() returns undefined (no usage yet). */
	noUsage?: boolean;
} = {}) {
	const session: any = {
		messages: [] as any[],
		isStreaming: false,
		disposed: false,
		abortCalls: 0,
		prompts: [] as string[],
		compactCalls: 0,
		events: [] as string[],
		_listener: undefined as any,
		subscribe(listener: any) {
			this._listener = listener;
			return () => {};
		},
		async prompt(task: string) {
			this.prompts.push(task);
			this.events.push(`prompt:${task}`);
			if (behavior.hang) {
				// Signal that the run has started, then wait for abort().
				this._started?.();
				await new Promise<void>((resolve) => {
					this._resolveHang = resolve;
				});
				this.messages.push({
					role: "assistant",
					content: [],
					stopReason: "aborted",
				});
				return;
			}
			if (behavior.stopReason === "error") {
				this.messages.push({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: behavior.errorMessage ?? "boom",
				});
				return;
			}
			this.messages.push({
				role: "assistant",
				content: [{ type: "text", text: behavior.respondText ?? `done: ${task}` }],
				stopReason: "stop",
				usage: { input: 10, output: 5, totalTokens: 15 },
			});
		},
		getContextUsage() {
			if (behavior.noUsage) return undefined;
			if (behavior.contextPercent === null) {
				return { tokens: null, contextWindow: 100000, percent: null };
			}
			const percent = behavior.contextPercent ?? 1;
			return { tokens: percent * 1000, contextWindow: 100000, percent };
		},
		async compact() {
			this.compactCalls++;
			this.events.push("compact");
			if (behavior.compactError) throw new Error(behavior.compactError);
		},
		async abort() {
			this.abortCalls++;
			this._resolveHang?.();
		},
		dispose() {
			this.disposed = true;
		},
		async bindExtensions() {},
	};
	return session;
}

const fakeCtx: any = {
	cwd: os.tmpdir(),
	ui: undefined,
	model: undefined,
	thinkingLevel: "off",
};

function createManager(sessions: any[] = []) {
	const created: any[] = sessions;
	const manager = new AgentManager({
		spawnSession: async ({ id }: any) => {
			const session = created.length > 0 ? created.shift() : fakeSession();
			session._id = id;
			return session;
		},
	});
	return manager;
}

function text(result: any): string {
	return result.content.map((c: any) => c.text).join("");
}

// ---------------------------------------------------------------------------
// Spawn and ids
// ---------------------------------------------------------------------------

describe("spawn", () => {
	it("issues sequential ids per role", async () => {
		const manager = createManager();

		const r1 = await manager.spawn({ role: "delegate", task: "a", cwd: os.tmpdir(), ctx: fakeCtx });
		const r2 = await manager.spawn({ role: "delegate", task: "b", cwd: os.tmpdir(), ctx: fakeCtx });
		const r3 = await manager.spawn({ role: "review", task: "c", cwd: os.tmpdir(), ctx: fakeCtx });

		expect(text(r1)).toContain("agent: delegate-1");
		expect(text(r2)).toContain("agent: delegate-2");
		expect(text(r3)).toContain("agent: review-1");
		expect(manager.liveIds()).toEqual(["delegate-1", "delegate-2", "review-1"]);
	});

	it("appends the agent id footer to the output", async () => {
		const manager = createManager([fakeSession({ respondText: "all good" })]);
		const result = await manager.spawn({ role: "delegate", task: "x", cwd: os.tmpdir(), ctx: fakeCtx });

		expect(text(result)).toBe("all good\n\n---\nagent: delegate-1");
	});

	it("rejects a nonexistent cwd before creating a session", async () => {
		let spawnCalled = false;
		const manager = new AgentManager({
			spawnSession: async () => {
				spawnCalled = true;
				return fakeSession();
			},
		});

		await expect(
			manager.spawn({
				role: "delegate",
				task: "x",
				cwd: "/definitely/does/not/exist",
				ctx: fakeCtx,
			}),
		).rejects.toThrow(/does not exist/);
		expect(spawnCalled).toBe(false);
		expect(manager.liveIds()).toEqual([]);
	});

	it("rejects a cwd that exists but is not a directory", async () => {
		// Regression: the old implementation threw "not a directory" inside a
		// try whose own catch re-wrapped it, producing the misleading claim
		// that the (existing) path "does not exist or is not accessible".
		const file = path.join(os.tmpdir(), `pi-subagent-cwd-${process.pid}`);
		fs.writeFileSync(file, "x");
		try {
			const manager = createManager();
			let message = "";
			try {
				await manager.spawn({ role: "delegate", task: "x", cwd: file, ctx: fakeCtx });
			} catch (err: any) {
				message = err.message;
			}
			expect(message).toContain("is not a directory");
			expect(
				message.includes("does not exist"),
				`message must not claim an existing path does not exist: ${message}`,
			).toBe(false);
		} finally {
			fs.unlinkSync(file);
		}
	});

	it("throws when session creation fails", async () => {
		const manager = new AgentManager({
			spawnSession: async () => {
				throw new Error("no auth");
			},
		});

		await expect(
			manager.spawn({ role: "delegate", task: "x", cwd: os.tmpdir(), ctx: fakeCtx }),
		).rejects.toThrow(/Failed to start subagent: no auth/);
		expect(manager.liveIds()).toEqual([]);
	});

	it("surfaces assistant error stops as thrown errors", async () => {
		const manager = createManager([fakeSession({ stopReason: "error", errorMessage: "overloaded" })]);

		await expect(
			manager.spawn({ role: "delegate", task: "x", cwd: os.tmpdir(), ctx: fakeCtx }),
		).rejects.toThrow(/Subagent failed: overloaded/);
		// The agent is still registered — follow_up is the recovery path.
		expect(manager.liveIds()).toEqual(["delegate-1"]);
	});
});

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------

describe("followUp", () => {
	it("continues the same session with the new task", async () => {
		const session = fakeSession();
		const manager = createManager([session]);

		await manager.spawn({ role: "delegate", task: "first", cwd: os.tmpdir(), ctx: fakeCtx });
		const result = await manager.followUp({ agent: "delegate-1", task: "second" });

		expect(session.prompts).toEqual(["first", "second"]);
		expect(text(result)).toContain("agent: delegate-1");
	});

	it("errors loudly on unknown ids and lists live agents", async () => {
		const manager = createManager();
		await manager.spawn({ role: "delegate", task: "x", cwd: os.tmpdir(), ctx: fakeCtx });
		await manager.spawn({ role: "review", task: "y", cwd: os.tmpdir(), ctx: fakeCtx });

		await expect(manager.followUp({ agent: "delegate-9", task: "hello?" })).rejects.toThrow(
			/"delegate-9" not found.*delegate-1.*review-1/s,
		);
	});

	it("reports when no agents are live", async () => {
		const manager = createManager();
		await expect(manager.followUp({ agent: "delegate-1", task: "hi" })).rejects.toThrow(
			/No live agents/,
		);
	});
});

// ---------------------------------------------------------------------------
// Follow-up compaction
// ---------------------------------------------------------------------------

describe("follow-up compaction", () => {
	const spawnFirst = (manager: AgentManager, session: any) =>
		manager.spawn({ role: "delegate", task: "first", cwd: os.tmpdir(), ctx: fakeCtx })
			.then(() => session);

	it("does not compact at or below the threshold", async () => {
		for (const contextPercent of [1, 49, 50]) {
			const session = fakeSession({ contextPercent });
			const manager = createManager([session]);
			await spawnFirst(manager, session);
			await manager.followUp({ agent: "delegate-1", task: "second" });
			expect(session.compactCalls, `contextPercent=${contextPercent}`).toBe(0);
		}
	});

	it("compacts above the threshold, before the follow-up prompt", async () => {
		const session = fakeSession({ contextPercent: 51 });
		const manager = createManager([session]);
		await spawnFirst(manager, session);
		await manager.followUp({ agent: "delegate-1", task: "second" });
		expect(session.compactCalls).toBe(1);
		expect(session.events).toEqual(["prompt:first", "compact", "prompt:second"]);
	});

	it("skips compaction when usage is unknown (percent null or missing)", async () => {
		for (const behavior of [{ contextPercent: null }, { noUsage: true }] as const) {
			const session = fakeSession(behavior as any);
			const manager = createManager([session]);
			await spawnFirst(manager, session);
			await manager.followUp({ agent: "delegate-1", task: "second" });
			expect(session.compactCalls, JSON.stringify(behavior)).toBe(0);
		}
	});

	it("proceeds without compaction on benign compact failures", async () => {
		const benign = [
			"Already compacted",
			"Nothing to compact (session too small)",
			"Compaction cancelled",
			"Summarization failed: generation hit the token cap and the summary is incomplete",
		];
		for (const compactError of benign) {
			const session = fakeSession({ contextPercent: 90, compactError });
			const manager = createManager([session]);
			await spawnFirst(manager, session);
			const result = await manager.followUp({ agent: "delegate-1", task: "second" });
			expect(session.compactCalls, compactError).toBe(1);
			expect(session.prompts, compactError).toEqual(["first", "second"]);
			expect(text(result), compactError).toContain("done: second");
		}
	});

	it("fails loudly on real compaction failures and never prompts", async () => {
		const session = fakeSession({ contextPercent: 90, compactError: "429 Too Many Requests" });
		const manager = createManager([session]);
		await spawnFirst(manager, session);
		await expect(manager.followUp({ agent: "delegate-1", task: "second" })).rejects.toThrow(
			/Follow-up compaction failed: 429 Too Many Requests/,
		);
		expect(session.prompts).toEqual(["first"]);
	});

	it("skips compaction when the call is already aborted", async () => {
		const session = fakeSession({ contextPercent: 90 });
		const manager = createManager([session]);
		await spawnFirst(manager, session);
		const controller = new AbortController();
		controller.abort();
		await expect(
			manager.followUp({ agent: "delegate-1", task: "second", signal: controller.signal }),
		).rejects.toThrow(/Subagent was aborted/);
		expect(session.compactCalls).toBe(0);
		expect(session.prompts).toEqual(["first"]);
	});

	it("a failed compaction still refreshes the protection clock", async () => {
		const session = fakeSession({ contextPercent: 90, compactError: "429 Too Many Requests" });
		const manager = createManager([session]);
		await spawnFirst(manager, session);
		await expect(manager.followUp({ agent: "delegate-1", task: "second" })).rejects.toThrow();
		for (let i = 0; i < PROTECTION_TURNS; i++) manager.noteTurnEnd();
		expect(
			manager.liveIds(),
			"agent stays registered and follow-up-able after a failed compaction",
		).toEqual(["delegate-1"]);
	});

	it("never compacts a fresh spawn, whatever the usage", async () => {
		const session = fakeSession({ contextPercent: 95 });
		const manager = createManager([session]);
		await spawnFirst(manager, session);
		expect(session.compactCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Turn-based protection sweep
// ---------------------------------------------------------------------------

describe("protection sweep", () => {
	it("disposes agents idle for more than PROTECTION_TURNS turns", async () => {
		const old = fakeSession();
		const manager = createManager([old]);
		await manager.spawn({ role: "delegate", task: "x", cwd: os.tmpdir(), ctx: fakeCtx });

		for (let i = 0; i < PROTECTION_TURNS; i++) manager.noteTurnEnd();
		expect(manager.liveIds(), "still protected at exactly N turns").toEqual(["delegate-1"]);

		manager.noteTurnEnd();
		expect(manager.liveIds(), "evicted after N+1 idle turns").toEqual([]);
		expect(old.disposed).toBe(true);
	});

	it("a follow-up resets the protection clock", async () => {
		const manager = createManager();
		await manager.spawn({ role: "delegate", task: "x", cwd: os.tmpdir(), ctx: fakeCtx });

		for (let i = 0; i < PROTECTION_TURNS; i++) manager.noteTurnEnd();
		await manager.followUp({ agent: "delegate-1", task: "again" });

		for (let i = 0; i < PROTECTION_TURNS; i++) manager.noteTurnEnd();
		expect(manager.liveIds(), "follow-up refreshed protection").toEqual(["delegate-1"]);
	});

	it("keeps any number of recently-active agents (no count cap)", async () => {
		const manager = createManager();
		for (let i = 0; i < 25; i++) {
			await manager.spawn({ role: "delegate", task: `t${i}`, cwd: os.tmpdir(), ctx: fakeCtx });
		}
		manager.noteTurnEnd();
		expect(manager.liveIds().length, "all recently active agents survive").toBe(25);
	});

	it("never disposes a streaming agent", async () => {
		const streaming = fakeSession();
		streaming.isStreaming = true;
		const manager = createManager([streaming]);
		await manager.spawn({ role: "delegate", task: "x", cwd: os.tmpdir(), ctx: fakeCtx });

		for (let i = 0; i < PROTECTION_TURNS + 5; i++) manager.noteTurnEnd();
		expect(manager.liveIds()).toEqual(["delegate-1"]);
		expect(streaming.disposed).toBe(false);
	});

	it("disposeAll removes every agent", async () => {
		const sessions = [fakeSession(), fakeSession(), fakeSession()];
		const manager = createManager(sessions);
		await manager.spawn({ role: "delegate", task: "a", cwd: os.tmpdir(), ctx: fakeCtx });
		await manager.spawn({ role: "review", task: "b", cwd: os.tmpdir(), ctx: fakeCtx });
		await manager.spawn({ role: "explore", task: "c", cwd: os.tmpdir(), ctx: fakeCtx });

		manager.disposeAll();

		expect(manager.liveIds()).toEqual([]);
		expect(sessions.every((s) => s.disposed)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe("abort", () => {
	it("throws immediately when the signal is already aborted", async () => {
		const manager = createManager();
		const controller = new AbortController();
		controller.abort();

		await expect(
			manager.spawn({
				role: "delegate",
				task: "x",
				cwd: os.tmpdir(),
				ctx: fakeCtx,
				signal: controller.signal,
			}),
		).rejects.toThrow(/aborted/);
	});

	it("aborts a running session when the signal fires", async () => {
		const session = fakeSession({ hang: true });
		const manager = createManager([session]);
		const controller = new AbortController();

		const pending = manager.spawn({
			role: "delegate",
			task: "x",
			cwd: os.tmpdir(),
			ctx: fakeCtx,
			signal: controller.signal,
		});
		// Wait until the session's prompt is actually running, then abort.
		await new Promise<void>((resolve) => {
			session._started = resolve;
		});
		controller.abort();
		expect(session.abortCalls).toBe(1);
		await expect(pending).rejects.toThrow(/aborted/);
	});
});
