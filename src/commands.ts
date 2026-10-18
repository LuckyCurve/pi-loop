/**
 * `/loop` argument dispatch.
 *
 * The surface is deliberately two forms, and nothing else:
 *   /loop                     -> open the management panel (or the usage text without a UI)
 *   /loop [interval] <prompt> -> start a loop
 *
 * There are no subcommands. Managing a loop (see, disable, remove) happens in the panel, so there
 * is one place to look and no vocabulary to remember. The cost is that a prompt beginning with a
 * former verb is now always a prompt, which is the safer reading anyway.
 */

import { formatDuration, MAX_INTERVAL_MS, MIN_INTERVAL_MS, parseLoopArgs } from "./duration.ts";

export type LoopCommand =
	| {
			kind: "start";
			intervalMs: number;
			intervalText: string;
			/**
			 * `"fixed"` when the user named an interval. `"self"` when they did not: the model picks
			 * the wait between iterations, with `intervalMs` as the fallback, because someone asking
			 * for "keep checking this" usually cannot say how often is right.
			 */
			pacing: "fixed" | "self";
			prompt: string;
	  }
	| { kind: "panel" }
	| { kind: "usage"; error?: string };

export function parseLoopCommand(input: string, defaultIntervalMs: number): LoopCommand {
	const raw = input.trim();
	// A bare `/loop` opens the panel; the extension falls back to usage text without a UI.
	if (raw === "") return { kind: "panel" };

	const parsed = parseLoopArgs(raw);
	if (parsed.prompt === "") {
		return parsed.interval === undefined ? { kind: "panel" } : { kind: "usage", error: "missing prompt" };
	}
	return {
		kind: "start",
		intervalMs: parsed.interval?.ms ?? defaultIntervalMs,
		intervalText: parsed.interval?.text ?? formatDuration(defaultIntervalMs),
		pacing: parsed.interval === undefined ? "self" : "fixed",
		prompt: parsed.prompt,
	};
}

export function usageText(defaultIntervalMs: number): string {
	return [
		"Usage: /loop [interval] <prompt>",
		"",
		`  /loop 5m check the deploy        run the prompt every 5 minutes`,
		`  /loop check CI every 20m         interval as a trailing clause`,
		`  /loop check the deploy          no interval: you choose the wait each turn (${formatDuration(defaultIntervalMs)} if you say nothing)`,
		"  /loop                            see, disable, or remove running loops",
		"",
		`Intervals: Nms, Ns, Nm, Nh, Nd, clamped to ${formatDuration(MIN_INTERVAL_MS)} … ${formatDuration(MAX_INTERVAL_MS)}.`,
	].join("\n");
}

/**
 * Wrap the user's prompt so the transcript shows which loop produced it, and so the model
 * knows that reporting back is optional but stopping for user input is a tool call away.
 */
export function formatInjection(
	prompt: string,
	info: { id: string; intervalText: string; run: number; pacing?: "fixed" | "self" },
): string {
	// A self-paced loop must not announce a fixed cadence: the model would read it as a schedule it
	// has no say in, and would never call `loop_schedule`.
	const cadence = info.pacing === "self" ? "dynamic, you pick the next wait" : `every ${info.intervalText}`;
	const header = `[loop ${info.id} · run ${info.run} · ${cadence}]`;
	return `${header}\n${prompt}`;
}

const INJECTION_RE = /^\[loop l\d+ · run \d+ · (?:every [^\]]+|dynamic, you pick the next wait)\]/;

/**
 * Whether an input is a loop iteration rather than something the user typed. The `input` event
 * carries no origin flag for prompts sent by an extension, so the header identifies them.
 */
export function isLoopInjection(text: string): boolean {
	return INJECTION_RE.test(text.trimStart());
}
