/**
 * The panel component, tested directly: no pi session, no runtime, time from a fake clock.
 *
 * The two behaviours worth pinning here are the ones a row change would not reveal: the box has an
 * edge (an overlay without one blends into the transcript behind it), and the countdown repaints on
 * its own (pi only repaints on input and events, so a countdown would otherwise freeze).
 */
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PanelOption } from "../src/panel.ts";
import {
	createPanelView,
	PANEL_OVERLAY,
	PANEL_REFRESH_MS,
	panelLineBudget,
	panelOverlayOptions,
} from "../extensions/loop/panel-view.ts";
import { FakeClock } from "./helpers/fake-clock.ts";

const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const HINT = "↑↓ navigate  Enter select  Esc cancel";

function option(value: string, label: string): PanelOption {
	return { value, label, description: "desc", action: { kind: "open", id: value } };
}

/** Only the styling and geometry knobs are overridable; the callbacks are wired by the harness. */
type Overridable = Pick<Parameters<typeof createPanelView>[0], "refreshMs">;

function makeView(overrides: Overridable = {}) {
	const clock = new FakeClock(1_000_000);
	let maxLines = 30;
	const repaints: number[] = [];
	const selections: string[] = [];
	const cancels: number[] = [];
	let rows: PanelOption[] = [option("l1", "l1 · every 5m · next 2m30s"), option("l2", "l2 · every 1m · next 20s")];

	const view = createPanelView({
		theme: THEME,
		clock,
		load: () => rows,
		title: () => `Loops (${rows.length})`,
		hint: HINT,
		maxLines: () => maxLines,
		requestRender: () => repaints.push(clock.now()),
		onSelect: (value) => selections.push(value),
		onCancel: () => cancels.push(clock.now()),
		...overrides,
	});

	return {
		clock,
		view,
		repaints,
		selections,
		cancels,
		setRows: (next: PanelOption[]) => {
			rows = next;
		},
		setMaxLines: (next: number) => {
			maxLines = next;
		},
	};
}

const render = (view: { render(width: number): string[] }, width = 40): string[] => view.render(width);

describe("panel view box", () => {
	it("frames the rows so the overlay has an edge", () => {
		const lines = render(makeView().view);
		expect(lines[0]!.startsWith("╭")).toBe(true);
		expect(lines[0]!.endsWith("╮")).toBe(true);
		expect(lines[0]).toContain("Loops (2)");
		expect(lines.at(-1)!.startsWith("╰")).toBe(true);
		expect(lines.at(-1)!.endsWith("╯")).toBe(true);
		for (const line of lines.slice(1, -1)) {
			expect(line.startsWith("│")).toBe(true);
			expect(line.endsWith("│")).toBe(true);
		}
	});

	it("pads every line to the full width, so the transcript cannot show through", () => {
		// Without the padding the border would be drawn but the gap between a short row and the
		// right border would be whatever was underneath.
		for (const line of render(makeView().view, 40)) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	it("keeps the hint inside the box, above the bottom border", () => {
		const lines = render(makeView().view);
		expect(lines.at(-2)).toContain("Esc cancel");
	});

	it("shows a notice instead of an empty box when nothing is left", () => {
		const h = makeView();
		h.setRows([]);
		const lines = render(h.view);
		expect(lines.join("\n")).toContain("No loops are running.");
		expect(lines.at(-1)!.startsWith("╰")).toBe(true);
	});

	it("does not split a wide character across the right border", () => {
		// A row ending in a full-width character must still leave the border flush at `width`.
		const h = makeView();
		h.setRows([option("l1", "l1 · 每 5m · 查看缺陷单"), option("l2", "l2 · ok")]);
		const lines = render(h.view, 30);
		for (const line of lines) expect(visibleWidth(line)).toBe(30);
	});
});

describe("panel view height", () => {
	const manyRows = (count: number): PanelOption[] =>
		Array.from({ length: count }, (_, index) => option(`l${index + 1}`, `l${index + 1} · every 5m · next 2m30s`));

	it("mirrors how pi clamps an overlay's maxHeight", () => {
		// 80% of the terminal, never more than the space left after the margins.
		expect(panelLineBudget(40)).toBe(32);
		expect(panelLineBudget(10)).toBe(8);
		expect(panelLineBudget(3)).toBe(1);
		expect(panelLineBudget(0)).toBe(1);
	});

	it("keeps the overlay geometry in one place", () => {
		const options = panelOverlayOptions();
		expect(options.anchor).toBe("center");
		expect(options.margin).toBe(PANEL_OVERLAY.margin);
		expect(options.maxHeight).toBe(`${PANEL_OVERLAY.heightFraction * 100}%`);
	});

	it("shrinks the list so the bottom border stays on screen", () => {
		// pi slices the overlay's lines when they exceed its maxHeight, so an over-tall box loses its
		// bottom border — which is the "no visible edge" complaint all over again.
		const h = makeView();
		h.setRows(manyRows(20));
		h.setMaxLines(10);
		const lines = render(h.view);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines.at(-1)!.startsWith("╰")).toBe(true);
	});

	it("fits the scroll indicator inside the budget too", () => {
		const h = makeView();
		h.setRows(manyRows(20));
		h.setMaxLines(8);
		const lines = render(h.view);
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.join(String.fromCharCode(10))).toContain("/20)");
		expect(lines.at(-1)!.endsWith("╯")).toBe(true);
	});

	it("re-reads the budget on every render, so a resize is respected", () => {
		const h = makeView();
		h.setRows(manyRows(20));
		h.setMaxLines(30);
		expect(render(h.view).length).toBeGreaterThan(10);
		h.setMaxLines(6);
		expect(render(h.view).length).toBeLessThanOrEqual(6);
	});
});

describe("panel view countdown", () => {
	it("re-reads its rows on every render, so the countdown is current", () => {
		const h = makeView();
		expect(render(h.view).join("\n")).toContain("next 2m30s");

		h.setRows([option("l1", "l1 · every 5m · next 1m30s")]);
		expect(render(h.view).join("\n")).toContain("next 1m30s");
	});

	it("repaints on its own timer so the countdown does not freeze", () => {
		const h = makeView();
		expect(h.clock.pending, "the panel must have a repaint timer").toBe(1);

		h.clock.advance(PANEL_REFRESH_MS);
		expect(h.repaints).toHaveLength(1);
		h.clock.advance(PANEL_REFRESH_MS * 2);
		expect(h.repaints).toHaveLength(3);
		// Still armed: repainting is continuous while the box is open.
		expect(h.clock.pending).toBe(1);
	});

	it("takes the repaint cadence as an option", () => {
		const h = makeView({ refreshMs: 250 });
		h.clock.advance(999);
		expect(h.repaints).toHaveLength(3);
	});

	it("never arms a timer for a static dialog", () => {
		const h = makeView({ refreshMs: 0 });
		expect(h.clock.pending).toBe(0);
		h.clock.advance(PANEL_REFRESH_MS * 10);
		expect(h.repaints).toHaveLength(0);
	});

	it("stops repainting after dispose", () => {
		const h = makeView();
		h.view.dispose();
		expect(h.clock.pending).toBe(0);

		h.clock.advance(PANEL_REFRESH_MS * 5);
		expect(h.repaints).toHaveLength(0);
	});

	it("survives dispose being called twice", () => {
		const h = makeView();
		h.view.dispose();
		expect(() => h.view.dispose()).not.toThrow();
		expect(h.clock.pending).toBe(0);
	});
});

describe("panel view input", () => {
	it("reports the row the user confirmed", () => {
		const h = makeView();
		render(h.view);
		h.view.handleInput("\x1b[B");
		h.view.handleInput("\r");
		expect(h.selections).toEqual(["l2"]);
	});

	it("keeps the cursor on the same row across a repaint", () => {
		// The rows are rebuilt on every render, so carrying the selection is what stops the cursor
		// snapping back to the top once per second.
		const h = makeView();
		render(h.view);
		h.view.handleInput("\x1b[B");
		render(h.view);
		h.view.handleInput("\r");
		expect(h.selections).toEqual(["l2"]);
	});

	it("cancels on ctrl+c", () => {
		const h = makeView();
		render(h.view);
		h.view.handleInput("\x03");
		expect(h.cancels).toHaveLength(1);
	});
});
