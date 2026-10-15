/**
 * Regression: tool activation must match reality, not a stale snapshot.
 *
 * A run that is already in flight snapshots its tool loadout and re-applies it while building the
 * request. When a loop ends during that run — because `/loop stop all` was issued, or because
 * `loop_break` paused it — the snapshot still contains `loop_break`, so the tool would be put back
 * in front of the model after the loop that justified it is gone.
 *
 * These tests assert against the real runtime because the failure lives in pi's request-time
 * loadout application, which no fake reproduces.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, createAssistantMessageEventStream, getCurrentTools, type Tool } from "@earendil-works/pi-ai";
import { BREAK_TOOL_NAME } from "../extensions/loop/index.ts";

const PROVIDER_ID = "pi-loop-activation-mock";

interface SeenRequest {
	text: string;
	tools: string[];
}

/** Boot a real session whose provider records what the model was actually offered. */
async function boot(): Promise<{ session: AgentSession; seen: SeenRequest[] }> {
	const seen: SeenRequest[] = [];
	const runtime = await ModelRuntime.create();
	runtime.registerProvider(PROVIDER_ID, {
		name: "activation mock",
		baseUrl: "http://127.0.0.1:1",
		apiKey: "test",
		api: "anthropic-messages",
		streamSimple: ((model: { api: string; provider: string; id: string }, context: { messages: { role: string; content: unknown }[] }) => {
			const tools = getCurrentTools(context.messages as never) as Tool[];
			const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
			const content = lastUser?.content;
			seen.push({
				text:
					typeof content === "string"
						? content
						: ((content ?? []) as { type: string; text?: string }[])
								.filter((part) => part.type === "text")
								.map((part) => part.text ?? "")
								.join(String.fromCharCode(10)),
				tools: tools.map((tool) => tool.name),
			});
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
				id: "mock-model",
				name: "Mock Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4_096,
			},
		],
	});
	const model = runtime.getModel(PROVIDER_ID, "mock-model")!;
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		additionalExtensionPaths: ["./extensions/loop/index.ts"],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		model,
		modelRuntime: runtime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		cwd: process.cwd(),
	});
	return { session, seen };
}

/** Wait until the provider has been asked at least `count` times. */
async function waitForRequests(seen: SeenRequest[], count: number, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (seen.length < count && Date.now() < deadline) await delay(25);
	if (seen.length < count) throw new Error(`timed out waiting for request ${count} (got ${seen.length})`);
}

describe("tool activation tracks the loop", () => {
	it("offers loop_break to the model while a loop runs", async () => {
		const { session, seen } = await boot();
		await session.prompt("/loop 1s WORK");
		await waitForRequests(seen, 1);

		// The loop's own iteration is what the model sees first.
		expect(seen[0]!.tools).toContain(BREAK_TOOL_NAME);

		await session.waitForIdle();
		await session.prompt("/loop stop all");
		session.dispose();
	}, 60_000);

	it("stops offering loop_break after the loop is stopped, even to an in-flight run", async () => {
		const { session, seen } = await boot();
		await session.prompt("/loop 1s WORK");
		await waitForRequests(seen, 1);

		// Stop the loop, then make the model run again. The new request must not carry the tool.
		await session.waitForIdle();
		await session.prompt("/loop stop all");
		await session.waitForIdle();
		await session.prompt("plain turn after stop");
		await waitForRequests(seen, 2);

		const afterStop = seen.at(-1)!;
		expect(afterStop.tools, "a stopped loop must not leave loop_break declared").not.toContain(BREAK_TOOL_NAME);
		expect(session.getActiveToolNames()).not.toContain(BREAK_TOOL_NAME);

		session.dispose();
	}, 60_000);

	it("re-offers loop_break when a new loop starts after an earlier stop", async () => {
		const { session, seen } = await boot();
		await session.prompt("/loop 1s FIRST");
		await waitForRequests(seen, 1);
		await session.waitForIdle();
		await session.prompt("/loop stop all");
		await session.waitForIdle();
		await session.prompt("turn with no loop");
		await waitForRequests(seen, 2);
		expect(seen.at(-1)!.tools).not.toContain(BREAK_TOOL_NAME);

		await session.prompt("/loop 1s SECOND");
		await waitForRequests(seen, 3);
		expect(seen.at(-1)!.tools, "a started loop declares loop_break again").toContain(BREAK_TOOL_NAME);

		await session.waitForIdle();
		await session.prompt("/loop stop all");
		session.dispose();
	}, 60_000);

	it("keeps loop_break while the loop is merely paused", async () => {
		const { session, seen } = await boot();
		await session.prompt("/loop 1s WORK");
		await session.waitForIdle();
		await session.waitForIdle();
		await session.prompt("/loop pause l1");
		await session.waitForIdle();
		await session.prompt("turn while paused");
		await session.waitForIdle();

		// A paused loop can be resumed, so the tool stays declared.
		expect(seen.at(-1)!.tools, "a paused loop still declares loop_break").toContain(BREAK_TOOL_NAME);

		await session.waitForIdle();
		await session.prompt("/loop stop all");
		session.dispose();
	}, 60_000);
});
