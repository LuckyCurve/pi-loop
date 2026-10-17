/**
 * Test isolation.
 *
 * `DefaultResourceLoader` merges the user's global packages, so a plain `npm test` used to load every
 * installed extension — including notification plugins that play a sound on `agent_end`. A suite that
 * beeps dozens of times per run, and whose timing depends on whatever the developer happens to have
 * installed, is not a reliable suite.
 *
 * The control below installs a throwaway extension into a temporary agent directory rather than
 * relying on the developer's machine. Asserting "at least one extension loaded" would pass on a
 * clean CI box no matter what `noExtensions` did; this fails everywhere if the opt-out breaks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const EXTENSION = "./extensions/loop/index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** An agent directory containing one recognisable extension. */
function agentDirWithFixture(): { agentDir: string; fixtureName: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-loop-isolation-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	const fixtureName = "beacon.ts";
	writeFileSync(join(agentDir, "extensions", fixtureName), "export default function () {}\n");
	return { agentDir, fixtureName };
}

function loadedNames(loader: DefaultResourceLoader): string[] {
	return loader
		.getExtensions()
		.extensions.map((extension) => extension.path.split(/[\\/]/).pop() ?? extension.path);
}

describe("test isolation", () => {
	it("loads only this extension, not other installed ones", async () => {
		const { agentDir, fixtureName } = agentDirWithFixture();
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir,
			additionalExtensionPaths: [EXTENSION],
			noExtensions: true,
		});
		await loader.reload();

		const names = loadedNames(loader);
		expect(names).toContain("index.ts");
		expect(names, "an installed extension must not join the suite").not.toContain(fixtureName);
	});

	it("would load that extension without the opt-out, which is why it is required", async () => {
		// The control: proves the fixture is discoverable, so the assertion above is about
		// `noExtensions` and not about a path the loader never looked at.
		const { agentDir, fixtureName } = agentDirWithFixture();
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir,
			additionalExtensionPaths: [EXTENSION],
		});
		await loader.reload();

		expect(loadedNames(loader)).toContain(fixtureName);
	});
});
