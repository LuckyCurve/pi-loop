/** Compact footer status for running loops. */

import { formatCountdown } from "./duration.ts";
import type { LoopRecord } from "./engine.ts";

/**
 * The footer is the only always-visible signal that a loop is armed, so it leads with the word
 * LOOP: `⟳` alone is too easy to mistake for a background spinner.
 */
export function composeStatus(loops: readonly LoopRecord[], now: number): string | undefined {
	if (loops.length === 0) return undefined;
	const active = loops.filter((loop) => !loop.paused);
	const paused = loops.filter((loop) => loop.paused);

	if (active.length === 0) {
		const causes = [...new Set(paused.map((loop) => loop.paused))].join(", ");
		return `LOOP ${paused.length} paused (${causes})`;
	}

	const next = active.reduce((earliest, loop) => (loop.nextAt < earliest.nextAt ? loop : earliest), active[0]!);
	const parts = [`⟳ LOOP ${next.id}`, `every ${formatCountdown(next.intervalMs)}`, `next ${formatCountdown(Math.max(0, next.nextAt - now))}`];
	if (next.runs > 0) parts.push(`runs ${next.runs}`);
	if (next.skips > 0) parts.push(`skips ${next.skips}`);
	if (loops.length > 1) parts.push(`+${loops.length - 1} more`);
	if (paused.length > 0) parts.push(`${paused.length} paused`);
	return parts.join(" · ");
}
