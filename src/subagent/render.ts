/**
 * TUI rendering for subagent tool calls and results.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, Markdown } from "@earendil-works/pi-tui";
import { formatUsage, spinnerFrame, truncate, TOOL_LINE_PREFIX } from "./tui.js";

// ---------------------------------------------------------------------------
// Compact preview component — delegates to Text.render(width) for wrapping
// ---------------------------------------------------------------------------

export class CompactPreview {
	private textComp: Text;
	private maxLines: number;

	constructor(text: string, maxLines: number = 5) {
		this.maxLines = maxLines;
		this.textComp = new Text(text, 0, 0);
	}

	render(width: number): string[] {
		const lines = this.textComp.render(width);
		if (lines.length === 0) return [];

		if (lines.length <= this.maxLines) return lines;

		return ["...", ...lines.slice(-this.maxLines)];
	}

	invalidate() {
		this.textComp.invalidate();
	}
}

// ---------------------------------------------------------------------------
// Call / result renderers shared by all subagent tools
// ---------------------------------------------------------------------------

export function renderSubagentCall(
	label: string,
	args: { task: string; hint?: string },
	theme: any,
) {
	const firstLine = args.task.split("\n")[0] ?? "";
	const combined = args.hint ? `${args.hint} | ${firstLine}` : firstLine;
	const preview = truncate(combined, 80);
	return new Text(
		`${theme.fg("toolTitle", theme.bold(label))}${theme.fg("dim", preview)}`,
		0, 0,
	);
}

export function renderSubagentResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: any },
	options: { expanded: boolean },
	theme: any,
	_context: { toolCallId: string },
) {
	const raw = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
	const output = raw.split("\n").map(l => l.startsWith(TOOL_LINE_PREFIX) ? theme.fg("muted", l) : l).join("\n");
	const container = new Container();

	if (!options.expanded) {
		const text = output || theme.fg("dim", "(no output)");
		const usage = result.details?.usage;
		const hint = ` · ${theme.fg("dim", "Ctrl+O to expand")}`;
		const status = usage ? formatUsage(usage, spinnerFrame) + hint : "";
		container.addChild(new CompactPreview(text));
		if (status) container.addChild(new Text(theme.fg("dim", status), 0, 0));
		return container;
	}

	const isFinal = !!result.details?.final;
	if (isFinal) {
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(raw, 0, 0, mdTheme));
	} else {
		container.addChild(new CompactPreview(output, 15));
	}
	if (result.details?.usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", formatUsage(result.details.usage, spinnerFrame)), 0, 0));
	}

	return container;
}
