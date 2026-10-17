/**
 * The one `ctx.ui` used by every test that needs a dialog.
 *
 * `/loop` renders its panel through `ctx.ui.custom()` in interactive mode and falls back to
 * `ctx.ui.select()` elsewhere, so the fake has to serve both. Rather than special-casing either,
 * `custom()` builds the extension's real component and drives it with the same key presses a user
 * would send — a scripted answer names a row, and the component is moved to it and confirmed. That
 * keeps the selection path under test instead of stubbing it out.
 *
 * One shared implementation also means the fake-API tests and the real-runtime tests exercise the
 * same UI contract. They used to drift apart, each with its own bespoke stub.
 */
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

// pi's key-hint helpers read the active theme, which the CLI normally initializes before any
// extension runs. Tests drive sessions directly, so they initialize it here.
initTheme("dark", false);

/** ANSI for a real arrow key, which `SelectList` reads through pi's keybinding parser. */
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";

/** Safety stop for the cursor walk: a dialog with more rows than this is a bug in the test. */
const MAX_ITEMS = 64;

export interface ScriptedUI {
	ui: ExtensionUIContext;
	/** Every dialog shown, in order: its caption, everything the box showed, and its rows. */
	dialogs: { title: string; body: string[]; rows: string[] }[];
	/**
	 * How each `custom()` dialog was presented. The panel is a centered overlay, not a selector in
	 * the editor slot, and that is easy to lose silently — nothing about the rows would change.
	 */
	presentation: { overlay: boolean; anchor: string | undefined }[];
	/** Notifications the extension produced, newest last. */
	notifications: { message: string; level: string }[];
	/** `setStatus` calls, in order (undefined = cleared). */
	statuses: (string | undefined)[];
	/** `setEditorText` calls, in order. */
	editorTexts: string[];
	/** Every `tui.requestRender()` a component asked for, i.e. a repaint of a live dialog. */
	repaints: number[];
	/**
	 * Append answers: each dialog consumes one. A string names a row — exact label first, then a
	 * prefix (`"l1"`, `"Disable"`) — `undefined` closes the dialog like Esc.
	 */
	script(...answers: (string | undefined)[]): void;
	/** Dialog titles shown so far. */
	titles(): string[];
	/**
	 * Runs while a `custom()` dialog is open, before the scripted answer is applied. Lets a test act
	 * mid-dialog, e.g. tear the session down while the panel is on screen.
	 */
	onDialogOpen?: (component: unknown) => void | Promise<void>;
	/** Whether a queued answer is still waiting, i.e. the extension opened fewer dialogs than scripted. */
	pendingAnswers(): number;
}

export interface ScriptedUIOptions {
	/** Extra hook for `notify`, e.g. to simulate a stale context that throws. */
	onNotify?: (message: string, level: string) => void;
	/** Thrown from `select`/`custom`, e.g. to simulate a dialog that cannot open. */
	onDialog?: () => void;
}

const TEST_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

/**
 * Minimal stand-in for the terminal: components call `requestRender` (recorded) and read the size.
 * 40 rows is a normal terminal, so the panel is not height-constrained unless a test says so.
 */

/** Every repaint requested by a live dialog, so a leak after teardown is observable. */
const repaints: number[] = [];

const testTui = () => ({ requestRender: () => repaints.push(Date.now()), terminal: { rows: 40, cols: 120 } }) as never;

export function scriptedUI(options: ScriptedUIOptions = {}): ScriptedUI {
	const answers: (string | undefined)[] = [];
	const dialogs: { title: string; body: string[]; rows: string[] }[] = [];
	const presentation: { overlay: boolean; anchor: string | undefined }[] = [];
	const notifications: { message: string; level: string }[] = [];
	const statuses: (string | undefined)[] = [];
	const editorTexts: string[] = [];

	/** Match like a user reading the row: exact label, then prefix. */
	function pick(options: readonly string[], answer: string): string | undefined {
		return options.find((option) => option === answer || option.includes(answer));
	}

	const ui = {
		notify: (message: string, level?: string) => {
			const resolved = level ?? "info";
			notifications.push({ message, level: resolved });
			options.onNotify?.(message, resolved);
		},
		setStatus: (_key: string, text: string | undefined) => {
			statuses.push(text);
		},
		setEditorText: (text: string) => {
			editorTexts.push(text);
		},
		select: async (title: string, rows: string[]) => {
			options.onDialog?.();
			// The `select` fallback is one line per row, so body and rows are the same thing there.
			dialogs.push({ title, body: [...rows], rows: [...rows] });
			// The `select` fallback is the non-TUI path; it has no overlay to configure.
			presentation.push({ overlay: false, anchor: undefined });
			const answer = answers.shift();
			if (answer === undefined) return undefined;
			return pick(rows, answer);
		},
		custom: async (
			factory: (tui: never, theme: never, keybindings: never, done: (value: unknown) => void) => unknown,
			dialogOptions?: {
				overlay?: boolean;
				// pi accepts a static object or a function it re-evaluates per render (for resizes).
				overlayOptions?: { anchor?: string } | (() => { anchor?: string }),
			},
		) => {
			options.onDialog?.();
			const raw = dialogOptions?.overlayOptions;
			presentation.push({
				overlay: dialogOptions?.overlay === true,
				anchor: (typeof raw === "function" ? raw() : raw)?.anchor,
			});
			const answer = answers.shift();
			if (answer === undefined) return undefined;

			let result: unknown;
			let settled = false;
			const done = (value: unknown) => {
				result = value;
				settled = true;
			};
			const component = (await factory(testTui(), TEST_THEME, undefined as never, done)) as {
				render(width: number): string[];
				handleInput(data: string): void;
				dispose?(): void;
			};
			await scripted.onDialogOpen?.(component);

			const inner = component.render(200).map((line) => line.trim());
			// `panel-view.test.ts` pins the box layout, so a change there fails there first.
			const strip = (line: string): string =>
				line
					.replace(/^│\s*/, "")
					.replace(/[│\s]+$/, "");
			// The caption sits inside the top border: `╭─ Loops (1) ─╮`.
			const title = strip(inner[0] ?? "")
				.replace(/^[╭─\s]+/, "")
				.replace(/[╮─\s]+$/, "");
			// Everything the box shows, so a test can assert what a user would read.
			const body = inner.slice(1, -1).map(strip);

			// Walk the cursor through the list rather than assuming one line per row: rows now carry a
			// wrapped detail block, and the cursor is what actually moves. Re-renders each time, since
			// the cursor position lives in the component.
			const cursorRow = (): string | undefined => {
				for (const line of component.render(200)) {
					const content = strip(line.trim());
					if (content.startsWith("→ ")) return content.replace(/^→\s+/, "");
				}
				return undefined;
			};
			const rows: string[] = [];
			for (let step = 0; step < MAX_ITEMS; step++) {
				const label = cursorRow();
				if (label === undefined || rows.includes(label)) break;
				rows.push(label);
				component.handleInput(KEY_DOWN);
			}
			dialogs.push({ title, body, rows });

			let found = cursorRow()?.includes(answer) === true;
			for (let step = 0; step < MAX_ITEMS && !found; step++) {
				component.handleInput(KEY_DOWN);
				found = cursorRow()?.includes(answer) === true;
			}
			if (!found) throw new Error(`no row among ${JSON.stringify(rows)} matched "${answer}"`);
			component.handleInput(KEY_ENTER);
			// pi calls this when the dialog closes; the panel clears its repaint timer there.
			component.dispose?.();
			return settled ? result : undefined;
		},
	} as unknown as ExtensionUIContext;

	// Assembled last so `custom` can read `onDialogOpen`, which a test may set at any time.
	const scripted = {
		ui,
		dialogs,
		presentation,
		notifications,
		statuses,
		editorTexts,
		repaints,
		script: (...next: (string | undefined)[]) => {
			answers.push(...next);
		},
		titles: () => dialogs.map((dialog) => dialog.title),
		pendingAnswers: () => answers.length,
	} as ScriptedUI;
	return scripted;
}

/**
 * Remove one loop the way a user would: `/loop`, pick the loop, Remove.
 * Tests that only need a loop gone should use this rather than reaching into the engine, so the
 * panel stays exercised by everything that depends on it.
 */
export async function removeLoop(session: { prompt(text: string): Promise<unknown> }, ui: ScriptedUI, id: string): Promise<void> {
	ui.script(`Task ${id.slice(1)}`, "Remove");
	await session.prompt("/loop");
}

/** Disable one loop through the panel. */
export async function disableLoop(session: { prompt(text: string): Promise<unknown> }, ui: ScriptedUI, id: string): Promise<void> {
	ui.script(`Task ${id.slice(1)}`, "Disable");
	await session.prompt("/loop");
}
