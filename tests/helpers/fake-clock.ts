import type { Clock } from "../../src/clock.ts";

/**
 * Deterministic clock: time only moves when the test says so. Shared because the engine, the
 * extension, and the panel all need to be driven through the same elapsed-time story.
 */
export class FakeClock implements Clock {
	time: number;
	private nextHandle = 1;
	private timers = new Map<number, { at: number; fn: () => void }>();

	constructor(startAt = 0) {
		this.time = startAt;
	}

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

	/** Advance time, firing due timers in order. */
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
