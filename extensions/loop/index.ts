/**
 * pi-loop — recurring prompt loops for pi.
 *
 *   /loop 5m check the deploy          run the prompt every 5 minutes (first run immediately)
 *   /loop check CI every 20m           interval as a trailing clause
 *   /loop check the deploy             no interval: uses the default
 *   /loop list | /loop stop [id|all] | /loop pause [id|all] | /loop resume [id|all]
 *
 * Behaviour:
 * - An iteration is skipped (never queued) while the agent is running, so a loop cannot pile
 *   up work behind a long turn.
 * - The model can stop a loop with the `loop_break` tool: the loop is paused instead of
 *   deleted, the reason is recorded, and the user's next message resumes it automatically.
 * - Loops live for the session, survive `/reload` through a session entry, and expire after
 *   `expireAfterMs` (7 days by default).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDuration } from "../../src/duration.ts";
import { formatInjection, formatLoopLine, isLoopInjection, parseLoopCommand, usageText } from "../../src/commands.ts";
import { type Clock, systemClock } from "../../src/clock.ts";
import { DEFAULT_EXPIRE_MS, DEFAULT_MAX_LOOPS, LoopEngine, type LoopRecord, type NotifyLevel } from "../../src/engine.ts";
import { composeStatus } from "../../src/status.ts";

const STATE_TYPE = "pi-loop-state";
const STATUS_KEY = "pi-loop";
export const BREAK_TOOL_NAME = "loop_break";

export interface LoopSettings {
	/** Interval used by `/loop <prompt>` without an explicit interval. */
	defaultIntervalMs: number;
	/** Consecutive skipped iterations before a loop removes itself. 0 = never. */
	maxConsecutiveSkips: number;
	/** Loop lifetime in ms. 0 = never expires. */
	expireAfterMs: number;
	/** Maximum concurrent loops. */
	maxLoops: number;
	/** Notify on every skipped iteration instead of once per streak. */
	notifyEverySkip: boolean;
	/** Footer countdown refresh cadence in ms. 0 disables it. */
	statusRefreshMs: number;
}

export const DEFAULT_SETTINGS: LoopSettings = {
	defaultIntervalMs: 10 * 60_000,
	maxConsecutiveSkips: 0,
	expireAfterMs: DEFAULT_EXPIRE_MS,
	maxLoops: DEFAULT_MAX_LOOPS,
	notifyEverySkip: false,
	statusRefreshMs: 15_000,
};

export interface LoopExtensionOptions {
	clock?: Clock;
	/** Test seam: overrides the values read from settings. */
	settings?: Partial<LoopSettings>;
}

/** The shape read from the `piLoop` block in `settings.json`. */
type RawLoopSettings = Partial<Record<keyof LoopSettings, unknown>>;

/** `piLoop` block from merged settings, with per-key validation and defaults. */
export function readSettings(pi: ExtensionAPI, overrides: Partial<LoopSettings> = {}): LoopSettings {
	const raw = ((pi.getSettings?.() as { piLoop?: RawLoopSettings } | undefined)?.piLoop ?? {}) as RawLoopSettings;
	const num = (key: keyof LoopSettings, fallback: number, min: number): number => {
		const value = overrides[key] ?? raw[key];
		return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
	};
	return {
		defaultIntervalMs: num("defaultIntervalMs", DEFAULT_SETTINGS.defaultIntervalMs, 1_000),
		maxConsecutiveSkips: num("maxConsecutiveSkips", DEFAULT_SETTINGS.maxConsecutiveSkips, 0),
		expireAfterMs: num("expireAfterMs", DEFAULT_SETTINGS.expireAfterMs, 0),
		maxLoops: num("maxLoops", DEFAULT_SETTINGS.maxLoops, 1),
		notifyEverySkip: (overrides.notifyEverySkip ?? raw.notifyEverySkip) === true,
		statusRefreshMs: num("statusRefreshMs", DEFAULT_SETTINGS.statusRefreshMs, 0),
	};
}

export function createLoopExtension(options: LoopExtensionOptions = {}) {
	const clock = options.clock ?? systemClock;

	return function loopExtension(pi: ExtensionAPI): void {
		let engine: LoopEngine | undefined;
		let settings: LoopSettings = { ...DEFAULT_SETTINGS };
		let ctxRef: ExtensionContext | undefined;
		let statusTimer: unknown;
		let lastStatus: string | undefined;
		let refreshing = false;
		let lastNotifyAt = 0;
		let lastNotifyMessage = "";

		function notify(message: string, level: NotifyLevel): void {
			// Suppress identical messages within 5s: several loops can skip in the same pass.
			const now = clock.now();
			if (message === lastNotifyMessage && now - lastNotifyAt < 5_000) return;
			lastNotifyMessage = message;
			lastNotifyAt = now;
			ctxRef?.ui.notify(message, level);
		}

		/**
		 * `loop_break` is only declared to the model while a loop exists.
		 *
		 * A run that is already in flight snapshots its tool loadout and re-applies it when it builds
		 * the request (pi's `_preparePromptAndToolLoadout`), which can resurrect the tool after the loop
		 * that justified it is gone. Re-assert the intended state on every turn boundary so the model's
		 * tool list matches reality rather than a snapshot taken before the loop ended.
		 */
		function syncToolActivation(): void {
			if (!engine) return;
			try {
				const active = pi.getActiveTools();
				const present = active.includes(BREAK_TOOL_NAME);
				const wanted = !engine.isEmpty();
				if (wanted && !present) pi.setActiveTools([...active, BREAK_TOOL_NAME]);
				else if (!wanted && present) pi.setActiveTools(active.filter((name) => name !== BREAK_TOOL_NAME));
			} catch {
				// Best effort: never let activation break loop bookkeeping or a scheduling callback.
			}
		}

		function persist(): void {
			if (!engine) return;
			try {
				pi.appendEntry(STATE_TYPE, engine.toJSON());
			} catch {
				// A stale session is already shutting down; the snapshot no longer matters.
			}
		}

		function refreshStatus(): void {
			if (!engine || refreshing || !ctxRef) return;
			refreshing = true;
			try {
				const status = composeStatus(engine.list(), clock.now());
				if (status !== lastStatus) {
					lastStatus = status;
					const ctx = ctxRef;
					if (ctx.mode === "tui" || ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, status);
				}
			} catch {
				// A stale context means the session is gone; drop the engine with it.
				disposeEngine();
			} finally {
				refreshing = false;
			}
		}

		function armStatusTimer(): void {
			disarmStatusTimer();
			if (!engine || engine.isEmpty() || settings.statusRefreshMs <= 0 || ctxRef?.mode !== "tui") return;
			statusTimer = clock.setTimer(() => {
				statusTimer = undefined;
				syncStatusTimer();
			}, settings.statusRefreshMs);
		}

		/** Refresh the countdown now and keep it fresh only while a loop is running. */
		function syncStatusTimer(): void {
			if (!engine || engine.isEmpty() || settings.statusRefreshMs <= 0) {
				disarmStatusTimer();
				return;
			}
			refreshStatus();
			armStatusTimer();
		}

		function disarmStatusTimer(): void {
			if (statusTimer === undefined) return;
			clock.clearTimer(statusTimer);
			statusTimer = undefined;
		}

		/**
		 * Whether a run, compaction, retry, or branch summary is active. A stale context — the session
		 * was replaced, reloaded, or disposed while a timer was armed — counts as busy and shuts the
		 * engine down, instead of throwing out of a timer callback where nobody can catch it.
		 */
		function isBusy(): boolean {
			if (!ctxRef) return true;
			try {
				return !ctxRef.isIdle() || ctxRef.hasPendingMessages();
			} catch {
				disposeEngine();
				return true;
			}
		}

		/** Drop the engine and its timers; safe to call repeatedly. */
		function disposeEngine(): void {
			disarmStatusTimer();
			engine?.dispose();
			engine = undefined;
		}

		function createEngine(ctx: ExtensionContext): LoopEngine {
			ctxRef = ctx;
			return new LoopEngine(
				{
					isBusy,
					inject: (loop: LoopRecord) => {
						pi.sendUserMessage(
							formatInjection(loop.prompt, {
								id: loop.id,
								intervalText: formatDuration(loop.intervalMs),
								run: loop.runs,
							}),
							// A loop owns its iteration: no template expansion, so a prompt
							// that starts with `/` cannot re-enter a slash command by accident.
							{ expandPromptTemplates: false },
						);
					},
					onChange: (reason) => {
						if (!engine) return;
						syncToolActivation();
						// Only structural changes need to survive a reload; run/skip counts are cosmetic.
						if (reason !== "run" && reason !== "skip") persist();
						syncStatusTimer();
					},
					notify,
				},
				{
					clock,
					defaultIntervalMs: settings.defaultIntervalMs,
					maxConsecutiveSkips: settings.maxConsecutiveSkips,
					expireAfterMs: settings.expireAfterMs,
					maxLoops: settings.maxLoops,
					notifyEverySkip: settings.notifyEverySkip,
				},
			);
		}

		// ---------------------------------------------------------------- lifecycle

		/**
		 * The engine is created on demand instead of only in `session_start`: the SDK and print modes
		 * can run a session without ever emitting that event, and `/loop` must still work there.
		 */
		function ensureEngine(ctx: ExtensionContext): LoopEngine {
			settings = readSettings(pi, options.settings);
			if (!engine) {
				ctxRef = ctx;
				engine = createEngine(ctx);
				restoreFromBranch(ctx);
			}
			return engine;
		}

		/** Reload loops from the active branch, so abandoned branches never resurrect them. */
		function restoreFromBranch(ctx: ExtensionContext): void {
			if (!engine) return;
			let snapshot: unknown;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === STATE_TYPE) snapshot = entry.data;
			}
			// Overdue loops (e.g. after a long pause) wait one interval instead of firing at once.
			const restored = engine.restore(snapshot as { counter?: number; loops?: LoopRecord[] } | undefined, {
				reschedule: "interval",
			});
			if (restored > 0) notify(`Restored ${restored} loop(s).`, "info");
			syncToolActivation();
			syncStatusTimer();
		}

		pi.on("session_start", async (_event, ctx) => {
			ctxRef = ctx;
			settings = readSettings(pi, options.settings);
			disposeEngine();
			engine = createEngine(ctx);
			lastStatus = undefined;
			restoreFromBranch(ctx);
		});

		pi.on("session_shutdown", async () => {
			disposeEngine();
			ctxRef = undefined;
		});

		// ------------------------------------------------------------ user commands

		pi.registerCommand("loop", {
			description: "Run a prompt repeatedly (e.g. /loop 5m check the deploy); skips while the agent is busy",
			getArgumentCompletions: (prefix) => {
				const words = ["list", "stop", "pause", "resume", "5m ", "10m ", "30m ", "1h "];
				const ids = (engine?.list() ?? []).map((loop) => `${loop.id} `);
				return [...words, ...ids]
					.filter((word) => word.startsWith(prefix))
					.map((value) => ({ value, label: value.trim() }));
			},
			handler: async (args, ctx) => {
				ctxRef = ctx;
				const engineRef = ensureEngine(ctx);
				const command = parseLoopCommand(args, settings.defaultIntervalMs);

				switch (command.kind) {
					case "usage": {
						const text = command.error
							? `${command.error}\n\n${usageText(settings.defaultIntervalMs)}`
							: usageText(settings.defaultIntervalMs);
						if (ctx.hasUI) ctx.ui.setEditorText(text);
						else ctx.ui.notify(text, command.error ? "warning" : "info");
						return;
					}
					case "list": {
						const loops = engineRef.list();
						const selected = command.target ? loops.filter((loop) => loop.id === command.target) : loops;
						if (selected.length === 0) {
							ctx.ui.notify(command.target ? `No loop with id ${command.target}.` : "No loops are running.", "info");
							return;
						}
						const now = clock.now();
						const lines = selected.map((loop) => formatLoopLine(loop, now));
						if (ctx.hasUI) ctx.ui.setEditorText(lines.join("\n\n"));
						else ctx.ui.notify(lines.join("\n"), "info");
						return;
					}
					case "stop": {
						const removed = engineRef.stop(command.target);
						ctx.ui.notify(
							removed === 0 ? `No loop with id ${command.target}.` : `Stopped ${removed} loop(s).`,
							removed === 0 ? "warning" : "info",
						);
						return;
					}
					case "pause": {
						const paused = engineRef.pause(command.target, "user");
						ctx.ui.notify(
							paused === 0 ? `No running loop with id ${command.target}.` : `Paused ${paused} loop(s).`,
							paused === 0 ? "warning" : "info",
						);
						return;
					}
					case "resume": {
						const resumed = engineRef.resume(command.target);
						ctx.ui.notify(
							resumed.length === 0
								? `No paused loop with id ${command.target}.`
								: `Resumed ${resumed.length} loop(s).`,
							resumed.length === 0 ? "warning" : "info",
						);
						return;
					}
					case "start": {
						try {
							const loop = engineRef.start({ prompt: command.prompt, intervalMs: command.intervalMs });
							const total = engineRef.list().length;
							ctx.ui.notify(
								`Loop ${loop.id} started: every ${command.intervalText}${total > 1 ? ` (${total} running)` : ""}.`,
								"info",
							);
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						}
						return;
					}
				}
			},
		});

		// ------------------------------------------------------ model-facing control

		pi.registerTool({
			name: BREAK_TOOL_NAME,
			label: "Break loop",
			description:
				"Pause the recurring /loop that started the current turn and hand control back to the user. Use it when the iteration cannot proceed without information only the user has: put the questions in `reason`, then ask them in your reply. The loop is paused, not deleted; the user's next message resumes it.",
			promptSnippet: "Pause the active /loop and wait for the user",
			promptGuidelines: [
				"Call `loop_break` instead of continuing a /loop iteration when the requirements are unclear, a decision needs approval, or you would otherwise have to guess.",
				"After calling `loop_break`, ask your questions in the reply and stop working on the loop task.",
			],
			parameters: Type.Object({
				reason: Type.String({ description: "Why the loop cannot continue, including the questions for the user" }),
				id: Type.Optional(Type.String({ description: "Loop id to break; defaults to the loop that started this turn" })),
			}),
			defaultActive: false,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const active = ensureEngine(ctx);
				if (!active || active.isEmpty()) {
					return {
						content: [{ type: "text", text: "No loop is running, so nothing was paused." }],
						details: { paused: [] as string[], reason: params.reason },
					};
				}
				const target = params.id ?? active.lastFired?.id ?? "all";
				const paused = active.pause(target, "agent", params.reason);
				if (paused === 0) {
					return {
						content: [{ type: "text", text: `No running loop matched ${target}; nothing was paused.` }],
						details: { paused: [] as string[], reason: params.reason },
					};
				}
				const ids = active
					.list()
					.filter((loop) => loop.paused === "agent")
					.map((loop) => loop.id);
				ctx.ui.notify(`Loop ${ids.join(", ")} paused: ${params.reason}`, "warning");
				return {
					content: [
						{
							type: "text",
							text: `Paused loop ${ids.join(", ")}. Ask the user the questions from your reason and end this turn; the user's next message resumes the loop.`,
						},
					],
					details: { paused: ids, reason: params.reason },
				};
			},
		});

		// A real user message releases loops the agent paused. Loop injections arrive as
		// extension-sourced input, so they never count as the user's answer.
		pi.on("input", async (event) => {
			if (event.source === "extension") return;
			if (isLoopInjection(event.text)) return;
			const active = engine;
			if (!active || active.agentPaused.length === 0) return;
			const resumed = active.resume("all", "agent");
			if (resumed.length > 0) notify(`Resumed ${resumed.length} loop(s) after your reply.`, "info");
		});

		// The footer countdown is refreshed by the status timer and on every engine change, so this
		// extension deliberately registers no `turn_end` handler: that boundary is a heavier path in pi
		// (it needs a persisted assistant entry), and the tool set is re-asserted at run start instead.
		//
		// Re-assert here rather than on change only: a run that was already in flight when the loop
		// ended re-applies its pre-end loadout snapshot while building the request, which would
		// otherwise put `loop_break` back in front of the model after the loop it belonged to is gone.
		pi.on("agent_start", async () => {
			syncToolActivation();
		});
	};
}

export default createLoopExtension();
