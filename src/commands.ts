/**
 * `/loop` argument dispatch.
 *
 * Kept separate from the extension so the grammar is unit-testable:
 *   /loop                          -> usage
 *   /loop list [id]                -> list
 *   /loop stop|pause|resume [id]   -> control ("all" or omit = every loop)
 *   /loop 5m <prompt>              -> start, explicit interval
 *   /loop <prompt> every 20m       -> start, trailing interval
 *   /loop <prompt>                 -> start with the default interval
 */

import { formatDuration, parseLoopArgs } from "./duration.ts";

export type LoopTarget = string;

export type LoopCommand =
	| { kind: "start"; intervalMs: number; intervalText: string; prompt: string }
	| { kind: "list"; target?: LoopTarget }
	| { kind: "stop"; target: LoopTarget }
	| { kind: "pause"; target: LoopTarget }
	| { kind: "resume"; target: LoopTarget }
	| { kind: "usage"; error?: string };

const CONTROL_WORDS = new Set(["stop", "pause", "resume"]);
const ID_RE = /^(?:l\d+|all)$/i;

function isControlWord(token: string): token is "stop" | "pause" | "resume" {
	return CONTROL_WORDS.has(token.toLowerCase());
}

export function parseLoopCommand(input: string, defaultIntervalMs: number): LoopCommand {
	const raw = input.trim();
	if (raw === "") return { kind: "usage" };

	const firstSpace = raw.search(/\s/);
	const head = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();

	// `list` is only a subcommand on its own or with a loop id: `/loop list all open PRs`
	// stays a prompt.
	if (head.toLowerCase() === "list") {
		if (rest === "") return { kind: "list" };
		if (ID_RE.test(rest)) return { kind: "list", target: rest };
	}

	// `stop`/`pause`/`resume` need an explicit id or `all`, so prompts like
	// `/loop stop the deploy check` keep working as a prompt.
	if (isControlWord(head)) {
		const kind = head.toLowerCase() as "stop" | "pause" | "resume";
		if (rest === "") return { kind, target: "all" };
		const nextSpace = rest.search(/\s/);
		const candidate = nextSpace === -1 ? rest : rest.slice(0, nextSpace);
		if (ID_RE.test(candidate)) return { kind, target: candidate.toLowerCase() };
	}

	const parsed = parseLoopArgs(raw);
	if (parsed.prompt === "") {
		return parsed.interval === undefined ? { kind: "usage" } : { kind: "usage", error: "missing prompt" };
	}
	const intervalMs = parsed.interval?.ms ?? defaultIntervalMs;
	return {
		kind: "start",
		intervalMs,
		intervalText: parsed.interval?.text ?? formatDuration(defaultIntervalMs),
		prompt: parsed.prompt,
	};
}

export function usageText(defaultIntervalMs: number): string {
	return [
		"Usage: /loop [interval] <prompt>",
		"",
		`  /loop 5m check the deploy        run the prompt every 5 minutes`,
		`  /loop check CI every 20m         interval as a trailing clause`,
		`  /loop check the deploy          no interval: defaults to ${formatDuration(defaultIntervalMs)}`,
		"",
		"Control:",
		"  /loop list                       show running loops",
		"  /loop stop [id|all]              stop a loop (default: all)",
		"  /loop pause [id|all]             pause without removing",
		"  /loop resume [id|all]            resume paused loops",
		"",
		"Intervals: Nms, Ns, Nm, Nh, Nd (minimum 1s).",
	].join("\n");
}

/**
 * Wrap the user's prompt so the transcript shows which loop produced it, and so the model
 * knows that reporting back is optional but stopping for user input is a tool call away.
 */
export function formatInjection(prompt: string, info: { id: string; intervalText: string; run: number }): string {
	const header = `[loop ${info.id} · run ${info.run} · every ${info.intervalText}]`;
	return `${header}\n${prompt}`;
}

const INJECTION_RE = /^\[loop l\d+ · run \d+ · every [^\]]+\]/;

/**
 * Whether an input is a loop iteration rather than something the user typed. The `input` event
 * carries no origin flag for prompts sent by an extension, so the header identifies them.
 */
export function isLoopInjection(text: string): boolean {
	return INJECTION_RE.test(text.trimStart());
}

export function formatLoopLine(
	loop: { id: string; intervalMs: number; runs: number; skips: number; nextAt: number; prompt: string; paused?: string; breakReason?: string },
	now: number,
): string {
	const state = loop.paused ? `paused (${loop.paused})` : `next in ${formatDuration(Math.max(0, loop.nextAt - now))}`;
	const reason = loop.breakReason ? ` — ${loop.breakReason}` : "";
	const preview = loop.prompt.split("\n")[0]!.slice(0, 60);
	return `${loop.id}  every ${formatDuration(loop.intervalMs)}  runs ${loop.runs} · skips ${loop.skips}  ${state}${reason}\n     ${preview}${loop.prompt.length > 60 ? "…" : ""}`;
}
