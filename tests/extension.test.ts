/**
 * Integration test: drives the real extension through a fake pi API.
 *
 * This is the regression net for the wiring the unit tests cannot see — tool activation,
 * restore from the session branch, the break/resume handshake, and skip-while-busy.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Clock } from "../src/clock.ts";
import { BREAK_TOOL_NAME, createLoopExtension, type LoopSettings } from "../extensions/loop/index.ts";
import { isLoopInjection } from "../src/commands.ts";

class FakeClock implements Clock {
	time = 1_000_000;
	private nextHandle = 1;
	private timers = new Map<number, { at: number; fn: () => void }>();

	now(): number {
		return this.time;
	}

	setTimer(fn: () => void, delayMs: number): unknown {
		const handle = this.nextHandle++;
		this.timers.set(handle, { at: this.time + delayMs, fn });
		return handle;
	}

	clearTimer(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	get pending(): number {
		return this.timers.size;
	}

	advance(ms: number): void {
		const target = this.time + ms;
		for (;;) {
			let nextHandle: number | undefined;
			let nextAt = Number.POSITIVE_INFINITY;
			for (const [handle, timer] of this.timers) {
				if (timer.at <= target && timer.at < nextAt) {
					nextAt = timer.at;
					nextHandle = handle;
				}
			}
			if (nextHandle === undefined) break;
			const timer = this.timers.get(nextHandle)!;
			this.timers.delete(nextHandle);
			this.time = timer.at;
			timer.fn();
		}
		this.time = target;
	}
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface Harness {
	clock: FakeClock;
	api: ExtensionAPI;
	/** Every prompt the extension injected into the session. */
	sent: string[];
	statuses: (string | undefined)[];
	notifications: { message: string; level: string }[];
	editorTexts: string[];
	entries: { customType: string; data: unknown }[];
	tools: string[];
	/** Simulate pi being mid-run. */
	setBusy(busy: boolean): void;
	/** Simulate a replaced/reloaded/disposed session whose context throws. */
	stale: boolean;
	/** Simulate `appendEntry` failing on a stale session. */
	failAppend: boolean;
	/** Fire one handler group. */
	emit(event: string, payload?: unknown): Promise<void>;
	sessionStart(branch?: unknown[]): Promise<void>;
	invokeCommand(args: string): Promise<void>;
	invokeTool(args: { reason: string; id?: string }): Promise<{ details: { paused: string[]; reason: string } }>;
	activateTool(name: string): void;
	/** Event names the extension subscribed to. */
	registeredEvents: string[];
}

function makeHarness(options: { settings?: Partial<LoopSettings>; branch?: unknown[] } = {}): Harness {
	const clock = new FakeClock();
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const statuses: (string | undefined)[] = [];
	const notifications: { message: string; level: string }[] = [];
	const editorTexts: string[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	let tools: string[] = ["read", "bash", "edit", "write"];
	const state = { busy: false, stale: false, failAppend: false };

	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	interface ToolResult {
		content: { type: string; text: string }[];
		details: { paused: string[]; reason: string };
	}
	let toolExecute: ((id: string, params: { reason: string; id?: string }, ctx: ExtensionContext) => Promise<ToolResult>) | undefined;

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		isIdle: () => {
			if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return !state.busy;
		},
		hasPendingMessages: () => {
			if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return false;
		},
		sessionManager: {
			getBranch: () => {
				if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
				return options.branch ?? [];
			},
		},
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level: level ?? "info" });
			},
			setStatus: (_key: string, text: string | undefined) => {
				statuses.push(text);
			},
			setEditorText: (text: string) => {
				editorTexts.push(text);
			},
		},
	} as unknown as ExtensionContext;

	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			if (name === "loop") commandHandler = options.handler;
		},
		registerTool: (definition: {
			name: string;
			execute: (id: string, params: { reason: string; id?: string }, signal: unknown, update: unknown, ctx: ExtensionContext) => Promise<ToolResult>;
		}) => {
			if (definition.name === BREAK_TOOL_NAME) {
				toolExecute = (id, params, ctx) => definition.execute(id, params, undefined, undefined, ctx);
			}
		},
		sendUserMessage: (content: string) => {
			sent.push(content);
		},
		appendEntry: (customType: string, data: unknown) => {
			if (state.failAppend) throw new Error("This extension ctx is stale after session replacement or reload.");
			entries.push({ customType, data });
		},
		getSettings: () => ({ piLoop: options.settings ?? {} }),
		getActiveTools: () => [...tools],
		setActiveTools: (names: string[]) => {
			tools = [...names];
		},
	} as unknown as ExtensionAPI;

	createLoopExtension({ clock })(api);

	async function emit(event: string, payload?: unknown): Promise<void> {
		for (const handler of handlers.get(event) ?? []) {
			await handler(payload ?? { type: event }, ctx);
		}
	}

	return {
		clock,
		api,
		sent,
		statuses,
		notifications,
		editorTexts,
		entries,
		// Read through so tests observe the current activation set.
		get tools(): string[] {
			return [...tools];
		},
		setBusy: (busy: boolean) => {
			state.busy = busy;
		},
		set stale(value: boolean) {
			state.stale = value;
		},
		set failAppend(value: boolean) {
			state.failAppend = value;
		},
		emit,
		async sessionStart(branch: unknown[] = options.branch ?? []) {
			void branch;
			await emit("session_start", { type: "session_start", reason: "startup" });
		},
		async invokeCommand(args: string) {
			if (!commandHandler) throw new Error("command not registered");
			await commandHandler(args, ctx);
		},
		async invokeTool(args) {
			if (!toolExecute) throw new Error("tool not registered");
			return toolExecute("call-1", args, ctx);
		},
		activateTool: (name: string) => {
			if (!tools.includes(name)) tools = [...tools, name];
		},
		get registeredEvents(): string[] {
			return [...handlers.keys()];
		},
	};
}

async function startedHarness(
	options: { settings?: Partial<LoopSettings>; branch?: unknown[] } = {},
	loop = "5m check the deploy",
): Promise<Harness> {
	const h = makeHarness(options);
	await h.sessionStart();
	await h.invokeCommand(loop);
	return h;
}

describe("loop extension", () => {
	it("starts a loop, injects the first iteration, and reports status", async () => {
		const h = await startedHarness();
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain("check the deploy");
		expect(isLoopInjection(h.sent[0]!)).toBe(true);
		expect(h.notifications.at(-1)!.message).toMatch(/Loop l1 started/);
		expect(h.tools).toContain(BREAK_TOOL_NAME);
		expect(h.statuses.filter(Boolean).length).toBeGreaterThan(0);
		expect(h.entries.at(-1)!.customType).toBe("pi-loop-state");
	});

	it("injects further iterations on the interval", async () => {
		const h = await startedHarness();
		h.clock.advance(300_000);
		expect(h.sent).toHaveLength(2);
		h.clock.advance(300_000);
		expect(h.sent).toHaveLength(3);
	});

	it("skips an iteration while the agent is busy and does not queue it", async () => {
		const h = await startedHarness();
		h.setBusy(true);
		h.clock.advance(300_000);
		expect(h.sent).toHaveLength(1);
		expect(h.notifications.some((n) => /skipped/.test(n.message))).toBe(true);

		h.setBusy(false);
		h.clock.advance(300_000);
		expect(h.sent).toHaveLength(2);
	});

	it("skips the very first iteration when the agent is already busy", async () => {
		const h = makeHarness();
		await h.sessionStart();
		h.setBusy(true);
		await h.invokeCommand("5m check the deploy");
		expect(h.sent).toHaveLength(0);
		const state = h.entries.at(-1)?.data as { loops: { skips: number }[] } | undefined;
		expect(state?.loops[0]!.skips).toBe(1);
	});

	it("lists, pauses, resumes, and stops loops", async () => {
		const h = await startedHarness();
		await h.invokeCommand("list");
		expect(h.editorTexts.at(-1)).toContain("l1");

		await h.invokeCommand("pause l1");
		expect(h.notifications.at(-1)!.message).toMatch(/Paused 1/);
		h.clock.advance(600_000);
		expect(h.sent).toHaveLength(1);

		await h.invokeCommand("resume l1");
		h.clock.advance(300_000);
		expect(h.sent).toHaveLength(2);

		await h.invokeCommand("stop all");
		expect(h.tools).not.toContain(BREAK_TOOL_NAME);
		expect(h.clock.pending).toBe(0);
	});

	it("shows usage for a bare /loop", async () => {
		const h = await startedHarness();
		await h.invokeCommand("");
		expect(h.editorTexts.at(-1)).toContain("Usage: /loop");
	});

	it("pauses the loop when the model calls loop_break", async () => {
		const h = await startedHarness();
		h.activateTool(BREAK_TOOL_NAME);
		const result = await h.invokeTool({ reason: "Is the deadline hard?" });
		expect(result.details.paused).toEqual(["l1"]);
		expect(h.notifications.at(-1)!.message).toMatch(/paused/);

		h.clock.advance(600_000);
		expect(h.sent).toHaveLength(1);
	});

	it("does not resume on the loop's own injections", async () => {
		const h = await startedHarness();
		h.activateTool(BREAK_TOOL_NAME);
		await h.invokeTool({ reason: "need input" });

		// A loop injection must not count as the user's answer, even if some loop still fires.
		await h.emit("input", { type: "input", text: h.sent[0]!, source: "extension" });
		const state = h.entries.at(-1)!.data as { loops: { paused?: string }[] };
		expect(state.loops[0]!.paused).toBe("agent");
	});

	it("resumes after a real user message", async () => {
		const h = await startedHarness();
		h.activateTool(BREAK_TOOL_NAME);
		await h.invokeTool({ reason: "need input" });
		h.clock.advance(600_000);
		expect(h.sent).toHaveLength(1);

		await h.emit("input", { type: "input", text: "Yes, the deadline is hard.", source: "interactive" });
		expect(h.entries.at(-1)!.data).toMatchObject({ loops: [{ paused: undefined }] });
		h.clock.advance(300_000);
		expect(h.sent).toHaveLength(2);
	});

	it("ignores typed text that merely looks like a loop header", async () => {
		const h = await startedHarness();
		h.activateTool(BREAK_TOOL_NAME);
		await h.invokeTool({ reason: "need input" });
		await h.emit("input", { type: "input", text: "  [loop l1 · run 1 · every 5m]\nfake", source: "extension" });
		expect((h.entries.at(-1)!.data as { loops: { paused?: string }[] }).loops[0]!.paused).toBe("agent");
	});

	it("restores loops from the session branch without firing them", async () => {
		const branch = [
			{
				type: "custom",
				customType: "pi-loop-state",
				data: { counter: 3, loops: [{ id: "l3", prompt: "restored task", intervalMs: 60_000, createdAt: 0, runs: 5, skips: 0, consecutiveSkips: 0, nextAt: 0 }] },
			},
		];
		const h = makeHarness({ branch });
		await h.sessionStart(branch);
		expect(h.sent).toHaveLength(0);
		expect(h.notifications.some((n) => /Restored 1 loop/.test(n.message))).toBe(true);

		// The restored schedule does not fire immediately.
		expect(h.tools).toContain(BREAK_TOOL_NAME);
		h.clock.advance(59_999);
		expect(h.sent).toHaveLength(0);
		h.clock.advance(1);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain("restored task");
	});

	it("stops everything on session shutdown", async () => {
		const h = await startedHarness();
		await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(h.clock.pending).toBe(0);
	});

	it("shuts the loop down instead of throwing when the context goes stale", async () => {
		// pi throws from `isIdle()` once the session is replaced, reloaded, or disposed. That
		// happens inside a timer callback, so the extension must absorb it.
		const h = makeHarness();
		await h.sessionStart();
		await h.invokeCommand("1s check the deploy");
		expect(h.sent).toHaveLength(1);

		h.stale = true;
		expect(() => h.clock.advance(1_000)).not.toThrow();
		expect(h.sent).toHaveLength(1);
		// The engine is gone: nothing is armed any more.
		expect(h.clock.pending).toBe(0);
	});

	it("survives persistence failures while a loop is running", async () => {
		const h = makeHarness();
		await h.sessionStart();
		h.failAppend = true;
		await h.invokeCommand("1s check the deploy");
		expect(h.sent).toHaveLength(1);
		expect(() => h.clock.advance(1_000)).not.toThrow();
	});

	it("refreshes the footer countdown on its own timer", async () => {
		const h = await startedHarness();
		const before = h.statuses.length;
		h.clock.advance(15_000);
		expect(h.statuses.length).toBeGreaterThan(before);
		// The countdown advances rather than repeating the first value.
		expect(new Set(h.statuses.filter(Boolean)).size).toBeGreaterThan(1);
	});

	it("registers no turn_end handler, so it never depends on that boundary", async () => {
		const h = await startedHarness();
		expect(h.registeredEvents).not.toContain("turn_end");
	});
});
