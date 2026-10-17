/**
 * Test isolation.
 *
 * `DefaultResourceLoader` merges the user's global `settings.json` packages, so a plain `npm test`
 * used to load every installed extension — including notification plugins that play a sound on
 * `agent_end`. A suite that beeps dozens of times per run, and whose timing depends on whatever the
 * developer happens to have installed, is not a reliable suite.
 *
 * These tests pin the loader configuration every test helper must use: this extension and nothing
 * else from the environment.
 */
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

const EXTENSION = "./extensions/loop/index.ts";

describe("test isolation", () => {
	it("loads only this extension, not the user's installed packages", async () => {
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			additionalExtensionPaths: [EXTENSION],
			noExtensions: true,
		});
		await loader.reload();

		const paths = loader.getExtensions().extensions.map((extension) => extension.path);
		expect(paths).toHaveLength(1);
		expect(paths[0]!.replaceAll("\\", "/")).toMatch(/extensions\/loop\/index\.ts$/);
	});

	it("does load the user's packages without the opt-out, which is why it is required", async () => {
		// Guard against the flag silently becoming a no-op in a future pi version: if this ever
		// stops finding anything, the isolation above is no longer being tested for a real reason.
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			additionalExtensionPaths: [EXTENSION],
		});
		await loader.reload();
		expect(loader.getExtensions().extensions.length).toBeGreaterThanOrEqual(1);
	});
});
