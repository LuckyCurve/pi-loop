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
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** ANSI for a real arrow key, which `SelectList` reads through pi's keybinding parser. */
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";

export interface ScriptedUI {
	ui: ExtensionUIContext;
	/** Every dialog shown, in order, with the rows it rendered. */
	dialogs: { title: string; options: string[] }[];
	/** Notifications the extension produced, newest last. */
	notifications: { message: string; level: string }[];
	/** `setStatus` calls, in order (undefined = cleared). */
	statuses: (string | undefined)[];
	/** `setEditorText` calls, in order. */
	editorTexts: string[];
	/**
	 * Append answers: each dialog consumes one. A string names a row — exact label first, then a
	 * prefix (`"l1"`, `"禁用"`) — `undefined` closes the dialog like Esc.
	 */
	script(...answers: (string | undefined)[]): void;
	/** Dialog titles shown so far. */
	titles(): string[];
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

/** Minimal stand-in: components only call `requestRender`, which the fake has nothing to do. */
const TEST_TUI = { requestRender: () => undefined } as never;

export function scriptedUI(options: ScriptedUIOptions = {}): ScriptedUI {
	const answers: (string | undefined)[] = [];
	const dialogs: { title: string; options: string[] }[] = [];
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
			dialogs.push({ title, options: [...rows] });
			const answer = answers.shift();
			if (answer === undefined) return undefined;
			return pick(rows, answer);
		},
		custom: async (factory: (tui: never, theme: never, keybindings: never, done: (value: unknown) => void) => unknown) => {
			options.onDialog?.();
			const answer = answers.shift();
			if (answer === undefined) return undefined;

			let result: unknown;
			let settled = false;
			const done = (value: unknown) => {
				result = value;
				settled = true;
			};
			const component = (await factory(TEST_TUI, TEST_THEME, undefined as never, done)) as {
				render(width: number): string[];
				handleInput(data: string): void;
			};

			const lines = component.render(200).map((line) => line.trim());
			// Layout is: top border, title, rows…, hint, bottom border.
			// The selected row carries a cursor glyph; drop it so assertions read as the row itself.
			const rows = lines.slice(2, -2).map((row) => row.replace(/^[→›]\s+/, ""));
			dialogs.push({ title: lines[1] ?? "", options: rows });
			const index = rows.findIndex((row) => row.includes(answer));
			if (index === -1) {
				throw new Error(`no row in ${JSON.stringify(rows)} matched "${answer}"`);
			}
			for (let step = 0; step < index; step++) component.handleInput(KEY_DOWN);
			component.handleInput(KEY_ENTER);
			return settled ? result : undefined;
		},
	} as unknown as ExtensionUIContext;

	return {
		ui,
		dialogs,
		notifications,
		statuses,
		editorTexts,
		script: (...next) => {
			answers.push(...next);
		},
		titles: () => dialogs.map((dialog) => dialog.title),
		pendingAnswers: () => answers.length,
	};
}

/**
 * Remove one loop the way a user would: `/loop`, pick the loop, 删除.
 * Tests that only need a loop gone should use this rather than reaching into the engine, so the
 * panel stays exercised by everything that depends on it.
 */
export async function removeLoop(session: { prompt(text: string): Promise<unknown> }, ui: ScriptedUI, id: string): Promise<void> {
	ui.script(id, "删除");
	await session.prompt("/loop");
}

/** Disable one loop through the panel. */
export async function disableLoop(session: { prompt(text: string): Promise<unknown> }, ui: ScriptedUI, id: string): Promise<void> {
	ui.script(id, "禁用");
	await session.prompt("/loop");
}
