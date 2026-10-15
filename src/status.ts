/** Compact footer status for running loops. */

import { formatCountdown } from "./duration.ts";
import type { LoopRecord } from "./engine.ts";

export function composeStatus(loops: readonly LoopRecord[], now: number): string | undefined {
	if (loops.length === 0) return undefined;
	const active = loops.filter((loop) => !loop.paused);
	const paused = loops.filter((loop) => loop.paused);

	if (active.length === 0) {
		return `loop ${paused.length} paused${paused.some((loop) => loop.paused === "agent") ? " (agent)" : ""}`;
	}

	const next = active.reduce((earliest, loop) => (loop.nextAt < earliest.nextAt ? loop : earliest), active[0]!);
	const inMs = Math.max(0, next.nextAt - now);
	const parts = [`⟳ ${next.id} every ${formatCountdown(next.intervalMs)}`, `next ${formatCountdown(inMs)}`];
	if (next.runs > 0) parts.push(`runs ${next.runs}`);
	if (next.skips > 0) parts.push(`skips ${next.skips}`);
	if (loops.length > 1) parts.push(`+${loops.length - 1} more`);
	if (paused.length > 0) parts.push(`${paused.length} paused`);
	return parts.join(" · ");
}
