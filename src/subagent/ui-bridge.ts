/**
 * UI bridge — presents an ExtensionUIContext to an in-process subagent
 * session that forwards interactive prompts to the parent session's TUI.
 *
 * Usage:
 *   const bridge = createUIBridge(ctx.ui, { label: "delegate" });
 *   await childSession.bindExtensions({ uiContext: bridge, mode: "rpc" });
 *
 * Mode is "rpc" (not "tui") because the bridge deliberately mirrors the
 * documented RPC degradation contract: dialogs work, terminal chrome does
 * not. Extensions running in the child should not assume direct TUI access.
 *
 * Method mapping
 * ──────────────
 * Dialogs (serialized through a shared queue, title prefixed with label):
 *   select, confirm, input, editor, custom
 *   Dialog opts (signal, timeout) pass through unchanged, so the child can
 *   abort-dismiss and auto-dismiss exactly as documented.
 *   Known edge: the process-wide queue has no per-agent cancellation — an
 *   agent disposed while its dialog is still pending leaves that dialog
 *   blocking later subagent dialogs until the user answers it.
 *
 * Fire-and-forget (forwarded):
 *   notify        — message prefixed with [label]
 *   setStatus     — key namespaced as "<label>:<key>"
 *   setWidget     — key namespaced; string arrays and component factories
 *                   both forwarded (factories are valid in-process)
 *
 * Fire-and-forget (dropped — they would hijack the parent's chrome):
 *   setTitle, setWorkingMessage, setWorkingVisible, setWorkingIndicator,
 *   setHiddenThinkingLabel, onTerminalInput, pasteToEditor, setEditorText,
 *   setEditorComponent, setFooter, setHeader, addAutocompleteProvider,
 *   setToolsExpanded
 *
 * Reads:
 *   theme, getAllThemes, getTheme — read-through to the parent
 *   getToolsExpanded              — read-through
 *   getEditorText, getEditorComponent — return "" / undefined
 *
 * Writes blocked:
 *   setTheme — returns { success: false, error }
 */

import type {
	ExtensionUIContext,
	ExtensionWidgetOptions,
	Theme,
} from "@earendil-works/pi-coding-agent";

export interface UIBridgeOptions {
	/**
	 * Short name identifying the subagent (e.g. "delegate", "review").
	 * Used to prefix dialog titles and notifications, and to namespace
	 * status/widget keys so concurrent subagents don't clobber each other.
	 */
	label: string;
}

// ---------------------------------------------------------------------------
// Dialog serialization
//
// The parent TUI can only show one modal at a time. Multiple subagents may
// request dialogs concurrently (parallel tool calls), so all dialog methods
// across ALL bridge instances funnel through one process-wide queue.
// ---------------------------------------------------------------------------

let dialogQueue: Promise<unknown> = Promise.resolve();

function enqueueDialog<T>(fn: () => Promise<T>): Promise<T> {
	const result = dialogQueue.then(fn, fn);
	// Keep the queue alive even if fn rejects.
	dialogQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/** Test hook: reset the dialog queue. Not part of the public API. */
export function _resetDialogQueue(): void {
	dialogQueue = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

export function createUIBridge(
	parent: ExtensionUIContext,
	options: UIBridgeOptions,
): ExtensionUIContext {
	const { label } = options;
	const tag = `[${label}]`;
	const titled = (title: string) => `${tag} ${title}`;
	const keyed = (key: string) => `${label}:${key}`;

	const noop = () => {};
	const noopUnsubscribe = () => noop;

	const bridge: ExtensionUIContext = {
		// --- Dialogs (serialized, forwarded) ----------------------------------

		select(title, options_, opts) {
			return enqueueDialog(() => parent.select(titled(title), options_, opts));
		},

		confirm(title, message, opts) {
			return enqueueDialog(() => parent.confirm(titled(title), message, opts));
		},

		input(title, placeholder, opts) {
			return enqueueDialog(() => parent.input(titled(title), placeholder, opts));
		},

		editor(title, prefill) {
			return enqueueDialog(() => parent.editor(titled(title), prefill));
		},

		// Contextually typed against the generic interface signature; the
		// explicit <T> is inferred from the ExtensionUIContext annotation.
		custom(factory, customOptions) {
			// In-process the factory executes against the parent's real TUI, so
			// custom components work — unlike RPC mode, which degrades to undefined.
			return enqueueDialog(() => parent.custom(factory, customOptions));
		},

		// --- Fire-and-forget (forwarded) ---------------------------------------

		notify(message, type) {
			parent.notify(`${tag} ${message}`, type);
		},

		setStatus(key, text) {
			parent.setStatus(keyed(key), text);
		},

		setWidget(
			key: string,
			content: string[] | ((...args: any[]) => any) | undefined,
			widgetOptions?: ExtensionWidgetOptions,
		) {
			parent.setWidget(keyed(key), content as any, widgetOptions);
		},

		// --- Fire-and-forget (dropped) ------------------------------------------
		// These manipulate the parent session's chrome (terminal title, streaming
		// indicator, editor, footer/header). A subagent has no business touching
		// them. Mirrors the RPC-mode degradation contract.

		setTitle: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		pasteToEditor: noop,
		setEditorText: noop,
		setEditorComponent: noop,
		setFooter: noop,
		setHeader: noop,
		addAutocompleteProvider: noop,
		setToolsExpanded: noop,
		onTerminalInput: noopUnsubscribe,

		// --- Reads ---------------------------------------------------------------

		get theme(): Theme {
			return parent.theme;
		},

		getAllThemes() {
			return parent.getAllThemes();
		},

		getTheme(name) {
			return parent.getTheme(name);
		},

		getToolsExpanded() {
			return parent.getToolsExpanded();
		},

		getEditorText() {
			return "";
		},

		getEditorComponent() {
			return undefined;
		},

		// --- Writes blocked -------------------------------------------------------

		setTheme() {
			return {
				success: false,
				error: "Subagents cannot change the parent session's theme.",
			};
		},
	};

	return bridge;
}
