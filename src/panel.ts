/**
 * `/loop` management panel, as data.
 *
 * The popup is a `SelectList` with a two-column row per loop — schedule and state on the left, the
 * prompt and counters on the right — so the layout is composed, not hand-rendered. Everything worth
 * testing (the rows, their order, the action each dispatches) lives here as plain functions; the
 * extension only maps a selected value back to an action and calls the engine.
 */

import { formatCountdown, formatDuration } from "./duration.ts";
import type { LoopRecord } from "./engine.ts";

export type PanelAction =
	/** Open the action list for one loop. */
	| { kind: "open"; id: string }
	/** Leave the panel. */
	| { kind: "close" }
	/** Disable (pause) or enable (resume) a loop. */
	| { kind: "toggle"; id: string; enable: boolean }
	/** Delete a loop. */
	| { kind: "remove"; id: string }
	/** Return to the loop list without changing anything. */
	| { kind: "back" };

export interface PanelOption {
	/** What the selection returns; unique within one dialog. */
	value: string;
	/** Left column: identity, schedule, state. */
	label: string;
	/** Right column: counters and the prompt, or why a loop is stopped. */
	description: string;
	action: PanelAction;
}

/** Rows are one line each, so the prompt gets a bounded slice. */
const PREVIEW_CHARS = 60;

export const CLOSE_VALUE = "close";

export function optionTitle(count: number): string {
	return `循环 (${count})`;
}

export function noLoopsMessage(): string {
	return "当前没有运行中的循环。";
}

/** `2m30s 后`, or `即将执行` when the run is due now. */
export function countdownLabel(ms: number): string {
	const text = formatCountdown(Math.max(0, ms));
	return text === "now" ? "即将执行" : `${text} 后`;
}

/** First line of the prompt, cut to fit one row. */
function preview(prompt: string, maxChars = PREVIEW_CHARS): string {
	const line = prompt.split("\n")[0]!.trim();
	return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/**
 * Why a paused loop is not running, in the user's terms. The cause matters more than the counts
 * here: `agent` means the model is waiting on an answer, `user` means you switched it off.
 */
function pauseLabel(loop: LoopRecord): string {
	return loop.paused === "agent" ? "等待你的回答" : "由你禁用";
}

/** The state word for the left column, so a disabled loop is not mistaken for a waiting one. */
function stateLabel(loop: LoopRecord): string {
	if (!loop.paused) return "已暂停";
	return loop.paused === "agent" ? "已暂停" : "已禁用";
}

function schedule(loop: LoopRecord): string {
	return `${loop.id} · 每 ${formatDuration(loop.intervalMs)} · `;
}

function counters(loop: LoopRecord): string[] {
	const parts: string[] = [];
	if (loop.runs > 0) parts.push(`已跑 ${loop.runs}`);
	if (loop.skips > 0) parts.push(`跳过 ${loop.skips}`);
	return parts;
}

/** Heading for the action dialog, so it says which loop it is about. */
export function loopHeading(loop: LoopRecord): string {
	return `${loop.id} · ${preview(loop.prompt, 40)}`;
}

/** One row per loop plus the row that leaves the panel. */
export function loopOptions(loops: readonly LoopRecord[], now: number): PanelOption[] {
	// Nothing to manage means nothing to open: the caller reports that instead of showing an empty
	// dialog with a lone Close row.
	if (loops.length === 0) return [];
	const rows: PanelOption[] = loops.map((loop) => {
		const prompt = preview(loop.prompt);
		const detail = loop.paused
			? [pauseLabel(loop), loop.breakReason, prompt].filter(Boolean)
			: [...counters(loop), prompt].filter(Boolean);
		return {
			value: loop.id,
			label: `${schedule(loop)}${loop.paused ? stateLabel(loop) : countdownLabel(loop.nextAt - now)}`,
			description: detail.join(" · "),
			action: { kind: "open", id: loop.id },
		};
	});
	return [...rows, { value: CLOSE_VALUE, label: "关闭", description: "", action: { kind: "close" } }];
}

/** Actions for one loop. `禁用` is a pause, so it can be undone without re-typing the prompt. */
export function actionOptions(loop: LoopRecord): PanelOption[] {
	return [
		loop.paused
			? { value: "enable", label: "启用", description: "", action: { kind: "toggle", id: loop.id, enable: true } }
			: { value: "disable", label: "禁用", description: "", action: { kind: "toggle", id: loop.id, enable: false } },
		{ value: "remove", label: "删除", description: "", action: { kind: "remove", id: loop.id } },
		{ value: "back", label: "返回", description: "", action: { kind: "back" } },
	];
}
