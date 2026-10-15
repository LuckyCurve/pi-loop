/**
 * Live smoke test with the real model and the installed package.
 *
 * Runs `/loop` for a few seconds with a trivial prompt and asserts the loop actually iterated
 * more than once and then stopped on request. Skipped automatically when no provider is
 * configured, so it never blocks a plain `npm test` in a fresh checkout.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { isLoopInjection } from "../src/commands.ts";

describe("live smoke", () => {
	it("iterates a real /loop more than once with the configured model", async () => {
		const runtime = await ModelRuntime.create();
		const available = await runtime.getAvailable();
		if (available.length === 0) {
			console.warn("no provider configured; skipping live smoke test");
			return;
		}
		const model = available[0]!;

		const rl = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			additionalExtensionPaths: ["./extensions/loop/index.ts"],
		});
		await rl.reload();
		const { session } = await createAgentSession({
			model,
			modelRuntime: runtime,
			resourceLoader: rl,
			sessionManager: SessionManager.inMemory(),
			cwd: process.cwd(),
		});
		const iterations: string[] = [];
		session.subscribe((event) => {
			if (event.type === "message_start" && (event as { message?: { role?: string } }).message?.role === "user") {
				const content = (event as { message: { content: unknown } }).message.content;
				const text =
					typeof content === "string"
						? content
						: (content as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
				if (isLoopInjection(text)) iterations.push(text.split("]")[0]! + "]");
			}
		});

		await session.prompt("/loop 1s Reply with exactly TICK");
		await session.waitForIdle();

		// Wait for a second iteration rather than sleeping a fixed amount: the first run's latency
		// depends on the provider, and a slow one legitimately skips an interval (which is the
		// behaviour under test elsewhere). Poll so this stays green under parallel test load.
		const deadline = Date.now() + 60_000;
		while (iterations.length < 2 && Date.now() < deadline) await delay(100);
		expect(iterations.length, "the loop should have iterated more than once").toBeGreaterThan(1);
		expect(iterations[1], "the second iteration increments the run counter").toMatch(/run 2/);

		await session.waitForIdle();
		await session.prompt("/loop stop all");
		const after = iterations.length;
		await delay(3_000);

		console.log(`live iterations: ${iterations.length} (${iterations.join(", ")})`);
		expect(iterations.length, "iterations must not keep coming after /loop stop all").toBe(after);
		session.dispose();
	}, 120_000);
});
