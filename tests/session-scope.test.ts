/**
 * Session scope against the real runtime.
 *
 * The fake-API tests prove the handler logic; this one proves pi delivers the events the logic
 * depends on, in the order it assumes: `session_start` fires on `bindExtensions()`, `session_shutdown`
 * precedes a replacement, and the replacement's branch still contains the old `pi-loop-state` entry.
 *
 * That last detail is what makes this worth testing for real: with the old unconditional restore, a
 * conversation that once had a loop would restart it on resume/fork. No fake reproduces pi's
 * branch reconstruction, so only this test can catch a regression there.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { BREAK_TOOL_NAME } from "../extensions/loop/index.ts";
import { removeLoop, scriptedUI, type ScriptedUI } from "./helpers/scripted-ui.ts";

const PROVIDER_ID = "pi-loop-session-scope-mock";

async function boot(
	sessionManager: SessionManager,
): Promise<{ session: AgentSession; requests: string[]; ui: ScriptedUI }> {
	const requests: string[] = [];
	const ui = scriptedUI();
	const runtime = await ModelRuntime.create();
	runtime.registerProvider(PROVIDER_ID, {
		name: "session scope mock",
		baseUrl: "http://127.0.0.1:1",
		apiKey: "test",
		api: "anthropic-messages",
		streamSimple: ((model: { api: string; provider: string; id: string }, context: { messages: { role: string; content: unknown }[] }) => {
			void getCurrentTools(context.messages as never);
			const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
			const content = lastUser?.content;
			requests.push(
				typeof content === "string"
					? content
					: ((content ?? []) as { type: string; text?: string }[])
							.filter((part) => part.type === "text")
							.map((part) => part.text ?? "")
							.join("\n"),
			);
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
			noExtensions: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		model,
		modelRuntime: runtime,
		resourceLoader,
		sessionManager,
		cwd: process.cwd(),
	});
	await session.bindExtensions({ uiContext: ui.ui, mode: "tui" });
	return { session, requests, ui };
}

describe("session scope against the real runtime", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	});

	it("does not carry a loop into a resumed session, but does restore one on /reload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-loop-scope-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		// Session A starts a loop, then closes — what a session switch or quit does.
		const managerA = SessionManager.create(process.cwd(), dir);
		const { session: sessionA } = await boot(managerA);
		// A real turn first: `SessionManager` only flushes once a conversation exists.
		await sessionA.prompt("hello");
		await sessionA.prompt("/loop 1s OLD_TASK");
		await sessionA.waitForIdle();
		const sessionFile = sessionA.sessionFile;
		expect(sessionFile, "the session must be persisted for this test to mean anything").toBeDefined();
		expect(existsSync(sessionFile!), "the loop state must have been written to disk").toBe(true);
		expect(managerA.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-loop-state")).toBe(true);
		sessionA.dispose();

		// A resumed session carries A's branch, loop entry included. It must stay inert: the loop
		// belonged to A's conversation.
		const resumed = SessionManager.open(sessionFile!);
		const { session: sessionB, requests } = await boot(resumed);
		cleanups.push(() => sessionB.dispose());

		expect(sessionB.getActiveToolNames()).not.toContain(BREAK_TOOL_NAME);
		await delay(2_500);
		expect(requests, "a resumed session must not inherit the previous loop's schedule").toHaveLength(0);
	}, 60_000);

	it("restores the loop on /reload, which is the same conversation", async () => {
		// `/reload` rebuilds the same conversation in place, so its loops must come back — otherwise
		// session scoping would have been achieved by breaking reload.
		const manager = SessionManager.inMemory();
		const { session, requests, ui } = await boot(manager);
		cleanups.push(() => session.dispose());
		await session.prompt("/loop 1s KEEP_ME");
		await session.waitForIdle();
		const before = requests.length;

		await session.reload();
		expect(session.getActiveToolNames(), "a reload keeps the loop_break tool").toContain(BREAK_TOOL_NAME);

		const deadline = Date.now() + 5_000;
		while (requests.length <= before && Date.now() < deadline) await delay(25);
		expect(requests.at(-1), "the loop continues after a reload").toContain("KEEP_ME");
		await session.waitForIdle();
		await removeLoop(session, ui, "l1");
	}, 60_000);
});
