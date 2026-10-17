/**
 * Command surface against the real runtime.
 *
 * `/loop` has exactly two forms: start a loop, or open the management panel. Neither may reach the
 * model — the agent should never be billed for, or see, administration of its own loops. This
 * drives both through a real `AgentSession` and asserts the model was not called for them.
 */
import { describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

const FORMS = ["/loop 1s WORK", "/loop"];

describe("command surface", () => {
	it("dispatches every /loop form without calling the model", async () => {
		const modelCalls: unknown[] = [];
		const runtime = await ModelRuntime.create();
		runtime.registerProvider("m", {
			name: "m",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "t",
			api: "anthropic-messages",
			streamSimple: ((model: { api: string; provider: string; id: string }) => {
				modelCalls.push(model);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ack" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			}) as never,
			models: [
				{
					id: "mm",
					name: "MM",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4_096,
				},
			],
		});
		const model = runtime.getModel("m", "mm")!;
		const rl = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			additionalExtensionPaths: ["./extensions/loop/index.ts"],
			noExtensions: true,
		});
		await rl.reload();
		const { session } = await createAgentSession({
			model,
			modelRuntime: runtime,
			resourceLoader: rl,
			sessionManager: SessionManager.inMemory(),
			cwd: process.cwd(),
		});

		for (const form of FORMS) {
			await session.prompt(form);
		}
		await session.waitForIdle();

		// Administration never reaches the model: only the loop's own iteration may have.
		expect(modelCalls.length, "only the injected iteration should reach the model").toBeLessThanOrEqual(1);

		session.dispose();
	}, 60_000);
});
