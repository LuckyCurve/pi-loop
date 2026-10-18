/** Compact footer status for running loops. */

import { footerCountdown } from "./duration.ts";
import { loopCadence, loopLabel, type LoopRecord } from "./engine.ts";

/**
 * The theme roles the footer uses. Named here rather than passed as theme objects so this module
 * stays free of pi: the caller supplies a painter and decides what a role means.
 */
export type StatusRole = "accent" | "muted" | "dim";

export interface StatusOptions {
	/**
	 * Include the time until the next run. False when the footer is not repainted on a timer, since
	 * a countdown nothing ticks keeps claiming a time that has already passed.
	 */
	countdown?: boolean;
	/**
	 * Paint a run of text for the active pi theme. Without it the line is plain text, which is what
	 * RPC mode needs: an escape code there is a literal byte in a JSON status string.
	 */
	paint?: (role: StatusRole, text: string) => string;
}

/**
 * The footer is the only always-visible signal that a loop is armed, so it leads with the word
 * LOOP: `⟳` alone is too easy to mistake for a background spinner.
 */
export function composeStatus(
	loops: readonly LoopRecord[],
	now: number,
	options: StatusOptions = {},
): string | undefined {
	if (loops.length === 0) return undefined;
	const paint = options.paint ?? ((_role: StatusRole, text: string) => text);
	const active = loops.filter((loop) => !loop.paused);
	const paused = loops.filter((loop) => loop.paused);

	if (active.length === 0) {
		const causes = [...new Set(paused.map((loop) => loop.paused))].join(", ");
		return `${paint("muted", `LOOP ${paused.length} paused`)}${paint("dim", ` (${causes})`)}`;
	}

	const next = active.reduce((earliest, loop) => (loop.nextAt < earliest.nextAt ? loop : earliest), active[0]!);
	// `loopCadence`, not a bare interval: a self-paced loop's interval is only its fallback, and
	// `every 5m` in the footer while the panel says `dynamic` describes one loop two ways.
	const parts = [
		`${paint("accent", "⟳")} ${paint("muted", `LOOP ${loopLabel(next.id)}`)}`,
		paint("dim", loopCadence(next)),
	];
	// Snapped to the footer grid, so the value changes on :00/:15/:30/:45 rather than every second.
	if (options.countdown !== false) parts.push(paint("dim", footerCountdown(next.nextAt - now)));
	if (next.runs > 0) parts.push(paint("dim", `runs ${next.runs}`));
	if (next.skips > 0) parts.push(paint("dim", `skips ${next.skips}`));
	// Only the other *running* loops. Counting paused ones here too reported the same loop twice and
	// made a two-loop footer read like three.
	if (active.length > 1) parts.push(paint("dim", `+${active.length - 1} more`));
	if (paused.length > 0) parts.push(paint("dim", `${paused.length} paused`));
	return parts.join(paint("dim", " · "));
}
