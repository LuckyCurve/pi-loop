/** Compact footer status for running loops. */

import { formatDuration, formatNextDue } from "./duration.ts";
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
	// `formatDuration`, not `formatCountdown`: the panel words intervals the same way, so a 1-day
	// loop reads `every 1d` on both surfaces instead of `1d` in one and `24h` in the other.
	const parts = [`⟳ LOOP ${next.id}`, `every ${formatDuration(next.intervalMs)}`, formatNextDue(next.nextAt - now)];
	if (next.runs > 0) parts.push(`runs ${next.runs}`);
	if (next.skips > 0) parts.push(`skips ${next.skips}`);
	// Only the other *running* loops. Counting paused ones here too reported the same loop twice and
	// made a two-loop footer read like three.
	if (active.length > 1) parts.push(`+${active.length - 1} more`);
	if (paused.length > 0) parts.push(`${paused.length} paused`);
	return parts.join(" · ");
}
