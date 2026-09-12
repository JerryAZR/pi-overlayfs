/**
 * Agent manager — in-process subagent sessions with follow-up support.
 *
 * Each subagent is an AgentSession created via the pi SDK, running in the
 * parent's process. Sessions are in-memory (SessionManager.inMemory) — no
 * backing files, the in-process equivalent of --no-session.
 *
 * Lifetime
 * ────────
 * Agents live in a registry keyed by id ("delegate-1", "review-2", ...).
 * Cleanup is recency-based, not count-based:
 *
 *   - The owning session's turn counter advances on every turn_end.
 *   - An agent records lastActiveTurn at spawn and when each run completes.
 *   - A sweep at turn_end disposes agents idle for more than
 *     PROTECTION_TURNS turns. There is no cap — any number of recently
 *     active agents survive.
 *   - Running agents (session.isStreaming) are never disposed. With
 *     turn-scoped execution this is structural — a turn cannot end while
 *     its tool calls are still running — but the guard also covers a
 *     future background mode.
 *   - All agents are disposed when the owning session shuts down.
 *
 * Recursion
 * ─────────
 * Structural, not env-based. Review/explore children are created with
 * noExtensions: true — they get exactly the tools injected here (read +
 * sandboxed bash/python) and are leaves. Delegate children discover
 * user/project extensions like a fresh pi, minus project-local extensions
 * in untrusted projects (the trust policy) — our own package's extensions
 * load naturally: the overlayfs extension provides their fs isolation, and
 * this extension provides review/explore/follow_up for grandchildren. The
 * recursion guard is the delegate child's excludeTools: ["delegate"] — a
 * denylist over all tool sources, so no delegate tool exists below the
 * parent. Each session level's own extension instance cleans up via its
 * own session_shutdown; there is no cross-level ownership cascade.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type TObject } from "typebox";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	CONFIG_DIR_NAME,
	type AgentSession,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createUIBridge } from "./ui-bridge.js";
import { createReadOnlySandboxTools } from "./sandbox-bash.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import { shortenPath, truncate, TOOL_LINE_PREFIX, type UsageStats } from "./tui.js";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(EXTENSION_DIR, "prompts");

// ---------------------------------------------------------------------------
// Roles — everything that distinguishes delegate/review/explore children
// ---------------------------------------------------------------------------

export type AgentRole = "delegate" | "review" | "explore";

/**
 * Tool allowlist for read-only child roles. "bash"/"python" here denote the
 * sandboxed fail-closed tools injected via customTools (custom tools shadow
 * builtins of the same name).
 */
export const READONLY_TOOLS = ["read", "bash", "python"];

interface RoleConfig {
	promptFile: string;
	/** Built-in tool allowlist. Undefined = pi defaults (full access). */
	tools?: string[];
	/** Tool denylist over all tool sources (applies after `tools`). */
	excludeTools?: string[];
	/**
	 * Whether children of this role get the sandboxed read-only bash/python
	 * tools (built per child against the child's cwd).
	 */
	sandboxTools: boolean;
	/**
	 * Whether the child discovers and loads user/project extensions like a
	 * fresh pi would. True for delegate (a worker needs the parent's full
	 * environment — tools, guards); false for read-only leaf agents (minimal
	 * surface is the point).
	 */
	discoverExtensions: boolean;
}

const ROLES: Record<AgentRole, RoleConfig> = {
	delegate: {
		promptFile: path.join(PROMPTS_DIR, "delegate.md"),
		// The recursion guard: no delegate tool below the parent, whatever
		// source (built-in, custom, or extension-registered) would provide it.
		excludeTools: ["delegate"],
		sandboxTools: false,
		discoverExtensions: true,
	},
	review: {
		promptFile: path.join(PROMPTS_DIR, "review.md"),
		tools: READONLY_TOOLS,
		sandboxTools: true,
		discoverExtensions: false,
	},
	explore: {
		promptFile: path.join(PROMPTS_DIR, "explore.md"),
		tools: READONLY_TOOLS,
		sandboxTools: true,
		discoverExtensions: false,
	},
};

/** Agents idle for more than this many owning-session turns are disposed. */
export const PROTECTION_TURNS = 10;

/**
 * A follow-up agent's context is compacted before the new task when usage
 * exceeds this percent. Model capability degrades well before the context
 * window is full, and compacting between tasks (a natural pause point)
 * beats the SDK's mid-run auto-compaction. Tests assert the literal
 * boundary (50/51) — the threshold is the contract.
 */
const COMPACT_ABOVE_PERCENT = 50;

/**
 * session.compact() failures where proceeding without compaction is correct.
 * Matched against error message text — the only signal compact() gives:
 *   - "Already compacted" / "Nothing to compact" — the session has nothing
 *     left to cut by its own policy; running uncompacted is exactly right.
 *   - "Compaction cancelled" — an extension hook (delegate children only)
 *     decided against compaction; respect that decision.
 *   - "generation hit the token cap and the summary is incomplete" — a
 *     quality guard refused to persist a partial summary; rare, and the
 *     follow-up itself is unaffected.
 * Everything else (rate limits, auth, network, no model) is a real failure:
 * the follow-up fails loudly so the parent retries — proceeding would run
 * uncompacted, and a transient error (e.g. a 429 that lifts by the next
 * call) would silently defeat the policy.
 */
function isBenignCompactionFailure(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		msg.includes("Already compacted") ||
		msg.includes("Nothing to compact") ||
		msg.includes("Compaction cancelled") ||
		msg.includes("generation hit the token cap and the summary is incomplete")
	);
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const TaskParam = Type.String({
	description: "Task to delegate to the subagent",
});

const SkillsParam = Type.Optional(
	Type.Array(Type.String(), {
		description: "Optional startup skills to load (paths, like --skill)",
	}),
);

const CwdParam = Type.Optional(
	Type.String({
		description:
			"Working directory for the subagent. Defaults to the parent's cwd.",
	}),
);

export const ReviewParams = Type.Object({
	task: TaskParam,
	skills: SkillsParam,
});

export const ExploreParams = Type.Object({
	task: TaskParam,
	cwd: Type.String({
		description:
			"Working directory for the explorer.",
	}),
	skills: SkillsParam,
});

export const DelegateParams = Type.Object({
	task: TaskParam,
	cwd: CwdParam,
	skills: SkillsParam,
});

export const FollowUpParams = Type.Object({
	agent: Type.String({
		description:
			'Agent id from a previous subagent tool result (e.g. "delegate-1").',
	}),
	task: Type.String({
		description: "Follow-up task or question for the agent",
	}),
});

/** Shared shape of all spawn-tool parameters (each schema is a subset). */
interface SpawnToolParams {
	task: string;
	cwd?: string;
	skills?: string[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentEntry {
	id: string;
	session: AgentSession;
	bridge: ProgressBridge;
	lastActiveTurn: number;
}

export interface SpawnAgentOptions {
	role: AgentRole;
	task: string;
	cwd: string;
	skills?: string[];
	ctx: ExtensionContext;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<any>) => void;
}

/**
 * Everything needed to create a child session. One named type shared by the
 * production default and the test seam — with two separate signatures the
 * two sides could drift apart; with one params type, drift is a compile
 * error.
 */
export interface SpawnSessionParams {
	opts: SpawnAgentOptions;
	id: string;
	runtime: () => Promise<ModelRuntime>;
}

export interface FollowUpOptions {
	agent: string;
	task: string;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<any>) => void;
}

export interface AgentManagerDeps {
	/** Shared model runtime. Defaults to a process-wide lazy singleton. */
	runtime?: () => Promise<ModelRuntime>;
	/** Test seam: override session creation. */
	spawnSession?: (params: SpawnSessionParams) => Promise<AgentSession>;
}

let sharedRuntime: Promise<ModelRuntime> | undefined;

function defaultRuntime(): Promise<ModelRuntime> {
	if (!sharedRuntime) sharedRuntime = ModelRuntime.create();
	return sharedRuntime;
}

// ---------------------------------------------------------------------------
// Throttle (leading + trailing)
// ---------------------------------------------------------------------------

function createThrottle(fn: () => void, interval: number) {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	return {
		trigger() {
			const now = Date.now();
			if (now - last >= interval) {
				last = now;
				fn();
			} else if (!timer) {
				timer = setTimeout(() => {
					timer = null;
					last = Date.now();
					fn();
				}, interval - (now - last));
			}
		},
		cancel() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Progress bridge — translates session events into tool progress updates
// ---------------------------------------------------------------------------

const MAX_PREV_LINES = 20;
const UPDATE_INTERVAL = 200;

export class ProgressBridge {
	private previousTurnsText = "";
	private streamText = "";
	private turnCount = 0;
	private tokens = { input: 0, output: 0 };
	private startTime = Date.now();
	private onUpdate?: (result: AgentToolResult<any>) => void;
	private throttle = createThrottle(() => this.doUpdate(), UPDATE_INTERVAL);

	reset(onUpdate?: (result: AgentToolResult<any>) => void) {
		this.throttle.cancel();
		this.previousTurnsText = "";
		this.streamText = "";
		this.turnCount = 0;
		this.tokens = { input: 0, output: 0 };
		this.startTime = Date.now();
		this.onUpdate = onUpdate;
	}

	usage(): UsageStats {
		return {
			turns: this.turnCount,
			input: this.tokens.input,
			output: this.tokens.output,
			durationMs: Date.now() - this.startTime,
		};
	}

	private displayText() {
		return (
			this.previousTurnsText +
			(this.previousTurnsText && this.streamText ? "\n" : "") +
			this.streamText
		);
	}

	private pushPrev(text: string) {
		if (!text) return;
		this.previousTurnsText = this.previousTurnsText
			? this.previousTurnsText + "\n" + text
			: text;
		const lines = this.previousTurnsText.split("\n");
		if (lines.length > MAX_PREV_LINES) {
			this.previousTurnsText = lines.slice(-MAX_PREV_LINES).join("\n");
		}
	}

	private doUpdate() {
		if (!this.onUpdate) return;
		this.onUpdate({
			content: [{ type: "text", text: this.displayText() }],
			details: { usage: this.usage() },
		});
	}

	/** Feed a session event. */
	handle(event: any) {
		if (event.type === "message_update" && event.assistantMessageEvent) {
			const delta = event.assistantMessageEvent;
			if (delta.type === "text_delta" || delta.type === "thinking_delta") {
				this.streamText += delta.delta;
				this.throttle.trigger();
			}
			return;
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			if (msg.role !== "assistant") return;
			this.turnCount++;
			if (msg.usage) {
				this.tokens.input += msg.usage.input || 0;
				this.tokens.output += msg.usage.output || 0;
			}
			this.pushPrev(this.streamText);
			this.streamText = "";
			this.throttle.trigger();
			return;
		}

		if (event.type === "tool_execution_start") {
			this.pushPrev(formatToolCallLine(event.toolName, event.args));
			this.throttle.trigger();
		}
	}
}

/** One-line summary of a tool call: "▸ name k=v k=v", capped at 80 chars. */
function formatToolCallLine(name: string, args: unknown): string {
	const parts = [`${TOOL_LINE_PREFIX} ${name}`];
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const entries = Object.entries(args);
		const capPerParam = entries.length > 1;
		for (const [k, v] of entries) {
			const val = typeof v === "string" ? v : JSON.stringify(v);
			parts.push(`${k}=${capPerParam ? truncate(val, 40) : val}`);
		}
	}
	return truncate(parts.join(" "), 80);
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

function extractResult(messages: Array<any>): { output: string; isError: boolean } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		if (msg.stopReason === "error") {
			return {
				output: `Subagent failed: ${msg.errorMessage || "unknown error"}`,
				isError: true,
			};
		}
		if (msg.stopReason === "aborted") {
			return { output: "Subagent was aborted", isError: true };
		}
		const text = (msg.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");
		if (text) return { output: text, isError: false };
	}
	return { output: "(no output)", isError: false };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Shared pre-flight abort guard (followUp: pre-compaction; run: pre-prompt). */
function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) fail("Subagent was aborted");
}

function fail(text: string): never {
	throw new Error(text);
}

function assertCwd(cwd: string | undefined): asserts cwd is string {
	if (!cwd) fail("Cannot spawn subagent: cwd is required.");
	let stat: fs.Stats;
	try {
		stat = fs.statSync(cwd);
	} catch (err: any) {
		fail(
			`Cannot spawn subagent: cwd "${cwd}" does not exist or is not accessible (${err.message}).`,
		);
	}
	if (!stat.isDirectory()) {
		fail(`Cannot spawn subagent: "${cwd}" is not a directory.`);
	}
}

// ---------------------------------------------------------------------------
// Agent manager
// ---------------------------------------------------------------------------

export class AgentManager {
	private entries = new Map<string, AgentEntry>();
	private counters = new Map<string, number>();
	private turn = 0;
	private runtime: () => Promise<ModelRuntime>;
	private spawnSession?: AgentManagerDeps["spawnSession"];

	constructor(deps: AgentManagerDeps = {}) {
		this.runtime = deps.runtime ?? defaultRuntime;
		this.spawnSession = deps.spawnSession;
	}

	/** Ids of live agents, in spawn order. */
	liveIds(): string[] {
		return [...this.entries.keys()];
	}

	/** Advance the owning session's turn counter and sweep stale agents. */
	noteTurnEnd() {
		this.turn++;
		for (const [id, entry] of this.entries) {
			if (entry.session.isStreaming) continue;
			if (this.turn - entry.lastActiveTurn > PROTECTION_TURNS) {
				this.disposeEntry(id, entry);
			}
		}
	}

	/** Dispose all agents (owning session shutdown/replacement). */
	disposeAll() {
		for (const [id, entry] of this.entries) {
			this.disposeEntry(id, entry);
		}
	}

	private disposeEntry(id: string, entry: AgentEntry) {
		this.entries.delete(id);
		try {
			entry.session.dispose();
		} catch {
			// Dispose is best-effort cleanup; a broken session must not jam the sweep.
		}
	}

	// -------------------------------------------------------------------------
	// Spawn
	// -------------------------------------------------------------------------

	async spawn(opts: SpawnAgentOptions): Promise<AgentToolResult<any>> {
		assertCwd(opts.cwd);

		const next = (this.counters.get(opts.role) ?? 0) + 1;
		this.counters.set(opts.role, next);
		const id = `${opts.role}-${next}`;

		let session: AgentSession;
		try {
			session = await (this.spawnSession ?? defaultSpawnSession)({
				opts,
				id,
				runtime: this.runtime,
			});
		} catch (err: any) {
			fail(`Failed to start subagent: ${err.message || String(err)}`);
		}

		const entry: AgentEntry = {
			id,
			session,
			bridge: new ProgressBridge(),
			lastActiveTurn: this.turn,
		};
		session.subscribe((event) => entry.bridge.handle(event));
		this.entries.set(id, entry);

		return this.run(entry, opts.task, opts.signal, opts.onUpdate);
	}

	// -------------------------------------------------------------------------
	// Follow-up
	// -------------------------------------------------------------------------

	async followUp(opts: FollowUpOptions): Promise<AgentToolResult<any>> {
		const entry = this.entries.get(opts.agent);
		if (!entry) {
			const live = this.liveIds();
			const hint = live.length > 0 ? ` Live agents: ${live.join(", ")}.` : " No live agents.";
			fail(
				`Agent "${opts.agent}" not found (expired or never existed).${hint} Spawn a fresh agent instead.`,
			);
		}
		assertNotAborted(opts.signal);
		await this.compactIfNeeded(entry);
		return this.run(entry, opts.task, opts.signal, opts.onUpdate);
	}

	/**
	 * Compact the agent's context before a follow-up when usage is high —
	 * between tasks, where losing history costs nothing and the child starts
	 * the new task with full capability. Fresh spawns are never compacted
	 * (their context is empty by construction).
	 */
	private async compactIfNeeded(entry: AgentEntry): Promise<void> {
		// Compaction is engagement: protect the agent from a mid-compaction sweep.
		entry.lastActiveTurn = this.turn;
		const percent = entry.session.getContextUsage()?.percent;
		if (percent === null || percent === undefined) return;
		if (percent <= COMPACT_ABOVE_PERCENT) return;
		try {
			await entry.session.compact();
		} catch (err: any) {
			if (!isBenignCompactionFailure(err)) {
				fail(`Follow-up compaction failed: ${err.message || String(err)}`);
			}
			// Benign failure: nothing to compact by the session's own policy, or
			// compaction was refused — proceed with the follow-up as-is.
		}
	}

	// -------------------------------------------------------------------------
	// Run one prompt against an agent's session
	// -------------------------------------------------------------------------

	private async run(
		entry: AgentEntry,
		task: string,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult<any>) => void) | undefined,
	): Promise<AgentToolResult<any>> {
		// Any engagement — even an aborted or failed run — marks the agent active.
		entry.lastActiveTurn = this.turn;
		entry.bridge.reset(onUpdate);

		const onAbort = () => {
			void entry.session.abort();
		};
		assertNotAborted(signal);
		if (signal) signal.addEventListener("abort", onAbort, { once: true });

		try {
			await entry.session.prompt(task, { expandPromptTemplates: false });
		} catch (err: any) {
			fail(`Subagent failed: ${err.message || String(err)}`);
		} finally {
			if (signal) signal.removeEventListener("abort", onAbort);
		}

		const { output, isError } = extractResult(entry.session.messages as any[]);
		const text = `${output}\n\n---\nagent: ${entry.id}`;
		if (isError) fail(text);
		return {
			content: [{ type: "text" as const, text }],
			details: { usage: entry.bridge.usage(), final: true },
		};
	}
}

// ---------------------------------------------------------------------------
// Extension discovery filter (delegate children)
// ---------------------------------------------------------------------------

export interface ChildExtensionFilterOptions {
	/** The child session's working directory. */
	childCwd: string;
	/** Whether the parent session treats its project as trusted. */
	projectTrusted: boolean;
}

/**
 * Filter the discovered extension set for a delegate child session.
 * Pure and exported for tests.
 *
 * One exclusion: project-local extensions when the project is untrusted —
 * mirrors pi's trust model, which the raw SDK path does not enforce. Our own
 * package's extensions are deliberately KEPT: the overlayfs extension
 * provides the child's fs isolation and this extension provides
 * review/explore/follow_up for grandchildren (delegate itself is denied via
 * excludeTools — that, not discovery filtering, is the recursion guard).
 */
export function filterChildExtensions<T extends { path: string; resolvedPath?: string }>(
	extensions: T[],
	opts: ChildExtensionFilterOptions,
): T[] {
	if (opts.projectTrusted) return extensions;
	const projectExtDir = path.resolve(opts.childCwd, CONFIG_DIR_NAME);
	return extensions.filter((ext) => {
		for (const p of [ext.path, ext.resolvedPath]) {
			if (!p) continue;
			// Skip pseudo-paths (e.g. "<inline:name>") — they are not filesystem
			// locations and must not be resolved against directory prefixes.
			if (p.startsWith("<")) continue;
			const resolved = path.resolve(p);
			if (resolved === projectExtDir || resolved.startsWith(projectExtDir + path.sep)) {
				return false;
			}
		}
		return true;
	});
}

// ---------------------------------------------------------------------------
// Default session creation (the in-process equivalent of buildSpawnArgs)
// ---------------------------------------------------------------------------

async function defaultSpawnSession(
	params: SpawnSessionParams,
): Promise<AgentSession> {
	const { opts, id, runtime } = params;
	const modelRuntime = await runtime();
	const role = ROLES[opts.role];
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(opts.cwd, agentDir, {
		projectTrusted: opts.ctx.isProjectTrusted(),
	});

	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		settingsManager,
		noExtensions: !role.discoverExtensions,
		extensionsOverride: role.discoverExtensions
			? (base) => ({
					...base,
					extensions: filterChildExtensions(base.extensions, {
						childCwd: opts.cwd,
						projectTrusted: opts.ctx.isProjectTrusted(),
					}),
				})
			: undefined,
		additionalSkillPaths: opts.skills ?? [],
		appendSystemPrompt: [role.promptFile],
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model: opts.ctx.model,
		thinkingLevel: opts.ctx.thinkingLevel,
		modelRuntime,
		tools: role.tools ? [...role.tools] : undefined,
		excludeTools: role.excludeTools,
		customTools: role.sandboxTools ? createReadOnlySandboxTools({ cwd: opts.cwd }) : undefined,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
	});

	await session.bindExtensions({
		uiContext: createUIBridge(opts.ctx.ui, { label: id }),
		mode: "rpc",
	});

	return session;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

interface SpawnToolConfig {
	role: AgentRole;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: TObject<any>;
	resolveCwd: (params: SpawnToolParams, ctx: ExtensionContext) => string;
	hint?: (params: SpawnToolParams) => string | undefined;
}

const DELEGATE_TOOL: SpawnToolConfig = {
	role: "delegate",
	label: "Delegate",
	description:
		"Delegate a task to a subagent. " +
		"For general-purpose work that needs full agent capabilities.",
	promptSnippet: "Delegate a task to a worker subagent",
	promptGuidelines: [
		"Use the delegate tool to let subagents take over lengthy yet self-contained and well-defined tasks, " +
		"so you can focus on the big picture without being buried inside implementation details.",
	],
	parameters: DelegateParams,
	resolveCwd: (params, ctx) => params.cwd ?? ctx.cwd,
	hint: (params) => (params.cwd ? shortenPath(params.cwd) : undefined),
};

const REVIEW_TOOL: SpawnToolConfig = {
	role: "review",
	label: "Review",
	description:
		"Review code changes or files in the current project with a read-only subagent.",
	promptSnippet: "Review code or files with a read-only subagent",
	promptGuidelines: [
		"Use the review tool for code review, diff inspection, and quality checks.",
	],
	parameters: ReviewParams,
	resolveCwd: (_params, ctx) => ctx.cwd,
};

const EXPLORE_TOOL: SpawnToolConfig = {
	role: "explore",
	label: "Explore",
	description:
		"Explore a project directory with a read-only subagent to understand its structure, patterns, and key files.",
	promptSnippet: "Explore a project directory with a read-only subagent",
	promptGuidelines: [
		"Use the explore tool to map unfamiliar codebases or scout dependencies.",
	],
	parameters: ExploreParams,
	resolveCwd: (params) => params.cwd!,
	hint: (params) => shortenPath(params.cwd!),
};

/** Build a spawn tool's definition; everything is derived from the role config except `execute`. */
function spawnToolDefinition(
	config: SpawnToolConfig,
	execute: (
		params: SpawnToolParams,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult<any>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<any>>,
) {
	return {
		name: config.role,
		label: config.label,
		description: config.description,
		promptSnippet: config.promptSnippet,
		promptGuidelines: config.promptGuidelines,
		parameters: config.parameters,
		execute: (
			_toolCallId: string,
			params: SpawnToolParams,
			signal: AbortSignal | undefined,
			onUpdate: ((result: AgentToolResult<any>) => void) | undefined,
			ctx: ExtensionContext,
		) => execute(params, signal, onUpdate, ctx),
		renderCall: (args: SpawnToolParams, theme: any) =>
			renderSubagentCall(
				`${config.role} `,
				{ task: args.task, hint: config.hint?.(args) },
				theme,
			),
		renderResult: (result: any, options: any, theme: any, context: any) =>
			renderSubagentResult(result, options, theme, context),
	};
}

function registerSpawnTool(
	pi: ExtensionAPI,
	manager: AgentManager,
	config: SpawnToolConfig,
): void {
	pi.registerTool(
		spawnToolDefinition(config, (params, signal, onUpdate, ctx) =>
			manager.spawn({
				role: config.role,
				task: params.task,
				cwd: config.resolveCwd(params, ctx),
				skills: params.skills,
				ctx,
				signal,
				onUpdate,
			}),
		) as any,
	);
}

function registerFollowUpTool(pi: ExtensionAPI, manager: AgentManager): void {
	pi.registerTool({
		name: "follow_up",
		label: "Follow Up",
		description:
			"Send a follow-up task to a previously spawned subagent, continuing its session with full context.",
		promptSnippet: "Continue working with an existing subagent",
		promptGuidelines: [
			"Use follow_up to refine a subagent's work, ask questions about its findings, or recover from an incomplete or failed result — the agent keeps its full context.",
		],
		parameters: FollowUpParams,
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			return manager.followUp({
				agent: params.agent,
				task: params.task,
				signal,
				onUpdate,
			});
		},
		renderCall: (args, theme) =>
			renderSubagentCall("follow_up ", { task: args.task, hint: args.agent }, theme),
		renderResult: (result, options, theme, context) =>
			renderSubagentResult(result as any, options, theme, context),
	});
}


function wireLifecycle(pi: ExtensionAPI, manager: AgentManager): void {
	pi.on("turn_end", () => manager.noteTurnEnd());
	pi.on("session_shutdown", () => manager.disposeAll());
}

/** Full tool surface for the parent session. */
export function registerAgentTools(pi: ExtensionAPI, manager: AgentManager): void {
	wireLifecycle(pi, manager);
	registerSpawnTool(pi, manager, DELEGATE_TOOL);
	registerSpawnTool(pi, manager, REVIEW_TOOL);
	registerSpawnTool(pi, manager, EXPLORE_TOOL);
	registerFollowUpTool(pi, manager);
}
