/**
 * Tests for the subagent tool surface
 *
 * Validates:
 *   - Parameter schemas (including follow_up)
 *   - System prompt content
 *   - TUI helpers and preview component
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

import {
	ReviewParams,
	ExploreParams,
	DelegateParams,
	FollowUpParams,
} from "./agents.js";

describe("ReviewParams schema", () => {
	it("does not have cwd, readonly, or context parameters", () => {
		const keys = Object.keys(ReviewParams.properties);
		expect(keys.includes("cwd")).toBe(false);
		expect(keys.includes("readonly")).toBe(false);
		expect(keys.includes("context")).toBe(false);
	});

	it("accepts { task, skills }", () => {
		const errors = [
			...Value.Errors(ReviewParams, { task: "review auth.ts", skills: ["s"] }),
		];
		expect(errors.length).toBe(0);
	});

	it("rejects missing task", () => {
		const errors = [...Value.Errors(ReviewParams, {})];
		expect(errors.length).toBeGreaterThan(0);
	});
});

describe("ExploreParams schema", () => {
	it("rejects missing cwd", () => {
		const errors = [
			...Value.Errors(ExploreParams, { task: "explore this" }),
		];
		expect(errors.length).toBeGreaterThan(0);
	});

	it("accepts { task, cwd }", () => {
		const errors = [
			...Value.Errors(ExploreParams, {
				task: "map the structure",
				cwd: "/some/project",
			}),
		];
		expect(errors.length).toBe(0);
	});
});

describe("DelegateParams schema", () => {
	it("has optional cwd and skills", () => {
		const keys = Object.keys(DelegateParams.properties);
		expect(keys.includes("cwd")).toBe(true);
		expect(keys.includes("skills")).toBe(true);
	});

	it("does not have a context parameter (fresh in-process sessions only)", () => {
		const keys = Object.keys(DelegateParams.properties);
		expect(!keys.includes("context"), "context param was removed").toBe(true);
		expect(!keys.includes("readonly"), "readonly should not be on delegate").toBe(true);
	});

	it("accepts minimal { task }", () => {
		const errors = [...Value.Errors(DelegateParams, { task: "do something" })];
		expect(errors.length).toBe(0);
	});
});

describe("FollowUpParams schema", () => {
	it("has no cwd or skills (fixed at spawn)", () => {
		const keys = Object.keys(FollowUpParams.properties);
		expect(keys.sort()).toEqual(["agent", "task"]);
	});

	it("rejects missing agent", () => {
		const errors = [...Value.Errors(FollowUpParams, { task: "continue" })];
		expect(errors.length).toBeGreaterThan(0);
	});

	it("accepts { agent, task }", () => {
		const errors = [
			...Value.Errors(FollowUpParams, { agent: "delegate-1", task: "continue" }),
		];
		expect(errors.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "prompts");
const reviewPrompt = fs.readFileSync(path.join(promptsDir, "review.md"), "utf-8");
const explorePrompt = fs.readFileSync(path.join(promptsDir, "explore.md"), "utf-8");
const delegatePrompt = fs.readFileSync(path.join(promptsDir, "delegate.md"), "utf-8");

describe("System prompts", () => {
	it("review prompt mentions read-only constraint", () => {
		expect(reviewPrompt.includes("read-only")).toBe(true);
		expect(
			reviewPrompt.includes("Do not modify") ||
				reviewPrompt.includes("cannot modify") ||
				reviewPrompt.includes("cannot be modified") ||
				reviewPrompt.includes("cannot write"),
		).toBe(true);
	});

	it("explore prompt mentions read-only constraint", () => {
		expect(explorePrompt.includes("read-only")).toBe(true);
		expect(
			explorePrompt.includes("Do not modify") ||
				explorePrompt.includes("cannot modify") ||
				explorePrompt.includes("cannot be modified") ||
				explorePrompt.includes("cannot write"),
		).toBe(true);
	});

	it("delegate prompt tells the agent to do the work directly", () => {
		expect(delegatePrompt.includes("execute the assigned task")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// TUI helpers and preview component
// ---------------------------------------------------------------------------

import { shortenPath, formatDuration, formatTokens, formatUsage } from "./tui.js";
import { CompactPreview } from "./render.js";

// The real pi-tui Text right-pads rendered lines to the render width; the
// content assertions below don't care about the padding.
const renderTrimmed = (preview: CompactPreview, width: number) =>
	preview.render(width).map((l) => l.trimEnd());

describe("tui helpers", () => {
	it("shortenPath replaces home directory with ~", () => {
		const home = os.homedir();
		const result = shortenPath(path.join(home, "project", "src", "file.ts"));
		expect(result.startsWith("~")).toBe(true);
		expect(result.endsWith("file.ts")).toBe(true);
	});

	it("formatDuration formats milliseconds", () => {
		expect(formatDuration(500)).toBe("500ms");
		expect(formatDuration(2500)).toBe("2.5s");
		expect(formatDuration(65000).includes("m")).toBe(true);
	});

	it("formatTokens formats token counts", () => {
		expect(formatTokens(150)).toBe("150   ");
		expect(formatTokens(1500)).toBe("  1.5k");
		expect(formatTokens(15000)).toBe(" 15.0k");
		expect(formatTokens(1234567)).toBe("  1.2M");
	});

	it("CompactPreview shows full text when 5 or fewer lines", () => {
		const preview = new CompactPreview("one\ntwo\nthree");
		expect(renderTrimmed(preview, 80)).toEqual(["one", "two", "three"]);
	});

	it("CompactPreview truncates with ... when more than 5 visual lines", () => {
		const preview = new CompactPreview("1\n2\n3\n4\n5\n6\n7");
		expect(renderTrimmed(preview, 80)).toEqual(["...", "3", "4", "5", "6", "7"]);
	});

	it("CompactPreview wraps long lines at render width", () => {
		const preview = new CompactPreview("A".repeat(160));
		const lines = preview.render(40);
		expect(lines.length).toBe(4);
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
	});

	it("CompactPreview wraps and truncates long text", () => {
		const text = Array(7).fill("short").join("\n") + "\n" + "X".repeat(200);
		const preview = new CompactPreview(text);
		const lines = renderTrimmed(preview, 40);
		expect(lines[0] === "...").toBe(true);
		expect(lines.length).toBe(6);
	});

	it("CompactPreview handles exactly maxLines boundary", () => {
		const preview = new CompactPreview("1\n2\n3\n4\n5");
		expect(renderTrimmed(preview, 80)).toEqual(["1", "2", "3", "4", "5"]);
	});

	it("CompactPreview handles empty text", () => {
		const preview = new CompactPreview("");
		// Real pi-tui renders an empty Text as zero lines.
		expect(renderTrimmed(preview, 80)).toEqual([]);
	});

	it("CompactPreview honors custom maxLines", () => {
		const preview = new CompactPreview("1\n2\n3\n4\n5\n6\n7", 3);
		expect(renderTrimmed(preview, 80)).toEqual(["...", "5", "6", "7"]);
	});

	it("formatUsage produces expected status line", () => {
		const spin = () => "⠏";
		const result = formatUsage({ turns: 3, input: 1500, output: 800, durationMs: 5200 }, spin);
		expect(result.includes("Turn 3")).toBe(true);
		expect(result.includes("  1.5k")).toBe(true);
		expect(result.includes("800")).toBe(true);
	});
});
