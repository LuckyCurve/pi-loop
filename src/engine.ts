/**
 * The loop engine.
 *
 * Owns interval bookkeeping for every running loop in the session. It never talks to pi
 * directly: the host supplies idleness, prompt injection, notifications, and UI refresh,
 * which keeps the scheduling rules deterministic and testable.
 */

import { type Clock, systemClock } from "./clock.ts";

export type LoopPauseCause = "agent" | "user";

export interface LoopRecord {
	/** Stable short id, e.g. `l1`. */
	id: string;
	/** The prompt injected on every iteration. */
	prompt: string;
	/** Interval in milliseconds. */
	intervalMs: number;
	createdAt: number;
	runs: number;
	/** Iterations that were due while the agent was busy. */
	skips: number;
	consecutiveSkips: number;
	lastRunAt?: number;
	lastSkipAt?: number;
	/** When this loop is next due. */
	nextAt: number;
	/** Set while the loop is blocked. */
	paused?: LoopPauseCause;
	breakReason?: string;
}

export type NotifyLevel = "info" | "warning" | "error";

/** Outcome of `runNow`: unknown loop, agent busy, or an iteration was delivered. */
export type RunNowOutcome = "ran" | "busy" | "missing";

export interface LoopEngineHost {
	/** The agent is mid-run (streaming, compacting, retrying, or has queued work). */
	isBusy(): boolean;
	/** Deliver one iteration of `record` to the agent. */
	inject(record: LoopRecord): void;
	/** Loop set or counts changed; refresh status UI and persisted state. */
	onChange(reason: "add" | "remove" | "run" | "skip" | "pause" | "resume" | "expire"): void;
	notify(message: string, level: NotifyLevel): void;
	/** Fires before an iteration is injected, letting the host record a transcript marker. */
	onBeforeInject?(record: LoopRecord): void;
}

export interface LoopEngineOptions {
	clock?: Clock;
	/** Interval used when the user supplies none. */
	defaultIntervalMs: number;
	/** Skipping this many consecutive iterations removes the loop. 0 = unlimited. */
	maxConsecutiveSkips?: number;
	/** Loops expire this long after creation. 0 = never. */
	expireAfterMs?: number;
	/** Upper bound on concurrent loops. */
	maxLoops?: number;
	/** Notify on every skip instead of only the first of a streak. */
	notifyEverySkip?: boolean;
}

export interface StartLoopInput {
	prompt: string;
	intervalMs: number;
	now?: number;
}

export const DEFAULT_MAX_LOOPS = 20;
export const DEFAULT_EXPIRE_MS = 7 * 24 * 60 * 60 * 1_000;
/**
 * When several loops come due in the same pass, only one run is started (a second prompt would be
 * queued into the run that just started). The others are retried after this delay instead of
 * counting a busy skip, so transient contention does not penalize them.
 */
export const CONTENTION_RETRY_MS = 2_000;

export class LoopEngine {
	private readonly clock: Clock;
	private readonly host: LoopEngineHost;
	private readonly options: Required<Omit<LoopEngineOptions, "clock">>;

	private loops: LoopRecord[] = [];
	private counter = 0;
	private timer: unknown;
	private disposed = false;
	/** Loop whose iteration was injected most recently; `loop_break` acts on it. */
	private lastFiredId: string | undefined;

	constructor(host: LoopEngineHost, options: LoopEngineOptions) {
		this.clock = options.clock ?? systemClock;
		this.host = host;
		this.options = {
			defaultIntervalMs: options.defaultIntervalMs,
			maxConsecutiveSkips: options.maxConsecutiveSkips ?? 0,
			expireAfterMs: options.expireAfterMs ?? DEFAULT_EXPIRE_MS,
			maxLoops: options.maxLoops ?? DEFAULT_MAX_LOOPS,
			notifyEverySkip: options.notifyEverySkip ?? false,
		};
	}

	get defaultIntervalMs(): number {
		return this.options.defaultIntervalMs;
	}

	list(): LoopRecord[] {
		return [...this.loops].sort((a, b) => a.nextAt - b.nextAt || a.createdAt - b.createdAt);
	}

	get(id: string): LoopRecord | undefined {
		return this.loops.find((loop) => loop.id === id);
	}

	get lastFired(): LoopRecord | undefined {
		return this.lastFiredId === undefined ? undefined : this.get(this.lastFiredId);
	}

	isEmpty(): boolean {
		return this.loops.length === 0;
	}

	// ---------------------------------------------------------------- lifecycle

	start(input: StartLoopInput): LoopRecord {
		if (this.loops.length >= this.options.maxLoops) {
			throw new Error(
				`Cannot start another loop: ${this.loops.length} of ${this.options.maxLoops} are already running. Stop one with /loop stop <id>.`,
			);
		}
		const now = input.now ?? this.clock.now();
		const record: LoopRecord = {
			id: `l${++this.counter}`,
			prompt: input.prompt,
			intervalMs: Math.max(1, Math.round(input.intervalMs)),
			createdAt: now,
			runs: 0,
			skips: 0,
			consecutiveSkips: 0,
			// The first iteration runs immediately, like Claude Code's `/loop`.
			nextAt: now,
		};
		this.loops.push(record);
		this.host.onChange("add");
		this.fireDue(now);
		this.arm();
		return record;
	}

	/** Remove one loop, or every loop when `id` is `"all"`. Returns how many were removed. */
	stop(id: string): number {
		const before = this.loops.length;
		if (id === "all") {
			this.loops = [];
			this.lastFiredId = undefined;
		} else {
			this.loops = this.loops.filter((loop) => loop.id !== id);
			if (this.lastFiredId === id) this.lastFiredId = undefined;
		}
		const removed = before - this.loops.length;
		if (removed > 0) {
			this.host.onChange("remove");
			this.arm();
		}
		return removed;
	}

	/** Pause without removing. Paused loops stay listed and can be resumed. */
	pause(id: string, cause: LoopPauseCause, reason?: string): number {
		const targets = id === "all" ? this.loops : this.loops.filter((loop) => loop.id === id);
		let changed = 0;
		for (const loop of targets) {
			if (loop.paused) continue;
			loop.paused = cause;
			if (reason !== undefined) loop.breakReason = reason;
			changed++;
		}
		if (changed > 0) {
			this.host.onChange("pause");
			this.arm();
		}
		return changed;
	}

	/** Resume paused loops. `cause` limits which paused loops are resumed. */
	resume(id: string, cause?: LoopPauseCause): LoopRecord[] {
		const now = this.clock.now();
		const targets = (id === "all" ? this.loops : this.loops.filter((loop) => loop.id === id)).filter(
			(loop) => loop.paused !== undefined && (cause === undefined || loop.paused === cause),
		);
		for (const loop of targets) {
			loop.paused = undefined;
			loop.breakReason = undefined;
			loop.consecutiveSkips = 0;
			// Do not fire immediately: whatever the user answered is being handled now.
			loop.nextAt = now + loop.intervalMs;
		}
		if (targets.length > 0) {
			this.host.onChange("resume");
			this.arm();
		}
		return targets;
	}

	/**
	 * Run one iteration of a loop right now, off its schedule.
	 *
	 * This exists for the panel's "Run now": an iteration that was missed, or a nudge after a
	 * conversation left the loop alone. `nextAt`, the skip counters, and the paused state are all
	 * left untouched, so a manual run neither resets the rhythm nor hides an iteration that was
	 * skipped. A busy agent skips instead of queueing, exactly like a scheduled iteration.
	 */
	runNow(id: string, now = this.clock.now()): RunNowOutcome {
		if (this.disposed) return "missing";
		const loop = this.get(id);
		if (!loop) return "missing";
		if (this.host.isBusy()) return "busy";

		loop.runs++;
		// A real iteration ends a skip streak, the same as a scheduled run does.
		loop.consecutiveSkips = 0;
		loop.lastRunAt = now;
		this.lastFiredId = loop.id;
		this.host.onBeforeInject?.(loop);
		this.host.inject(loop);
		this.host.onChange("run");
		return "ran";
	}

	/** Loops paused by the agent, i.e. the ones a user reply should resume. */
	get agentPaused(): LoopRecord[] {
		return this.loops.filter((loop) => loop.paused === "agent");
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimer();
	}

	// ------------------------------------------------------------------ ticking

	/** Force a scheduling pass. Exposed for tests and for commands that need fresh state. */
	tick(now = this.clock.now()): void {
		this.clearTimer();
		this.fireDue(now);
		this.arm();
	}

	/** Next scheduled fire time, or undefined when nothing is armed. */
	get nextFireAt(): number | undefined {
		const active = this.loops.filter((loop) => !loop.paused);
		if (active.length === 0) return undefined;
		return Math.min(...active.map((loop) => loop.nextAt));
	}

	private fireDue(now: number): void {
		if (this.disposed) return;
		const due = this.loops
			.filter((loop) => !loop.paused && loop.nextAt <= now)
			.sort((a, b) => a.nextAt - b.nextAt || a.createdAt - b.createdAt);

		let served = false;
		for (const loop of due) {
			if (this.isExpired(loop, now)) {
				this.removeLoop(loop.id);
				this.host.notify(`Loop ${loop.id} expired after ${loop.runs} run(s); it was removed.`, "warning");
				this.host.onChange("expire");
				continue;
			}
			if (served) {
				// Another loop in this pass already started a run. Retry shortly without
				// counting a skip: the agent is busy because of us, not because of the user.
				loop.nextAt = now + CONTENTION_RETRY_MS;
				continue;
			}
			if (this.host.isBusy()) {
				loop.skips++;
				loop.consecutiveSkips++;
				loop.lastSkipAt = now;
				loop.nextAt = now + loop.intervalMs;
				if (loop.consecutiveSkips === 1 || this.options.notifyEverySkip) {
					this.host.notify(
						`Loop ${loop.id} skipped: the agent is still running${loop.consecutiveSkips > 1 ? ` (${loop.consecutiveSkips} in a row)` : ""}.`,
						"info",
					);
				}
				this.host.onChange("skip");
				if (!this.canSkipForever(loop)) {
					this.removeLoop(loop.id);
					this.host.notify(
						`Loop ${loop.id} stopped after ${loop.consecutiveSkips} consecutive skips.`,
						"warning",
					);
					this.host.onChange("remove");
				}
				continue;
			}
			loop.runs++;
			loop.consecutiveSkips = 0;
			loop.lastRunAt = now;
			loop.nextAt = now + loop.intervalMs;
			this.lastFiredId = loop.id;
			this.host.onBeforeInject?.(loop);
			this.host.inject(loop);
			this.host.onChange("run");
			served = true;
		}
		if (this.loops.length === 0) this.lastFiredId = undefined;
	}

	private canSkipForever(loop: LoopRecord): boolean {
		const max = this.options.maxConsecutiveSkips;
		return max <= 0 || loop.consecutiveSkips < max;
	}

	private isExpired(loop: LoopRecord, now: number): boolean {
		const ttl = this.options.expireAfterMs;
		return ttl > 0 && now - loop.createdAt >= ttl;
	}

	private removeLoop(id: string): void {
		this.loops = this.loops.filter((loop) => loop.id !== id);
		if (this.lastFiredId === id) this.lastFiredId = undefined;
	}

	private arm(): void {
		if (this.disposed) return;
		this.clearTimer();
		const nextAt = this.nextFireAt;
		if (nextAt === undefined) return;
		const delay = Math.max(0, Math.min(2_147_483_647, nextAt - this.clock.now()));
		this.timer = this.clock.setTimer(() => {
			this.timer = undefined;
			this.tick();
		}, delay);
	}

	private clearTimer(): void {
		if (this.timer === undefined) return;
		this.clock.clearTimer(this.timer);
		this.timer = undefined;
	}

	// --------------------------------------------------------------- persistence

	toJSON(): { counter: number; loops: LoopRecord[] } {
		return { counter: this.counter, loops: this.list() };
	}

	/**
	 * Replace engine state, e.g. after resuming a session. No iteration fires during restore.
	 * `reschedule: "now"` keeps overdue loops due immediately; `"interval"` waits one interval,
	 * which is what a session restore wants (no prompt burst right after startup or /reload).
	 */
	restore(
		state: { counter?: number; loops?: LoopRecord[] } | undefined,
		options: { reschedule?: "now" | "interval" } = {},
	): number {
		if (!state?.loops || state.loops.length === 0) return 0;
		const now = this.clock.now();
		const reschedule = options.reschedule ?? "now";
		const restored: LoopRecord[] = [];
		for (const raw of state.loops.slice(0, this.options.maxLoops)) {
			if (!raw || typeof raw.prompt !== "string" || !Number.isFinite(raw.intervalMs)) continue;
			const intervalMs = Math.max(1, Math.round(raw.intervalMs));
			restored.push({
				id: typeof raw.id === "string" ? raw.id : `l${restored.length + 1}`,
				prompt: raw.prompt,
				intervalMs,
				createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
				runs: Number.isFinite(raw.runs) ? raw.runs : 0,
				skips: Number.isFinite(raw.skips) ? raw.skips : 0,
				consecutiveSkips: 0,
				// An overdue loop fires once (no catch-up burst); a future one keeps its schedule.
				nextAt:
					reschedule === "interval"
						? now + intervalMs
						: Number.isFinite(raw.nextAt)
							? Math.max(now, Math.round(raw.nextAt))
							: now + intervalMs,
				...(raw.paused === "agent" || raw.paused === "user" ? { paused: raw.paused } : {}),
				...(typeof raw.breakReason === "string" ? { breakReason: raw.breakReason } : {}),
			});
		}
		this.loops = restored;
		this.counter = Math.max(
			Number.isFinite(state.counter) ? Number(state.counter) : 0,
			...restored.map((loop) => Number(loop.id.replace(/^l/, "")) || 0),
		);
		this.arm();
		return restored.length;
	}
}
