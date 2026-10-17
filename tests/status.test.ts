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
		expect(composeStatus([loop()], NOW)).toBe("⟳ LOOP l1 · every 5m · next 2m30s");
	});

	it("adds run and skip counts once they are non-zero", () => {
		expect(composeStatus([loop({ runs: 4, skips: 1 })], NOW)).toBe(
			"⟳ LOOP l1 · every 5m · next 2m30s · runs 4 · skips 1",
		);
	});

	it("shows the soonest loop and summarises the rest", () => {
		const status = composeStatus([loop(), loop({ id: "l2", nextAt: NOW + 60_000 })], NOW);
		expect(status).toContain("⟳ LOOP l2");
		expect(status).toContain("+1 more");
	});

	it("reports a fully paused set with its cause", () => {
		expect(composeStatus([loop({ paused: "agent" })], NOW)).toBe("LOOP 1 paused (agent)");
	});

	it("mentions paused loops next to the active countdown", () => {
		const status = composeStatus([loop({ runs: 2 }), loop({ id: "l2", paused: "user" })], NOW);
		expect(status).toContain("⟳ LOOP l1");
		expect(status).toContain("1 paused");
	});
});
