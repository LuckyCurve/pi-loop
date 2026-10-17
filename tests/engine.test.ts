import { describe, expect, it } from "vitest";
import { FakeClock } from "./helpers/fake-clock.ts";
import { LoopEngine, type LoopEngineHost, type LoopRecord, type NotifyLevel } from "../src/engine.ts";

/** Deterministic clock: time only moves when the test says so. */
interface Harness {
	clock: FakeClock;
	engine: LoopEngine;
	injected: LoopRecord[];
	notifications: { message: string; level: NotifyLevel }[];
	changes: string[];
	busy: boolean;
}

interface HarnessOptions extends Partial<ConstructorParameters<typeof LoopEngine>[1]> {
	/** Simulate pi: injecting a prompt starts a run, so the agent is busy afterwards. */
	busyAfterInject?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
	const { busyAfterInject = false, ...engineOptions } = options;
	const clock = new FakeClock();
	const injected: LoopRecord[] = [];
	const notifications: { message: string; level: NotifyLevel }[] = [];
	const changes: string[] = [];
	const state = { busy: false };
	const host: LoopEngineHost = {
		isBusy: () => state.busy,
		inject: (record) => {
			injected.push({ ...record });
			if (busyAfterInject) state.busy = true;
		},
		onChange: (reason) => {
			changes.push(reason);
		},
		notify: (message, level) => {
			notifications.push({ message, level });
		},
	};
	const engine = new LoopEngine(host, {
		clock,
		defaultIntervalMs: 600_000,
		maxConsecutiveSkips: 0,
		expireAfterMs: 7 * 24 * 60 * 60 * 1_000,
		...engineOptions,
	});
	return {
		clock,
		engine,
		injected,
		notifications,
		changes,
		get busy() {
			return state.busy;
		},
		set busy(value: boolean) {
			state.busy = value;
		},
	} as Harness & { busy: boolean };
}

describe("LoopEngine scheduling", () => {
	it("runs the first iteration immediately, then on every interval", () => {
		const h = harness();
		h.engine.start({ prompt: "check", intervalMs: 5 * 60_000 });
		expect(h.injected).toHaveLength(1);
		expect(h.injected[0]!.prompt).toBe("check");
		expect(h.engine.list()[0]!.runs).toBe(1);

		h.clock.advance(5 * 60_000 - 1);
		expect(h.injected).toHaveLength(1);
		h.clock.advance(1);
		expect(h.injected).toHaveLength(2);
		expect(h.engine.list()[0]!.runs).toBe(2);

		h.clock.advance(15 * 60_000);
		expect(h.injected).toHaveLength(5);
	});

	it("skips an iteration while the agent is busy", () => {
		const h = harness();
		h.engine.start({ prompt: "check", intervalMs: 60_000 });
		expect(h.injected).toHaveLength(1);

		h.busy = true;
		h.clock.advance(60_000);
		expect(h.injected).toHaveLength(1);
		const loop = h.engine.list()[0]!;
		expect(loop.skips).toBe(1);
		expect(loop.consecutiveSkips).toBe(1);

		// The skipped tick does not queue up work: the next attempt is one interval later.
		h.clock.advance(60_000);
		expect(h.injected).toHaveLength(1);
		expect(h.engine.list()[0]!.skips).toBe(2);

		h.busy = false;
		h.clock.advance(60_000);
		expect(h.injected).toHaveLength(2);
		expect(h.engine.list()[0]!.consecutiveSkips).toBe(0);
	});

	it("serves at most one loop per tick and retries the others without counting a skip", () => {
		const h = harness({ busyAfterInject: true });
		const base = { intervalMs: 60_000, createdAt: 0, runs: 0, skips: 0, consecutiveSkips: 0, nextAt: 0 };
		h.engine.restore({
			counter: 2,
			loops: [
				{ ...base, id: "l1", prompt: "a" },
				{ ...base, id: "l2", prompt: "b" },
			],
		});

		// Both are due at the same tick, but a second prompt would be queued into the run that
		// just started, so only one iteration is injected.
		h.busy = false;
		h.engine.tick(1_000);
		expect(h.injected.map((loop) => loop.prompt)).toEqual(["a"]);

		const b = h.engine.get("l2")!;
		expect(b.skips).toBe(0);
		expect(b.consecutiveSkips).toBe(0);
		expect(b.nextAt).toBe(1_000 + 2_000);

		h.busy = false;
		h.engine.tick(3_000);
		expect(h.injected.map((loop) => loop.prompt)).toEqual(["a", "b"]);
	});

	it("skips instead of queueing when the agent is busy after a run starts", () => {
		const h = harness({ busyAfterInject: true });
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.start({ prompt: "b", intervalMs: 60_000 });
		// `a` started a run; `b` is due but the agent is busy, so it is skipped instead of queued.
		expect(h.injected.map((loop) => loop.prompt)).toEqual(["a"]);
		expect(h.engine.list().find((loop) => loop.prompt === "b")!.skips).toBe(1);
		expect(h.engine.list().find((loop) => loop.prompt === "a")!.runs).toBe(1);
	});

	it("notifies once per skip streak", () => {
		const h = harness();
		h.engine.start({ prompt: "check", intervalMs: 60_000 });
		h.busy = true;
		h.clock.advance(60_000);
		h.clock.advance(60_000);
		h.clock.advance(60_000);
		const skips = h.notifications.filter((n) => n.message.includes("skipped"));
		expect(skips).toHaveLength(1);
	});

	it("notifies on every skip when configured", () => {
		const h = harness({ notifyEverySkip: true });
		h.engine.start({ prompt: "check", intervalMs: 60_000 });
		h.busy = true;
		h.clock.advance(60_000);
		h.clock.advance(60_000);
		const skips = h.notifications.filter((n) => n.message.includes("skipped"));
		expect(skips).toHaveLength(2);
	});

	it("stops a loop after the configured number of consecutive skips", () => {
		const h = harness({ maxConsecutiveSkips: 2 });
		h.engine.start({ prompt: "check", intervalMs: 60_000 });
		h.busy = true;
		h.clock.advance(60_000);
		expect(h.engine.list()).toHaveLength(1);
		h.clock.advance(60_000);
		expect(h.engine.list()).toHaveLength(0);
		expect(h.notifications.some((n) => n.level === "warning")).toBe(true);
	});

	it("expires a loop after its ttl", () => {
		const h = harness({ expireAfterMs: 10 * 60_000 });
		h.engine.start({ prompt: "check", intervalMs: 60_000 });
		h.clock.advance(10 * 60_000);
		expect(h.engine.list()).toHaveLength(0);
	});
});

describe("LoopEngine control", () => {
	it("stops a single loop and keeps the others", () => {
		const h = harness();
		const a = h.engine.start({ prompt: "a", intervalMs: 60_000 });
		const b = h.engine.start({ prompt: "b", intervalMs: 60_000 });
		expect(h.engine.stop(a.id)).toBe(1);
		expect(h.engine.list().map((loop) => loop.id)).toEqual([b.id]);
		expect(h.engine.stop(a.id)).toBe(0);
	});

	it("stops every loop with 'all'", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.start({ prompt: "b", intervalMs: 60_000 });
		expect(h.engine.stop("all")).toBe(2);
		expect(h.engine.isEmpty()).toBe(true);
		expect(h.clock.pending).toBe(0);
	});

	it("pauses and resumes without removing", () => {
		const h = harness();
		const loop = h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.pause(loop.id, "agent", "waiting for answers");
		expect(h.injected).toHaveLength(1);
		h.clock.advance(5 * 60_000);
		expect(h.injected).toHaveLength(1);
		expect(h.engine.list()[0]!.paused).toBe("agent");
		expect(h.engine.agentPaused.map((l) => l.id)).toEqual([loop.id]);

		const resumed = h.engine.resume(loop.id);
		expect(resumed).toHaveLength(1);
		expect(h.engine.list()[0]!.paused).toBeUndefined();
		// Resuming does not fire immediately.
		expect(h.injected).toHaveLength(1);
		h.clock.advance(60_000);
		expect(h.injected).toHaveLength(2);
	});

	it("only resumes loops paused by the matching cause", () => {
		const h = harness();
		const a = h.engine.start({ prompt: "a", intervalMs: 60_000 });
		const b = h.engine.start({ prompt: "b", intervalMs: 60_000 });
		h.engine.pause(a.id, "agent");
		h.engine.pause(b.id, "user");
		expect(h.engine.resume("all", "agent").map((l) => l.id)).toEqual([a.id]);
		expect(h.engine.list().find((l) => l.id === b.id)!.paused).toBe("user");
	});

	it("refuses to start more loops than the cap", () => {
		const h = harness({ maxLoops: 2 });
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.start({ prompt: "b", intervalMs: 60_000 });
		expect(() => h.engine.start({ prompt: "c", intervalMs: 60_000 })).toThrow(/already running/);
	});

	it("tracks the loop that fired most recently", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		expect(h.engine.lastFired?.prompt).toBe("a");
	});

	it("stops the timer when the last loop is removed", () => {
		const h = harness();
		const loop = h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.stop(loop.id);
		expect(h.clock.pending).toBe(0);
	});

	it("stops ticking after dispose", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.dispose();
		h.clock.advance(10 * 60_000);
		expect(h.injected).toHaveLength(1);
	});
});

describe("LoopEngine outcomes", () => {
	it("pauses on a wait outcome and stays waking on a reply", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		expect(h.engine.pause("l1", "agent", "which env?")).toBe(1);

		// A loop that is waiting for an answer is resumable: that is what "wait" promises.
		expect(h.engine.agentPaused.map((loop) => loop.id)).toEqual(["l1"]);
		h.engine.resume("all", "agent");
		expect(h.engine.get("l1")!.paused).toBeUndefined();
	});

	it("removes on a done outcome, so a reply cannot bring it back", () => {
		// The other way a loop ends: the work is finished and there is nothing to ask. Deleting it is
		// what makes that final — a paused loop is resumed by the next user message, and "the user
		// said thanks" is not a reason to start working again.
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		expect(h.engine.stop("l1")).toBe(1);
		expect(h.engine.list()).toEqual([]);
		expect(h.engine.agentPaused).toEqual([]);
		expect(h.clock.pending).toBe(0);
	});
});

describe("LoopEngine run now", () => {
	it("runs an iteration immediately without touching the schedule", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		expect(h.injected, "start injects the first iteration").toHaveLength(1);

		h.clock.advance(10_000);
		const scheduled = h.engine.get("l1")!.nextAt;
		expect(h.engine.runNow("l1")).toBe("ran");
		expect(h.injected).toHaveLength(2);
		expect(h.engine.get("l1")!.runs).toBe(2);
		expect(h.engine.get("l1")!.nextAt, "a manual run must not move the schedule").toBe(scheduled);

		// The scheduled iteration still arrives on its own time.
		h.clock.advance(49_999);
		expect(h.injected).toHaveLength(2);
		h.clock.advance(1);
		expect(h.injected).toHaveLength(3);
	});

	it("skips a manual run while the agent is busy, changing nothing", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.clock.advance(10_000);
		const before = { ...h.engine.get("l1")! };

		h.busy = true;
		expect(h.engine.runNow("l1")).toBe("busy");

		const after = h.engine.get("l1")!;
		expect(h.injected).toHaveLength(1);
		expect(after.runs).toBe(before.runs);
		expect(after.skips, "a manual attempt is not a scheduled skip").toBe(before.skips);
		expect(after.nextAt).toBe(before.nextAt);
	});

	it("runs a paused loop once without resuming it", () => {
		// The panel offers Run now for every loop, so a disabled or waiting one can be nudged once
		// without losing the reason it was stopped.
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.pause("l1", "user");
		expect(h.engine.runNow("l1")).toBe("ran");
		expect(h.injected).toHaveLength(2);
		expect(h.engine.get("l1")!.paused).toBe("user");
	});

	it("reports an unknown loop instead of running something", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		expect(h.engine.runNow("l9")).toBe("missing");
		expect(h.injected).toHaveLength(1);
	});

	it("targets the manual run for a following loop_break", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.start({ prompt: "b", intervalMs: 60_000 });
		h.engine.runNow("l1");
		expect(h.engine.lastFired?.id).toBe("l1");
	});
});

describe("LoopEngine persistence", () => {
	it("round-trips loops through toJSON/restore without firing", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		h.engine.start({ prompt: "b", intervalMs: 120_000 });
		const snapshot = JSON.parse(JSON.stringify(h.engine.toJSON()));

		const h2 = harness();
		expect(h2.engine.restore(snapshot)).toBe(2);
		expect(h2.injected).toHaveLength(0);
		expect(h2.engine.list().map((loop) => loop.prompt)).toEqual(["a", "b"]);

		h2.clock.advance(60_000);
		expect(h2.injected).toHaveLength(1);
		expect(h2.injected[0]!.prompt).toBe("a");
	});

	it("keeps ids unique after restore", () => {
		const h = harness();
		h.engine.start({ prompt: "a", intervalMs: 60_000 });
		const snapshot = JSON.parse(JSON.stringify(h.engine.toJSON()));
		const h2 = harness();
		h2.engine.restore(snapshot);
		const next = h2.engine.start({ prompt: "b", intervalMs: 60_000 });
		expect(next.id).not.toBe("l1");
	});

	it("preserves paused state across restore and ignores garbage", () => {
		const h = harness();
		h.engine.restore({ counter: 1, loops: [{ id: "l1", prompt: "a", intervalMs: 1000, paused: "agent", createdAt: 0 } as never] });
		expect(h.engine.list()[0]!.paused).toBe("agent");
		expect(h.engine.restore({ loops: [{ nope: true } as never] })).toBe(0);
	});
});
