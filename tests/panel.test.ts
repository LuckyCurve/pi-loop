import { describe, expect, it } from "vitest";
import type { LoopRecord } from "../src/engine.ts";
import {
	actionOptions,
	countdownLabel,
	loopDetail,
	loopHeading,
	loopOptions,
	noLoopsMessage,
	optionTitle,
} from "../src/panel.ts";

const NOW = 1_000_000;

function loop(overrides: Partial<LoopRecord> = {}): LoopRecord {
	return {
		id: "l1",
		prompt: "check the deploy",
		intervalMs: 300_000,
		createdAt: NOW - 60_000,
		runs: 4,
		skips: 1,
		consecutiveSkips: 0,
		nextAt: NOW + 150_000,
		...overrides,
	};
}

describe("optionTitle", () => {
	it("counts the loops", () => {
		expect(optionTitle(1)).toBe("Loops (1)");
		expect(optionTitle(3)).toBe("Loops (3)");
	});
});

describe("countdownLabel", () => {
	it("reads as a time until the next run", () => {
		expect(countdownLabel(150_000)).toBe("next 2m30s");
		expect(countdownLabel(20_000)).toBe("next 20s");
	});
	it("says so when the run is due now", () => {
		expect(countdownLabel(0)).toBe("due now");
		expect(countdownLabel(400)).toBe("due now");
	});
});

describe("loopHeading", () => {
	it("is one short status line, because it is drawn into the box border", () => {
		expect(loopHeading(loop(), NOW)).toBe("l1 · every 5m · next 2m30s");
	});

	it("never lets a prompt reach the caption", () => {
		// A prompt is arbitrary text. Drawn into the border it eats the whole line, which is exactly
		// how a 300-character instruction left the panel with no top border.
		const heading = loopHeading(loop({ prompt: "x".repeat(300) }), NOW);
		expect(heading).not.toContain("xxx");
		expect(heading.length).toBeLessThan(40);
	});

	it("names the state instead of a countdown while a loop is stopped", () => {
		expect(loopHeading(loop({ paused: "agent" }), NOW)).toBe("l1 · every 5m · paused");
		expect(loopHeading(loop({ paused: "user" }), NOW)).toBe("l1 · every 5m · disabled");
	});
});

describe("loopDetail", () => {
	it("carries the prompt in full, so a long one is readable somewhere", () => {
		const prompt = "y".repeat(300);
		expect(loopDetail(loop({ prompt }))).toBe(prompt);
	});

	it("leads with why a stopped loop stopped", () => {
		const nl = String.fromCharCode(10);
		expect(loopDetail(loop({ paused: "agent", breakReason: "which env?" }))).toBe(
			`waiting for your answer: which env?${nl}check the deploy`,
		);
		expect(loopDetail(loop({ paused: "user" }))).toBe(`disabled by you${nl}check the deploy`);
		expect(loopDetail(loop({ paused: "agent" }))).toBe(`waiting for your answer${nl}check the deploy`);
	});
});

describe("loopOptions", () => {
	it("puts the schedule on the primary column and the counts plus prompt on the detail column", () => {
		const [row] = loopOptions([loop()], NOW);
		expect(row!.label).toBe("l1 · every 5m · next 2m30s");
		expect(row!.description).toBe("runs 4 · skips 1 · check the deploy");
		expect(row!.action).toEqual({ kind: "open", id: "l1" });
	});

	it("drops the run and skip counts for a paused loop and leads with why it stopped", () => {
		const [waiting] = loopOptions([loop({ paused: "agent", breakReason: "which env?" })], NOW);
		expect(waiting!.label).toBe("l1 · every 5m · paused");
		expect(waiting!.label).not.toContain("runs");
		expect(waiting!.description).toBe("waiting for your answer · which env? · check the deploy");

		const [disabled] = loopOptions([loop({ paused: "user" })], NOW);
		expect(disabled!.label).toBe("l1 · every 5m · disabled");
		expect(disabled!.description).toBe("disabled by you · check the deploy");
	});

	it("omits the counts while a loop has not run yet", () => {
		const [row] = loopOptions([loop({ runs: 0, skips: 0 })], NOW);
		expect(row!.description).toBe("check the deploy");
	});

	it("ends with the row that closes the panel", () => {
		const options = loopOptions([loop()], NOW);
		expect(options.map((option) => option.value)).toEqual(["l1", "close"]);
		expect(options.at(-1)!.label).toBe("Close");
		expect(options.at(-1)!.action).toEqual({ kind: "close" });
	});

	it("keeps the engine's order", () => {
		const options = loopOptions([loop({ id: "l2" }), loop({ id: "l1" })], NOW);
		expect(options.map((option) => option.value)).toEqual(["l2", "l1", "close"]);
	});

	it("has unique values, because the selection returns one", () => {
		const options = loopOptions([loop({ id: "l1" }), loop({ id: "l2" })], NOW);
		expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
	});

	it("truncates a long prompt instead of letting it run off the row", () => {
		const [row] = loopOptions([loop({ prompt: "x".repeat(200) })], NOW);
		expect(row!.description.length).toBeLessThan(100);
		expect(row!.description).toContain("…");
	});

	it("collapses a multi-line prompt to its first line", () => {
		const [row] = loopOptions([loop({ prompt: "first line\nsecond line" })], NOW);
		expect(row!.description).toBe("runs 4 · skips 1 · first line");
	});

	it("says what to do when nothing is running", () => {
		expect(loopOptions([], NOW)).toEqual([]);
		expect(noLoopsMessage()).toBe("No loops are running.");
	});
});

describe("actionOptions", () => {
	it("offers disable, run now, remove, and back for a running loop", () => {
		const options = actionOptions(loop());
		expect(options.map((option) => option.label)).toEqual(["Disable", "Run now", "Remove", "Back"]);
		expect(options[0]!.action).toEqual({ kind: "toggle", id: "l1", enable: false });
		expect(options[1]!.action).toEqual({ kind: "run", id: "l1" });
		expect(options[2]!.action).toEqual({ kind: "remove", id: "l1" });
		expect(options[3]!.action).toEqual({ kind: "back" });
	});

	it("offers enable instead of disable for a paused loop", () => {
		const options = actionOptions(loop({ paused: "agent" }));
		expect(options[0]!.label).toBe("Enable");
		expect(options[0]!.action).toEqual({ kind: "toggle", id: "l1", enable: true });
	});

	it("offers a one-off run for both a running and a paused loop", () => {
		// Escaping the panel used to be the only way out of a missed iteration; running it now is an
		// explicit action that leaves the schedule alone.
		for (const state of [{}, { paused: "agent" as const }, { paused: "user" as const }]) {
			const run = actionOptions(loop(state)).find((option) => option.label === "Run now");
			expect(run?.action).toEqual({ kind: "run", id: "l1" });
		}
	});
});
