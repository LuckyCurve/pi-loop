import { describe, expect, it } from "vitest";
import { formatInjection, parseLoopCommand, usageText } from "../src/commands.ts";

const DEFAULT = 10 * 60_000;

describe("parseLoopCommand", () => {
	it("returns usage for empty input", () => {
		expect(parseLoopCommand("", DEFAULT)).toEqual({ kind: "usage" });
		expect(parseLoopCommand("   ", DEFAULT)).toEqual({ kind: "usage" });
	});

	it("returns usage when a bare interval has no prompt", () => {
		expect(parseLoopCommand("5m", DEFAULT)).toEqual({ kind: "usage", error: "missing prompt" });
	});

	it("starts a loop with an explicit interval", () => {
		const command = parseLoopCommand("5m check the deploy", DEFAULT);
		expect(command).toEqual({
			kind: "start",
			intervalMs: 300_000,
			intervalText: "5m",
			prompt: "check the deploy",
		});
	});

	it("starts a loop with a trailing interval clause", () => {
		const byToken = parseLoopCommand("check CI every 20m", DEFAULT);
		expect(byToken).toEqual({
			kind: "start",
			intervalMs: 1_200_000,
			intervalText: "20m",
			prompt: "check CI",
		});
		const byWord = parseLoopCommand("check CI every 5 minutes", DEFAULT);
		expect(byWord.kind === "start" && byWord.intervalMs).toBe(300_000);
	});

	it("falls back to the default interval", () => {
		expect(parseLoopCommand("check the deploy", DEFAULT)).toEqual({
			kind: "start",
			intervalMs: DEFAULT,
			intervalText: "10m",
			prompt: "check the deploy",
		});
	});

	it("keeps multi-line prompts", () => {
		const command = parseLoopCommand("2m do this\nthen that", DEFAULT);
		expect(command.kind).toBe("start");
		expect(command.kind === "start" && command.prompt).toBe("do this\nthen that");
	});

	it("parses list with and without a target", () => {
		expect(parseLoopCommand("list", DEFAULT)).toEqual({ kind: "list" });
		expect(parseLoopCommand("list l2", DEFAULT)).toEqual({ kind: "list", target: "l2" });
		// Not a target: stays a prompt.
		expect(parseLoopCommand("list all open PRs", DEFAULT).kind).toBe("start");
	});

	it("parses control commands", () => {
		expect(parseLoopCommand("stop", DEFAULT)).toEqual({ kind: "stop", target: "all" });
		expect(parseLoopCommand("stop all", DEFAULT)).toEqual({ kind: "stop", target: "all" });
		expect(parseLoopCommand("stop l3", DEFAULT)).toEqual({ kind: "stop", target: "l3" });
		expect(parseLoopCommand("pause l1", DEFAULT)).toEqual({ kind: "pause", target: "l1" });
		expect(parseLoopCommand("resume", DEFAULT)).toEqual({ kind: "resume", target: "all" });
	});

	it("treats control words followed by prose as a prompt", () => {
		const command = parseLoopCommand("stop the deploy check", DEFAULT);
		expect(command.kind).toBe("start");
		expect(command.kind === "start" && command.prompt).toBe("stop the deploy check");
	});

	it("accepts a slash command as the loop prompt", () => {
		const command = parseLoopCommand("20m /review-pr 1234", DEFAULT);
		expect(command.kind === "start" && command.prompt).toBe("/review-pr 1234");
	});
});

describe("usageText", () => {
	it("shows the effective default interval", () => {
		expect(usageText(DEFAULT)).toContain("defaults to 10m");
	});
});

describe("formatInjection", () => {
	it("prefixes the prompt with a loop header", () => {
		const text = formatInjection("check the deploy", { id: "l1", intervalText: "5m", run: 3 });
		expect(text).toBe("[loop l1 · run 3 · every 5m]\ncheck the deploy");
	});
});
