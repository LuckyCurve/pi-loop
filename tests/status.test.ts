import { describe, expect, it } from "vitest";
import type { LoopRecord } from "../src/engine.ts";
import { composeStatus } from "../src/status.ts";

const NOW = 1_000_000;

function loop(overrides: Partial<LoopRecord> = {}): LoopRecord {
	return {
		id: "l1",
		prompt: "check the deploy",
		intervalMs: 300_000,
		createdAt: NOW,
		runs: 0,
		skips: 0,
		consecutiveSkips: 0,
		nextAt: NOW + 150_000,
		...overrides,
	};
}

describe("composeStatus", () => {
	it("returns nothing when no loop exists", () => {
		expect(composeStatus([], NOW)).toBeUndefined();
	});

	it("announces the running loop and its countdown", () => {
		expect(composeStatus([loop()], NOW)).toBe("⟳ LOOP Task 1 · every 5m · next 2m30s");
	});

	it("adds run and skip counts once they are non-zero", () => {
		expect(composeStatus([loop({ runs: 4, skips: 1 })], NOW)).toBe(
			"⟳ LOOP Task 1 · every 5m · next 2m30s · runs 4 · skips 1",
		);
	});

	it("shows the soonest loop and summarises the rest", () => {
		const status = composeStatus([loop(), loop({ id: "l2", nextAt: NOW + 60_000 })], NOW);
		expect(status).toContain("⟳ LOOP Task 2");
		expect(status).toContain("+1 more");
	});

	it("reports a fully paused set with its cause", () => {
		expect(composeStatus([loop({ paused: "agent" })], NOW)).toBe("LOOP 1 paused (agent)");
	});

	it("counts only the other running loops as `more`", () => {
		// A paused loop is already reported by its own field. Counting it as `more` as well made a
		// two-loop footer read like three loops.
		const status = composeStatus([loop({ runs: 2 }), loop({ id: "l2", paused: "user" })], NOW);
		expect(status).not.toContain("more");
		expect(status).toContain("1 paused");
	});

	it("says the run is due rather than `next now` when it has arrived", () => {
		const status = composeStatus([loop({ nextAt: NOW - 400 })], NOW);
		expect(status).toContain("due now");
		expect(status).not.toContain("next now");
	});

	it("words the interval the same way the panel does", () => {
		// The footer said `every 24h` where the panel said `every 1d` for the same loop.
		expect(composeStatus([loop({ intervalMs: 86_400_000 })], NOW)).toContain("every 1d");
	});

	it("omits the countdown when the footer is not being refreshed", () => {
		// A countdown that never ticks is worse than no countdown: it keeps claiming a time that has
		// already passed.
		expect(composeStatus([loop({ runs: 2 })], NOW, { countdown: false })).toBe("⟳ LOOP Task 1 · every 5m · runs 2");
	});

	it("mentions paused loops next to the active countdown", () => {
		const status = composeStatus([loop({ runs: 2 }), loop({ id: "l2", paused: "user" })], NOW);
		expect(status).toContain("⟳ LOOP Task 1");
		expect(status).toContain("1 paused");
	});
});
