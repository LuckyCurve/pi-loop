import { describe, expect, it } from "vitest";
import { formatDuration, formatNextDue, MAX_INTERVAL_MS, MIN_INTERVAL_MS, parseLoopArgs } from "../src/duration.ts";

describe("parseLoopArgs", () => {
	it("parses a leading interval", () => {
		const result = parseLoopArgs("5m check the deploy");
		expect(result.interval?.ms).toBe(5 * 60_000);
		expect(result.interval?.text).toBe("5m");
		expect(result.prompt).toBe("check the deploy");
		expect(result.source).toBe("leading");
	});

	it("supports every unit", () => {
		expect(parseLoopArgs("30s go").interval?.ms).toBe(30_000);
		expect(parseLoopArgs("2h go").interval?.ms).toBe(7_200_000);
		expect(parseLoopArgs("1d go").interval?.ms).toBe(86_400_000);
		expect(parseLoopArgs("500ms go").interval?.ms).toBe(MIN_INTERVAL_MS);
	});

	it("parses a trailing 'every' clause with a unit token", () => {
		const result = parseLoopArgs("check the deploy every 20m");
		expect(result.interval?.ms).toBe(20 * 60_000);
		expect(result.prompt).toBe("check the deploy");
		expect(result.source).toBe("trailing");
	});

	it("parses a trailing 'every' clause with a unit word", () => {
		expect(parseLoopArgs("run tests every 5 minutes").prompt).toBe("run tests");
		expect(parseLoopArgs("run tests every 5 minutes").interval?.ms).toBe(300_000);
		expect(parseLoopArgs("sync every 2 hours").interval?.ms).toBe(7_200_000);
		expect(parseLoopArgs("clean every 1 day").interval?.ms).toBe(86_400_000);
	});

	it("does not treat 'every' without a time expression as an interval", () => {
		const result = parseLoopArgs("review every PR that is open");
		expect(result.interval).toBeUndefined();
		expect(result.prompt).toBe("review every PR that is open");
	});

	it("keeps the whole input as prompt when no interval is present", () => {
		const result = parseLoopArgs("check the deploy");
		expect(result.interval).toBeUndefined();
		expect(result.prompt).toBe("check the deploy");
	});

	it("returns an empty prompt for a bare interval", () => {
		const result = parseLoopArgs("5m");
		expect(result.interval?.ms).toBe(300_000);
		expect(result.prompt).toBe("");
	});

	it("returns an empty result for empty input", () => {
		expect(parseLoopArgs("   ")).toEqual({ prompt: "", interval: undefined, source: undefined });
	});

	it("keeps multi-line prompts intact", () => {
		const result = parseLoopArgs("10m line one\nline two\nline three");
		expect(result.interval?.ms).toBe(600_000);
		expect(result.prompt).toBe("line one\nline two\nline three");
	});

	it("prefers the leading interval over a trailing clause", () => {
		const result = parseLoopArgs("2m check every 30m");
		expect(result.interval?.ms).toBe(120_000);
		expect(result.prompt).toBe("check every 30m");
	});

	it("clamps intervals to a sane range", () => {
		expect(parseLoopArgs("1ms go").interval?.ms).toBe(MIN_INTERVAL_MS);
		expect(parseLoopArgs("99d go").interval?.ms).toBe(MAX_INTERVAL_MS);
	});

	it("treats a leading non-duration token as prompt text", () => {
		const result = parseLoopArgs("5x check");
		expect(result.interval).toBeUndefined();
		expect(result.prompt).toBe("5x check");
	});
});

describe("formatNextDue", () => {
	it("reads as a time until the next run", () => {
		expect(formatNextDue(150_000)).toBe("next 2m30s");
		expect(formatNextDue(20_000)).toBe("next 20s");
	});

	it("says the moment has arrived instead of `next now`", () => {
		// Both the footer and the panel show this; `next now` is what falling through to the raw
		// countdown wording produced.
		expect(formatNextDue(0)).toBe("due now");
		expect(formatNextDue(400)).toBe("due now");
		expect(formatNextDue(-5_000)).toBe("due now");
	});
});

describe("formatDuration", () => {
	it("renders the largest whole unit", () => {
		expect(formatDuration(300_000)).toBe("5m");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(90_000)).toBe("90s");
		expect(formatDuration(500)).toBe("500ms");
	});
});
