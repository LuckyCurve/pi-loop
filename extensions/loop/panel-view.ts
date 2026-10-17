/**
 * The panel component: a bordered box that repaints its own countdown.
 *
 * Two things here are not visible in the rows themselves:
 *
 * 1. **It is a box, not just a list.** `ctx.ui.custom({ overlay: true })` composites over the
 *    transcript, so a bare list has no edge and blends into whatever is behind it. The frame plus
 *    full-width padding is what makes the overlay opaque.
 * 2. **It repaints on a timer.** Rows carry a countdown, and pi only repaints on input and events,
 *    so without a tick the countdown would freeze at whatever it read when the panel opened.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	SelectList,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayOptions,
} from "@earendil-works/pi-tui";
import type { Clock } from "../../src/clock.ts";
import { CLOSE_VALUE, noLoopsMessage, type PanelOption } from "../../src/panel.ts";

/** One second, so the countdown moves like a clock rather than jumping in chunks. */
export const PANEL_REFRESH_MS = 1_000;

/** How many rows the box shows before it scrolls, on a terminal tall enough to want more. */
const MAX_VISIBLE_ROWS = 12;

/** Lines the box spends on its own chrome: top border, key hints, bottom border. */
const CHROME_LINES = 3;

/**
 * Geometry of the overlay, in one place: the options the overlay is opened with and the row budget
 * below must agree, or the box grows past the height the overlay allows and pi clips its bottom
 * border off.
 */
export const PANEL_OVERLAY = {
	heightFraction: 0.8,
	margin: 1,
	width: 80,
} as const;

export function panelOverlayOptions(): OverlayOptions {
	const maxHeight = `${PANEL_OVERLAY.heightFraction * 100}%` as const;
	return { anchor: "center", width: PANEL_OVERLAY.width, maxHeight, margin: PANEL_OVERLAY.margin };
}

/**
 * Lines the whole box may occupy, mirroring how pi clamps an overlay's `maxHeight`: a fraction of
 * the terminal, then never more than the space left after the margins.
 */
export function panelLineBudget(terminalRows: number): number {
	const available = Math.max(1, terminalRows - PANEL_OVERLAY.margin * 2);
	return Math.max(1, Math.min(Math.floor(terminalRows * PANEL_OVERLAY.heightFraction), available));
}

export interface PanelViewInput {
	theme: Theme;
	clock: Clock;
	/** Rows to show. Called on every render, so the countdown is never stale. */
	load: () => readonly PanelOption[];
	/** Box caption, also re-read on render because the loop count can change. */
	title: () => string;
	/** Key hints, already themed. Composed by the caller, which has pi's keybinding labels. */
	hint: string;
	/** Repaint cadence. 0 keeps a static box, for a dialog whose rows cannot change. */
	refreshMs?: number;
	/**
	 * Lines the box may occupy, read on every render so a resize is respected. Rows beyond what the
	 * box can show scroll, and the rows it shows are reduced to keep the borders on screen.
	 */
	maxLines: () => number;
	/** The repaint trigger, i.e. `tui.requestRender`. */
	requestRender: () => void;
	onSelect: (value: string) => void;
	onCancel: () => void;
}

/** A `Component` whose members are all required, so callers do not have to null-check them. */
export interface PanelView extends Component {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	dispose(): void;
}

export function createPanelView(input: PanelViewInput): PanelView {
	const theme = input.theme;
	const refreshMs = input.refreshMs ?? PANEL_REFRESH_MS;
	let timer: unknown;
	let disposed = false;

	/**
	 * Rows the box can show: what the height allows, minus its own chrome — and minus one more line
	 * once the list scrolls, because `SelectList` spends a line on its `(3/12)` indicator.
	 */
	function visibleRows(itemCount: number): number {
		const budget = Math.max(1, Math.floor(input.maxLines()));
		const room = Math.max(1, Math.min(MAX_VISIBLE_ROWS, budget - CHROME_LINES));
		return itemCount > room ? Math.max(1, room - 1) : room;
	}

	function build(rows: readonly PanelOption[], keepValue: string | undefined): SelectList {
		const items = rows.map((row) => ({ value: row.value, label: row.label, description: row.description }));
		const list = new SelectList(items, visibleRows(items.length), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => input.onSelect(item.value);
		list.onCancel = () => input.onCancel();
		// Rebuilding must not move the cursor: the countdown text changes every second, so the rows
		// are rebuilt on every render, and the user would otherwise be yanked back to the top.
		const index = items.findIndex((item) => item.value === keepValue);
		if (index > 0) list.setSelectedIndex(index);
		return list;
	}

	/** Rows for this render, falling back to a notice: a loop can expire while the box is open. */
	function rows(): readonly PanelOption[] {
		const loaded = input.load();
		if (loaded.length > 0) return loaded;
		return [{ value: CLOSE_VALUE, label: noLoopsMessage(), description: "", action: { kind: "close" } }];
	}

	function arm(): void {
		if (disposed || refreshMs <= 0) return;
		timer = input.clock.setTimer(() => {
			timer = undefined;
			if (disposed) return;
			input.requestRender();
			arm();
		}, refreshMs);
	}

	let list = build(rows(), undefined);
	arm();

	return {
		render(width: number): string[] {
			list = build(rows(), list.getSelectedItem()?.value);
			const inner = Math.max(1, width - 2);
			const body = list.render(inner);
			return frame([...body, input.hint], width, input.title(), theme);
		},
		invalidate(): void {
			list.invalidate();
		},
		handleInput(data: string): void {
			list.handleInput(data);
		},
		dispose(): void {
			disposed = true;
			if (timer === undefined) return;
			input.clock.clearTimer(timer);
			timer = undefined;
		},
	};
}

/** Truncate to `width` display columns and pad to it, so the box is opaque edge to edge. */
function fit(line: string, width: number): string {
	return truncateToWidth(line, width, "…", true);
}

/**
 * `╭─ title ─╮` / `│ row │` / `╰───╯`. Every line is padded to the full width so the overlay
 * overwrites what is behind it instead of letting it show through the edges.
 */
function frame(lines: readonly string[], width: number, title: string, theme: Theme): string[] {
	const inner = Math.max(1, width - 2);
	const label = theme.bold(truncateToWidth(` ${title} `, inner, "…"));
	const labelWidth = visibleWidth(label);
	const left = Math.max(0, Math.floor((inner - labelWidth) / 2));
	const right = Math.max(0, inner - labelWidth - left);
	return [
		theme.fg("border", `╭${"─".repeat(left)}`) +
			theme.fg("accent", label) +
			theme.fg("border", `${"─".repeat(right)}╮`),
		...lines.map((line) => theme.fg("border", "│") + fit(line, inner) + theme.fg("border", "│")),
		theme.fg("border", `╰${"─".repeat(inner)}╯`),
	];
}
