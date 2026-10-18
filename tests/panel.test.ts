import { describe, expect, it } from "vitest";
import type { LoopRecord } from "../src/engine.ts";
import {
	actionOptions,
	loopDetail,
	loopHeading,
	loopOptions,
	noLoopsMessage,
	pauseWording,
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

describe("loopHeading", () => {
	it("is one short status line, because it is drawn into the box border", () => {
		expect(loopHeading(loop(), NOW)).toBe("Task 1 · every 5m · next 2m30s");
	});

	it("never lets a prompt reach the caption", () => {
		// A prompt is arbitrary text. Drawn into the border it eats the whole line, which is exactly
		// how a 300-character instruction left the panel with no top border.
		const heading = loopHeading(loop({ prompt: "x".repeat(300) }), NOW);
		expect(heading).not.toContain("xxx");
		expect(heading.length).toBeLessThan(40);
	});

	it("names the state instead of a countdown while a loop is stopped", () => {
		expect(loopHeading(loop({ paused: "agent" }), NOW)).toBe("Task 1 · every 5m · paused");
		expect(loopHeading(loop({ paused: "user" }), NOW)).toBe("Task 1 · every 5m · disabled");
	});
});

describe("loopDetail", () => {
	const nl = String.fromCharCode(10);

	it("leads with the instruction, because that is what the user asked for", () => {
		expect(loopDetail(loop())).toBe(`Instruction${String.fromCharCode(10)}check the deploy`);
	});

	it("carries the prompt in full, so a long one is readable somewhere", () => {
		const prompt = "y".repeat(300);
		expect(loopDetail(loop({ prompt }))).toBe(`Instruction${nl}${prompt}`);
	});

	it("puts the model's reason below the instruction, in its own labelled block", () => {
		// Instruction first, then what the agent said about it: the request is the context for the
		// reply, not the other way round.
		expect(loopDetail(loop({ paused: "agent", breakReason: "which env?" }))).toBe(
			[`Instruction`, "check the deploy", "", `Stopped: waiting for your answer`, "which env?"].join(nl),
		);
		expect(loopDetail(loop({ paused: "user" }))).toBe(
			["Instruction", "check the deploy", "", `Stopped: disabled by you`].join(nl),
		);
		expect(loopDetail(loop({ paused: "agent" }))).toBe(
			["Instruction", "check the deploy", "", `Stopped: waiting for your answer`].join(nl),
		);
	});
});

describe("pauseWording", () => {
	it("is the single place a stopped loop is named", () => {
		// The caption, the row, and the detail block all read this. They used to carry two parallel
		// ternaries that could drift apart.
		expect(pauseWording(loop())).toBeUndefined();
		expect(pauseWording(loop({ paused: "agent" }))).toEqual({ state: "paused", waiting: true });
		expect(pauseWording(loop({ paused: "user" }))).toEqual({ state: "disabled", waiting: false });
	});
});

describe("loopOptions", () => {
	it("keeps the row to schedule and counters", () => {
		// A list row is a row. The prompt lives on the loop's own page — every loop has a different
		// one, so a shared block on the list would show whatever the cursor happened to be over.
		const [row] = loopOptions([loop()], NOW);
		expect(row!.label).toBe("Task 1 · every 5m · next 2m30s");
		expect(row!.description).toBe("runs 4 · skips 1");
		expect(row!.action).toEqual({ kind: "open", id: "l1" });
	});

	it("names the state for a paused loop instead of a countdown", () => {
		const [waiting] = loopOptions([loop({ paused: "agent", breakReason: "which env?" })], NOW);
		expect(waiting!.label).toBe("Task 1 · every 5m · paused");
		expect(waiting!.description, "no prose on the list row").toBe("runs 4 · skips 1");

		const [disabled] = loopOptions([loop({ paused: "user" })], NOW);
		expect(disabled!.label).toBe("Task 1 · every 5m · disabled");
	});

	it("marks a self-paced loop as dynamic instead of showing a fixed interval", () => {
		// The interval a self-paced loop carries is only a fallback, so printing it as the cadence
		// would be a lie: the next run may be far sooner or later.
		const [row] = loopOptions([loop({ pacing: "self" })], NOW);
		expect(row!.label).toBe("Task 1 · dynamic · next 2m30s");
		expect(row!.label).not.toContain("every");
	});

	it("shows the countdown a self-paced loop actually chose", () => {
		const [row] = loopOptions([loop({ pacing: "self", nextAt: NOW + 90_000, pacedFor: 90_000 })], NOW);
		expect(row!.label).toBe("Task 1 · dynamic · next 1m30s");
	});

	it("names the state rather than a countdown for a paused self-paced loop", () => {
		const [row] = loopOptions([loop({ pacing: "self", paused: "agent" })], NOW);
		expect(row!.label).toBe("Task 1 · dynamic · paused");
	});

	it("says when the next run is due for a self-paced loop", () => {
		expect(loopHeading(loop({ pacing: "self" }), NOW)).toBe("Task 1 · dynamic · next 2m30s");
	});

	it("explains the fallback on the detail page", () => {
		// "dynamic" alone does not tell the user what happens if the model says nothing.
		const detail = loopDetail(loop({ pacing: "self", intervalMs: 600_000 }));
		expect(detail).toContain("dynamic");
		expect(detail).toContain("10m");
	});

	it("does not claim a fallback on a fixed loop's detail", () => {
		expect(loopDetail(loop())).toBe(`Instruction${String.fromCharCode(10)}check the deploy`);
	});

	it("leaves the detail column empty while a loop has not run yet", () => {
		const [row] = loopOptions([loop({ runs: 0, skips: 0 })], NOW);
		expect(row!.description).toBe("");
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

	it("is unaffected by prompt length or shape, because it does not render one", () => {
		const [long] = loopOptions([loop({ prompt: "x".repeat(200) })], NOW);
		const [multi] = loopOptions([loop({ prompt: `first line${String.fromCharCode(10)}second line` })], NOW);
		expect(long!.description).toBe("runs 4 · skips 1");
		expect(multi!.description).toBe("runs 4 · skips 1");
		expect(long!.label).toBe(multi!.label);
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
