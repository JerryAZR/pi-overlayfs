/**
 * Tests for the delegate-child extension filter (agents.ts)
 *
 * The filter is the trust policy for delegate children that discover
 * extensions: it excludes project-local extensions in untrusted projects
 * (mirroring pi's trust model) and keeps everything else — including our
 * own package's extensions, which must load naturally in delegate children
 * (the recursion guard is excludeTools: ["delegate"], not discovery
 * filtering).
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { filterChildExtensions, registerAgentTools } from "./agents.js";

const CHILD_CWD = path.resolve("D:/some/project");

const ext = (path_: string, resolvedPath?: string) => ({ path: path_, resolvedPath });

const USER_EXT = ext("C:/Users/me/.pi/agent/extensions/checker.ts");
const USER_NPM_EXT = ext(
	"C:/Users/me/.pi/agent/npm/node_modules/@acme/pi-tools/index.ts",
);
const SELF_NPM = ext(
	"C:/Users/me/.pi/agent/npm/node_modules/pi-overlayfs/extensions/subagents.ts",
);
const PROJECT_EXT = ext(path.join(CHILD_CWD, ".pi", "extensions", "project-tool.ts"));
const INLINE_FACTORY = ext("<inline:some-extension>");

const ALL = [USER_EXT, USER_NPM_EXT, SELF_NPM, PROJECT_EXT, INLINE_FACTORY];

function filtered(projectTrusted: boolean) {
	return filterChildExtensions(ALL, {
		childCwd: CHILD_CWD,
		projectTrusted,
	});
}

describe("filterChildExtensions", () => {
	it("excludes project-local extensions when the project is untrusted", () => {
		expect(filtered(false)).not.toContain(PROJECT_EXT);
	});

	it("keeps project-local extensions when the project is trusted", () => {
		expect(filtered(true)).toContain(PROJECT_EXT);
	});

	it("always keeps user-global extensions, our own package, and inline factories", () => {
		for (const trusted of [true, false]) {
			const result = filtered(trusted);
			expect(result).toContain(USER_EXT);
			expect(result).toContain(USER_NPM_EXT);
			expect(result).toContain(SELF_NPM);
			expect(result).toContain(INLINE_FACTORY);
		}
	});

	it("matches on resolvedPath when path does not match", () => {
		const disguised = ext("extensions/whatever.ts", path.join(CHILD_CWD, ".pi", "extensions", "x.ts"));
		const result = filterChildExtensions([disguised], {
			childCwd: CHILD_CWD,
			projectTrusted: false,
		});
		expect(result.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Registration surface
// ---------------------------------------------------------------------------

describe("registered tool surface", () => {
	function fakePi() {
		const names: string[] = [];
		return {
			names,
			on() {},
			registerTool(tool: { name: string }) {
				names.push(tool.name);
			},
		};
	}
	const manager = {} as any;

	it("parent surface registers all four tools", () => {
		const pi = fakePi();
		registerAgentTools(pi as any, manager);
		expect(pi.names.sort()).toEqual(["delegate", "explore", "follow_up", "review"]);
	});
});
