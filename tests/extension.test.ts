/**
 * Integration test: drives the real extension through a fake pi API.
 *
 * This is the regression net for the wiring the unit tests cannot see — tool activation,
 * restore from the session branch, the break/resume handshake, and skip-while-busy.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "./helpers/fake-clock.ts";
import { BREAK_TOOL_NAME, createLoopExtension, type LoopSettings } from "../extensions/loop/index.ts";
import { isLoopInjection } from "../src/commands.ts";
import { scriptedUI } from "./helpers/scripted-ui.ts";

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
	sessionStart(branch?: unknown[], reason?: string): Promise<void>;
	invokeCommand(args: string): Promise<void>;
	invokeTool(args: { reason: string; id?: string; outcome?: "wait" | "done" }): Promise<{
		details: { paused: string[]; finished: string[]; reason: string };
	}>;
	activateTool(name: string): void;
	/** Event names the extension subscribed to. */
	registeredEvents: string[];
	setNoUI(value: boolean): void;
	/** Act while a dialog is open; see `scriptedUI`. */
	setOnDialogOpen(hook: () => void | Promise<void>): void;
	/** Repaints requested by live dialogs. */
	repaints: number[];
	/** Queue answers for the dialogs the extension opens, in call order. */
	queueSelect(...answers: (string | undefined)[]): void;
	/** Every dialog the extension showed: caption, rendered body, and rows. */
	selects: { title: string; body: string[]; rows: string[] }[];
	/** How each custom dialog was presented (overlay + anchor). */
	presentation: { overlay: boolean; anchor: string | undefined }[];
}

function makeHarness(options: { settings?: Partial<LoopSettings>; branch?: unknown[] } = {}): Harness {
	const clock = new FakeClock(1_000_000);
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const statuses: (string | undefined)[] = [];
	const notifications: { message: string; level: string }[] = [];
	const editorTexts: string[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	let tools: string[] = ["read", "bash", "edit", "write"];
	const state = { busy: false, stale: false, failAppend: false, noUI: false };

	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	interface ToolResult {
		content: { type: string; text: string }[];
		details: { paused: string[]; finished: string[]; reason: string };
	}
	let toolExecute: ((
		id: string,
		params: { reason: string; id?: string; outcome?: "wait" | "done" },
		ctx: ExtensionContext,
	) => Promise<ToolResult>) | undefined;

	const scripted = scriptedUI({
		// pi throws from every ctx accessor once the session is replaced; the extension must absorb
		// that inside a timer callback, where nothing else can catch it.
		onNotify: () => {
			if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	});
	const ui = scripted.ui;

	const ctx = {
		mode: "tui",
		get hasUI() {
			return !state.noUI;
		},
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
		ui,
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
			execute: (
				id: string,
				params: { reason: string; id?: string; outcome?: "wait" | "done" },
				signal: unknown,
				update: unknown,
				ctx: ExtensionContext,
			) => Promise<ToolResult>;
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
		notifications: scripted.notifications,
		editorTexts: scripted.editorTexts,
		statuses: scripted.statuses,
		entries,
		selects: scripted.dialogs,
		presentation: scripted.presentation,
		queueSelect: scripted.script,
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
		setNoUI: (value: boolean) => {
			state.noUI = value;
		},
		setOnDialogOpen: (hook) => {
			scripted.onDialogOpen = () => hook();
		},
		repaints: scripted.repaints,
		emit,
		async sessionStart(branch: unknown[] = options.branch ?? [], reason = "reload") {
			void branch;
			await emit("session_start", { type: "session_start", reason });
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
		expect(h.notifications.at(-1)!.message).toMatch(/Task 1 started/);
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

	it("disables and re-enables a loop from the panel", async () => {
		const h = await startedHarness();

		h.queueSelect("Task 1", "Disable");
		await h.invokeCommand("");
		expect(h.notifications.at(-1)!.message).toMatch(/Disabled Task 1/);
		h.clock.advance(600_000);
		expect(h.sent).toHaveLength(1);

		h.queueSelect("Task 1", "Enable");
		await h.invokeCommand("");
		expect(h.notifications.at(-1)!.message).toMatch(/Enabled Task 1/);
		h.clock.advance(300_000);
		expect(h.sent).toHaveLength(2);
	});

	it("shows usage when a start command is malformed", async () => {
		const h = await startedHarness();
		// A bare interval has no prompt: that is an error, so the usage text wins over the panel.
		await h.invokeCommand("5m");
		expect(h.editorTexts.at(-1)).toContain("missing prompt");
		expect(h.selects).toHaveLength(0);
	});

	it("opens the panel on a bare /loop in a UI session", async () => {
		const h = await startedHarness();
		h.queueSelect("Close");
		await h.invokeCommand("");

		// The panel lists the loop, not the usage text: the popup is the primary surface.
		expect(h.selects[0]!.title).toBe("Loops (1)");
		expect(h.selects[0]!.rows[0]).toContain("Task 1");
		expect(h.selects[0]!.rows[0]).toContain("every 5m");
		expect(h.selects[0]!.rows.at(-1)).toBe("Close");
		// The list page shows rows only. The prompt belongs to the task's own page, because each task
		// has a different one and a shared block would show whichever happened to be highlighted.
		expect(h.selects[0]!.body.join(String.fromCharCode(10))).not.toContain("check the deploy");
		expect(h.selects[0]!.title).not.toContain("check the deploy");
		expect(h.editorTexts).toHaveLength(0);
	});

	it("opens the panel as a centered overlay, not a selector in the editor", async () => {
		// A management panel belongs in the middle of the screen. Rendering it in the editor slot at
		// the bottom is what a plain `ctx.ui.select()` does, and dropping `overlay: true` would put it
		// back there without changing a single row.
		const h = await startedHarness();
		h.queueSelect("Close");
		await h.invokeCommand("");

		expect(h.presentation).toEqual([{ overlay: true, anchor: "center" }]);
	});

	it("removes a loop from the panel", async () => {
		const h = await startedHarness();
		h.queueSelect("Task 1", "Remove");
		await h.invokeCommand("");

		expect(h.selects[1]!.rows).toEqual(["Disable", "Run now", "Remove", "Back"]);
		expect(h.notifications.at(-1)!.message).toMatch(/Removed Task 1/);
		expect(h.tools).not.toContain(BREAK_TOOL_NAME);
		expect(h.clock.pending).toBe(0);
	});

	it("disables a loop from the panel and enables it again", async () => {
		const h = await startedHarness();
		h.queueSelect("Task 1", "Disable");
		await h.invokeCommand("");

		expect(h.notifications.at(-1)!.message).toMatch(/Disabled Task 1/);
		h.clock.advance(600_000);
		expect(h.sent).toHaveLength(1);
		// A disabled loop is still managed, so the break tool stays available.
		expect(h.tools).toContain(BREAK_TOOL_NAME);

		const before = h.selects.length;
		h.queueSelect("Task 1", "Enable");
		await h.invokeCommand("");
		// The action selector for a paused loop offers Enable, not Disable.
		expect(h.selects[before + 1]!.rows).toEqual(["Enable", "Run now", "Remove", "Back"]);
		expect(h.notifications.at(-1)!.message).toMatch(/Enabled Task 1/);
		h.clock.advance(300_000);
		expect(h.sent).toHaveLength(2);
	});

	it("runs a loop immediately from the panel without moving its schedule", async () => {
		const h = await startedHarness();
		const scheduled = (h.entries.at(-1)!.data as { loops: { nextAt: number }[] }).loops[0]!.nextAt;

		h.queueSelect("Task 1", "Run now");
		await h.invokeCommand("");

		expect(h.selects[1]!.rows).toEqual(["Disable", "Run now", "Remove", "Back"]);
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1]).toContain("check the deploy");
		expect(h.notifications.at(-1)!.message).toMatch(/Ran Task 1 now/);
		const after = (h.entries.at(-1)!.data as { loops: { nextAt: number }[] }).loops[0]!.nextAt;
		expect(after, "a manual run must not reschedule the loop").toBe(scheduled);

		// The clock keeps its own rhythm: the next scheduled iteration is still one interval away.
		h.clock.advance(299_999);
		expect(h.sent).toHaveLength(2);
		h.clock.advance(1);
		expect(h.sent).toHaveLength(3);
	});

	it("skips a manual run while the agent is busy and says so", async () => {
		const h = await startedHarness();
		h.setBusy(true);

		h.queueSelect("Task 1", "Run now");
		await h.invokeCommand("");

		expect(h.sent, "a manual run must not queue behind a running turn").toHaveLength(1);
		expect(h.notifications.at(-1)!.message).toMatch(/still running/);
	});

	it("leaves everything alone when the panel is dismissed", async () => {
		const h = await startedHarness();
		// No queued answer: the fake resolves undefined, which is what Esc does.
		await h.invokeCommand("");
		expect(h.sent).toHaveLength(1);
		expect(h.tools).toContain(BREAK_TOOL_NAME);
		expect(h.clock.pending).toBeGreaterThan(0);
	});

	it("disposes an open panel when the session goes away", async () => {
		// pi hides an overlay on teardown but does not dispose the component, so the panel's repaint
		// timer would otherwise tick for the rest of the process, redrawing a loop from a session
		// that no longer exists.
		const h = await startedHarness();
		let repaintsAfterShutdown = 0;
		h.setOnDialogOpen(async () => {
			await h.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
			// A minute of ticks: a timer that outlived the session would repaint on every one.
			const before = h.repaints.length;
			h.clock.advance(60_000);
			repaintsAfterShutdown = h.repaints.length - before;
		});

		h.queueSelect("Close");
		await h.invokeCommand("");

		expect(repaintsAfterShutdown, "an open panel's timer must not outlive the session").toBe(0);
	});

	it("still shows the loop when the footer refresh is switched off", async () => {
		// `statusRefreshMs: 0` used to skip the compose step entirely, so a running loop was absent
		// from the footer rather than merely undated.
		const h = makeHarness({ settings: { statusRefreshMs: 0 } });
		await h.sessionStart();
		await h.invokeCommand("10s check the deploy");

		const status = h.statuses.filter(Boolean).at(-1);
		expect(status, "the footer must still report a running loop").toContain("LOOP Task 1");
		expect(status, "no countdown, because nothing will tick it").not.toContain("next");

		// Only the loop's own schedule is armed; there is no repaint timer.
		expect(h.clock.pending).toBe(1);
	});

	it("clears the footer when the last loop is removed", async () => {
		// Removal is the ordinary end of a loop, and the footer is the only always-visible signal
		// that one is armed. Leaving the countdown up after the loop is gone is a lie.
		const h = await startedHarness();
		expect(h.statuses.at(-1)).toBeDefined();

		h.queueSelect("Task 1", "Remove");
		await h.invokeCommand("");

		expect(h.clock.pending).toBe(0);
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	it("clears the footer when a loop expires", async () => {
		const h = makeHarness({ settings: { expireAfterMs: 60_000 } });
		await h.sessionStart();
		await h.invokeCommand("30s check the deploy");
		expect(h.statuses.at(-1)).toBeDefined();

		h.clock.advance(60_000);
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	it("says nothing is running instead of opening an empty panel", async () => {
		const h = makeHarness();
		await h.sessionStart();
		await h.invokeCommand("");
		expect(h.selects).toHaveLength(0);
		expect(h.notifications.at(-1)!.message).toBe("No loops are running.");
	});

	it("shows only the current session's loops, and none after a switch", async () => {
		const h = await startedHarness();
		expect(h.selects).toHaveLength(0);

		// Switching away and back: the loop belonged to the conversation that started it, so the
		// panel must be empty rather than offering a loop that no longer exists.
		await h.emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
		await h.sessionStart([], "resume");
		// No dialog is opened at all, so nothing is queued for one.
		await h.invokeCommand("");

		expect(h.selects).toHaveLength(0);
		expect(h.notifications.at(-1)!.message).toBe("No loops are running.");
	});

	it("falls back to the usage text without a UI", async () => {
		const h = await startedHarness();
		h.setNoUI(true);
		await h.invokeCommand("");
		expect(h.selects).toHaveLength(0);
		expect(h.notifications.at(-1)!.message).toContain("Usage: /loop");
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

	it("reports an agent pause as information, not a warning", async () => {
		// `loop_break` is the designed way a loop ends — done, or blocked on an answer — so pausing
		// is a normal outcome, not a malfunction. pi renders a "warning" notification with a
		// "Warning:" prefix, which makes a loop that stopped exactly as intended look broken.
		const h = await startedHarness();
		h.activateTool(BREAK_TOOL_NAME);
		await h.invokeTool({ reason: "the user asked me to exit the loop" });

		const pauseNotices = h.notifications.filter((n) => /paused/.test(n.message));
		expect(pauseNotices.length).toBeGreaterThan(0);
		expect(pauseNotices.at(-1)!.level).toBe("info");
	});

	it("shows a task's instruction on its own page, not on the list", async () => {
		const h = await startedHarness();
		h.queueSelect("Task 1", "Back");
		await h.invokeCommand("");

		const list = h.selects[0]!;
		const detail = h.selects[1]!;
		expect(list.body.join(String.fromCharCode(10)), "the list is rows only").not.toContain("check the deploy");
		expect(detail.title).toContain("Task 1");
		expect(detail.body.join(String.fromCharCode(10))).toContain("Instruction");
		expect(detail.body.join(String.fromCharCode(10))).toContain("check the deploy");
	});

	it("removes the loop when the model reports it is done", async () => {
		// Two shapes of ending: waiting for the user (resumable) and finished (final). Without the
		// second, "I fixed it, nothing left to do" had to borrow the pause, and the user's next
		// "thanks" restarted the whole loop.
		const h = await startedHarness();
		h.activateTool(BREAK_TOOL_NAME);

		const result = await h.invokeTool({ reason: "all defects fixed", outcome: "done" });
		expect(result.details.paused).toEqual([]);
		expect(result.details.finished).toEqual(["l1"]);
		expect(h.entries.at(-1)!.data).toMatchObject({ loops: [] });
		expect(h.tools, "no loop left, so loop_break is withdrawn").not.toContain(BREAK_TOOL_NAME);
		expect(h.clock.pending).toBe(0);

		// A reply afterwards must not resurrect it.
		await h.emit("input", { type: "input", text: "thanks!", source: "interactive" });
		expect((h.entries.at(-1)!.data as { loops: unknown[] }).loops).toEqual([]);
		h.clock.advance(30 * 60_000);
		expect(h.sent).toHaveLength(1);
	});

	it("keeps waiting-loops resumable while a finished one is removed", async () => {
		const h = makeHarness();
		await h.sessionStart();
		await h.invokeCommand("5m first");
		await h.invokeCommand("5m second");
		h.activateTool(BREAK_TOOL_NAME);

		const result = await h.invokeTool({ reason: "done with this one", outcome: "done", id: "l1" });
		expect(result.details.finished).toEqual(["l1"]);
		const loops = (h.entries.at(-1)!.data as { loops: { id: string }[] }).loops;
		expect(loops.map((loop) => loop.id), "l2 must not be removed").toEqual(["l2"]);
	});

	it("defaults to waiting when the model gives no outcome", async () => {
		const h = await startedHarness();
		h.activateTool(BREAK_TOOL_NAME);
		const result = await h.invokeTool({ reason: "need a decision" });
		expect(result.details.paused).toEqual(["l1"]);
		expect(result.details.finished).toEqual([]);
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

	it("restores loops on /reload without firing them", async () => {
		const branch = [
			{
				type: "custom",
				customType: "pi-loop-state",
				data: { counter: 3, loops: [{ id: "l3", prompt: "restored task", intervalMs: 60_000, createdAt: 0, runs: 5, skips: 0, consecutiveSkips: 0, nextAt: 0 }] },
			},
		];
		const h = makeHarness({ branch });
		await h.sessionStart(branch, "reload");
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

	it.each(["startup", "new", "resume", "fork"] as const)(
		"does not resurrect loops when a session starts with reason %s",
		async (reason) => {
			// A loop belongs to the conversation that started it. Reopening that conversation — or
			// switching to another one that once had loops — must not restart the schedule.
			const branch = [
				{
					type: "custom",
					customType: "pi-loop-state",
					data: { counter: 3, loops: [{ id: "l3", prompt: "old task", intervalMs: 60_000, createdAt: 0, runs: 5, skips: 0, consecutiveSkips: 0, nextAt: 0 }] },
				},
			];
			const h = makeHarness({ branch });
			await h.sessionStart(branch, reason);

			expect(h.sent).toHaveLength(0);
			expect(h.tools).not.toContain(BREAK_TOOL_NAME);
			expect(h.clock.pending).toBe(0);
			h.clock.advance(10 * 60_000);
			expect(h.sent).toHaveLength(0);
		},
	);

	it.each(["quit", "reload", "new", "resume", "fork"] as const)(
		"drops the schedule and the footer when the session shuts down for %s",
		async (reason) => {
			const h = await startedHarness();
			expect(h.statuses.at(-1)).toBeDefined();
			await h.emit("session_shutdown", { type: "session_shutdown", reason });
			expect(h.clock.pending).toBe(0);
			// The footer is cleared, so a dying loop cannot leave a countdown in the next session.
			expect(h.statuses.at(-1)).toBeUndefined();
			// Nothing may fire into the conversation that is being replaced.
			h.clock.advance(10 * 60_000);
			expect(h.sent).toHaveLength(1);
		},
	);

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

	it("survives a stale context that throws from notify, not just from isIdle", async () => {
		// A skip notifies, so `notify` is reachable from the timer too. If it throws, the whole
		// process sees an uncaught exception from a setTimeout.
		const h = await startedHarness();
		h.setBusy(true);
		h.stale = true;
		expect(() => h.clock.advance(300_000)).not.toThrow();
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

	it("repaints the footer only when the displayed value changes", async () => {
		// The footer is background information. A tick that redraws an unchanged number is flicker
		// competing with whatever the user is reading, so the timer targets the next grid mark
		// (:00/:15/:30/:45) rather than running on a blind cadence.
		const h = await startedHarness();
		const before = h.statuses.length;

		// One second in, the shown value has not changed, so nothing was repainted.
		h.clock.advance(1_000);
		expect(h.statuses.length, "no repaint for an unchanged number").toBe(before);

		// The next mark is 14s away (5m - 1s), and crossing it does repaint.
		h.clock.advance(13_000);
		expect(h.statuses.length).toBe(before);
		h.clock.advance(1_000);
		expect(h.statuses.length, "the countdown crossed a mark").toBeGreaterThan(before);
		expect(h.statuses.filter(Boolean).at(-1)).toContain("next 4m45s");
	});

	it("never shows a value that skips a mark", async () => {
		// Walking the countdown one mark at a time must produce every step, not a jump from 5m to 4m.
		const h = await startedHarness();
		const seen: string[] = [];
		for (let step = 0; step < 8; step++) {
			const status = h.statuses.filter(Boolean).at(-1);
			if (status) seen.push(/next [^·]+/.exec(status)?.[0].trim() ?? "");
			h.clock.advance(15_000);
		}
		expect(seen.filter(Boolean)).toEqual([
			"next 5m",
			"next 4m45s",
			"next 4m30s",
			"next 4m15s",
			"next 4m",
			"next 3m45s",
			"next 3m30s",
			"next 3m15s",
		]);
	});

	it("registers no turn_end handler, so it never depends on that boundary", async () => {
		const h = await startedHarness();
		expect(h.registeredEvents).not.toContain("turn_end");
	});
});
