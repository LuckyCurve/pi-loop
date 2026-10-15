/** Injectable clock so the scheduler is deterministic under test. */

export interface Clock {
	now(): number;
	setTimer(fn: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimer: (fn, delayMs) => {
		const handle = setTimeout(fn, delayMs);
		// Do not keep the pi process alive just for a loop timer.
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
