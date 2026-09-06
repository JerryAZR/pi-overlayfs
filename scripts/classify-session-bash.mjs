/**
 * Classify extracted session bash calls (bash-calls.json) through the fork's
 * static analyzer: which commands would run sandboxed vs fall back to native
 * under the extension's abortOnUnresolvedCommands policy.
 *
 * Usage: node scripts/classify-session-bash.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createAgentSandbox } from "@jerryan/just-bash";
import os from "node:os";

const calls = JSON.parse(readFileSync(new URL("../bash-calls.json", import.meta.url), "utf8"));

const sandbox = createAgentSandbox({ home: os.homedir(), project: process.cwd() });

const buckets = { sandboxed: [], native: [], parseError: [] };
const unresolvedNames = new Map();
const sandboxedNames = new Map();

for (const call of calls) {
	let analysis;
	try {
		analysis = await sandbox.analyzeCommands(call.command);
	} catch {
		buckets.parseError.push(call);
		continue;
	}
	if (analysis.unresolved.length === 0) {
		buckets.sandboxed.push({ ...call, commands: analysis.commands });
		for (const name of analysis.commands) sandboxedNames.set(name, (sandboxedNames.get(name) ?? 0) + 1);
	} else {
		buckets.native.push({ ...call, commands: analysis.commands, unresolved: analysis.unresolved });
		for (const name of analysis.unresolved) unresolvedNames.set(name, (unresolvedNames.get(name) ?? 0) + 1);
	}
}

const total = calls.length;
const pct = (n) => ((n / total) * 100).toFixed(1) + "%";
console.log(`total bash calls: ${total}`);
console.log(`sandbox-eligible: ${buckets.sandboxed.length} (${pct(buckets.sandboxed.length)})`);
console.log(`native fallback:  ${buckets.native.length} (${pct(buckets.native.length)})`);
console.log(`parse errors:     ${buckets.parseError.length} (${pct(buckets.parseError.length)})`);

const top = (map, n = 25) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log("\ntop unresolved names (drive native fallback):");
for (const [name, n] of top(unresolvedNames)) console.log(`  ${String(n).padStart(5)}  ${name}`);
console.log("\ntop command names in sandbox-eligible scripts:");
for (const [name, n] of top(sandboxedNames)) console.log(`  ${String(n).padStart(5)}  ${name}`);

writeFileSync(
	new URL("../bash-calls-classified.json", import.meta.url),
	JSON.stringify(
		{
			summary: {
				total,
				sandboxed: buckets.sandboxed.length,
				native: buckets.native.length,
				parseError: buckets.parseError.length,
			},
			unresolvedNames: Object.fromEntries([...unresolvedNames.entries()].sort((a, b) => b[1] - a[1])),
			buckets,
		},
		null,
		1,
	),
);
console.log("\nwrote bash-calls-classified.json");
