/**
 * Duration parsing for `/loop` arguments.
 *
 * Supported forms (mirroring Claude Code's `/loop` parsing order):
 *   1. Leading token:      `/loop 5m check the deploy`
 *   2. Trailing `every`:   `/loop check the deploy every 20m` (or `every 5 minutes`)
 *   3. No interval:        `/loop check the deploy`  -> caller supplies a default
 */

export const MIN_INTERVAL_MS = 1_000;
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

const UNIT_WORDS: Record<string, string> = {
	ms: "ms",
	millisecond: "ms",
	milliseconds: "ms",
	sec: "s",
	secs: "s",
	second: "s",
	seconds: "s",
	min: "m",
	mins: "m",
	minute: "m",
	minutes: "m",
	hr: "h",
	hrs: "h",
	hour: "h",
	hours: "h",
	day: "d",
	days: "d",
};

/** `5m`, `30s`, `2h`, `1d`, `500ms` */
const TOKEN_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i;
/** `5 minutes`, `2 hours`, `20m`, `1 day` */
const EVERY_RE = /^(?:every\s+)?(\d+(?:\.\d+)?)\s*([a-z]+)$/i;

export interface Duration {
	ms: number;
	/** Canonical form of what the user wrote, e.g. `5m`, `90s`. */
	text: string;
}

function clamp(ms: number): number {
	return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

/** Canonical rendering: prefer the largest unit that stays whole. */
export function formatDuration(ms: number): string {
	if (ms % UNIT_MS.d! === 0) return `${ms / UNIT_MS.d!}d`;
	if (ms % UNIT_MS.h! === 0) return `${ms / UNIT_MS.h!}h`;
	if (ms % UNIT_MS.m! === 0) return `${ms / UNIT_MS.m!}m`;
	if (ms % UNIT_MS.s! === 0) return `${ms / UNIT_MS.s!}s`;
	return `${ms}ms`;
}

function parseToken(token: string): Duration | undefined {	const match = TOKEN_RE.exec(token);
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	const factor = UNIT_MS[unit];
	if (factor === undefined || !Number.isFinite(value)) return undefined;
	const ms = clamp(value * factor);
	return { ms, text: formatDuration(ms) };
}

function parseWordPair(amount: string, word: string): Duration | undefined {
	// Accept both `every 20m` (unit token) and `every 5 minutes` (unit word).
	const joined = parseToken(`${amount}${word}`);
	if (joined) return joined;
	const unit = UNIT_WORDS[word.toLowerCase()];
	if (unit === undefined) return undefined;
	return parseToken(`${amount}${unit}`);
}

/** Compact rendering for the status line: `5m`, `45s`, `1h 20m`. */
export function formatCountdown(ms: number): string {
	if (ms < 1_000) return "now";
	const totalSeconds = Math.round(ms / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

export interface ParseLoopArgsResult {	/** Interval when the user supplied one (`5m`, `every 20m`). */
	interval?: Duration;
	/** Remaining prompt text. */
	prompt: string;
	/** How the interval was found, for user-facing confirmation. */
	source?: "leading" | "trailing";
}

/**
 * Split `/loop` arguments into an optional interval and the prompt.
 * Returns the prompt even when a trailing `every <n> <unit>` is absent.
 */
export function parseLoopArgs(input: string): ParseLoopArgsResult {
	let rest = input.trim();
	let interval: Duration | undefined;
	let source: "leading" | "trailing" | undefined;

	// Rule 1: leading token.
	const leadingMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
	if (leadingMatch) {
		const candidate = parseToken(leadingMatch[1]!);
		if (candidate && leadingMatch[2] !== undefined && leadingMatch[2].trim() !== "") {
			interval = candidate;
			rest = leadingMatch[2]!.trim();
			source = "leading";
		} else if (candidate && leadingMatch[2] === undefined) {
			// A bare interval with no prompt: caller decides (usage / default prompt).
			interval = candidate;
			rest = "";
			source = "leading";
		}
	}

	// Rule 2: trailing `every ...` clause.
	if (!interval) {
		const trailing = /(?:^|\s)every\s+(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(rest);
		if (trailing) {
			const parsed = parseWordPair(trailing[1]!, trailing[2]!);
			if (parsed) {
				interval = parsed;
				rest = rest.slice(0, trailing.index).trim();
				source = "trailing";
			}
		}
	}

	return { interval, prompt: rest, source };
}
