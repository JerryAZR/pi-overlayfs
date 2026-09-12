/**
 * pi-subagents — in-process subagent delegation for pi.
 *
 * Registers four tools for the "agent as project manager" workflow:
 *   delegate  — General-purpose worker with full tool access
 *   review    — Read-only code review in the current project
 *   explore   — Read-only exploration of external projects (requires cwd)
 *   follow_up — Continue an existing subagent's session with full context
 *
 * Thin extension entry; the implementation lives in src/subagent/.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentManager, registerAgentTools } from "../src/subagent/agents.js";

export default function (pi: ExtensionAPI) {
	registerAgentTools(pi, new AgentManager());
}
