/**
 * English-only user-facing text.
 *
 * Everything pi shows — command descriptions, the panel, notifications, the status line — is
 * English. Chinese lives only in `README.zh-CN.md`. The rule exists because the agent's `loop_break`
 * `reason` is free text: an English prefix in front of a Chinese reason, or a Chinese hint under an
 * English list, reads as two products stitched together.
 *
 * This is a test rather than a note in AGENTS.md because the rule is invisible to every other test:
 * a Chinese label renders fine, and a reviewer skimming a diff reads past it. A Chinese string did
 * in fact ship in the panel's key hint while the rest of the surface was English.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Han characters, including the CJK punctuation that travels with them. */
const CJK = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;

const ROOTS = ["src", "extensions"];
const EXTENSIONS = [".ts", ".json", ".md"];

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return filesUnder(path);
		return EXTENSIONS.some((ext) => path.endsWith(ext)) ? [path] : [];
	});
}

describe("user-facing text", () => {
	it("is English in every shipped file", () => {
		const offenders = ROOTS.flatMap(filesUnder)
			.flatMap((path) =>
				readFileSync(path, "utf8")
					.split("\n")
					.flatMap((line, index) => (CJK.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
			);

		expect(offenders, "ship English in the TUI; Chinese belongs in README.zh-CN.md").toEqual([]);
	});

	it("keeps Chinese in the translated README, which is the one exception", () => {
		// Guards the guard: if the character class above stopped matching, the test above would pass
		// for the wrong reason. The Chinese README must always trip it.
		expect(CJK.test(readFileSync("README.zh-CN.md", "utf8"))).toBe(true);
	});
});
