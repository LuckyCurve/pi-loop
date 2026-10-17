/**
 * End-to-end test against the real pi runtime.
 *
 * Everything else in this suite uses fakes; this one builds a real `AgentSession` with a mock
 * provider so the assumptions the extension depends on are verified against pi itself:
 *
 *   1. `ctx.isIdle()` is false for the whole run, so a tick during a turn really is skipped and
 *      never queued behind it.
 *   2. An idle `pi.sendUserMessage()` from a timer starts its own run.
 *   3. A prompt starting with `/` sent with `expandPromptTemplates: false` reaches the model as
 *      text instead of re-entering the command.
 *   4. `loop_break` is declared only while a loop runs, and calling it pauses that loop.
 *   5. A real user message resumes an agent-paused loop; loop injections do not.
 */

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
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentTools,
	type Tool,
} from "@earendil-works/pi-ai";
import { BREAK_TOOL_NAME } from "../extensions/loop/index.ts";
import { isLoopInjection } from "../src/commands.ts";
import { removeLoop, scriptedUI, type ScriptedUI } from "./helpers/scripted-ui.ts";

const PROVIDER_ID = "pi-loop-mock";

interface Request {
	text: string;
	tools: string[];
}

interface MockState {
	requests: Request[];
	/** Keep this many upcoming responses open for `holdMs`, so the run stays active. */
	slowFor: number;
	holdMs: number;
}

function modelFrom(context: unknown) {
	return context as { api: string; provider: string; id: string };
}

/**
 * Build a scripted assistant response. `delayMs` (when the run must stay active) pushes the
 * completion events later, so pi still counts the session as busy while scheduled ticks pass.
 */
function createStream(
	model: { api: string; provider: string; id: string },
	reply: { text?: string; toolCall?: { name: string; arguments: Record<string, string> } },
	delayMs = 0,
) {
	const content: AssistantMessage["content"] = [];
	if (reply.text !== undefined) content.push({ type: "text", text: reply.text });
	if (reply.toolCall) {
		content.push({ type: "toolCall", id: "call-1", name: reply.toolCall.name, arguments: reply.toolCall.arguments });
	}
	const message: AssistantMessage = {
		role: "assistant",
		content,
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
		stopReason: reply.toolCall ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	const finish = () => {
		if (reply.text !== undefined) {
			stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: message });
		}
		if (reply.toolCall) stream.push({ type: "toolcall_end", contentIndex: content.length - 1, toolCall: content[content.length - 1] as never, partial: message });
		stream.push({ type: "done", reason: reply.toolCall ? "toolUse" : "stop", message });
		stream.end(message);
	};
	if (delayMs > 0) setTimeout(finish, delayMs);
	else finish();
	return stream;
}

describe("pi-loop against the real pi runtime", () => {
	const cleanups: (() => Promise<void> | void)[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function boot(
		script: (request: Request, index: number) => { text?: string; toolCall?: { name: string; arguments: Record<string, string> } },
	): Promise<{ session: AgentSession; state: MockState; ui: ScriptedUI }> {
		const state: MockState = { requests: [], slowFor: 0, holdMs: 1_500 };
		const ui = scriptedUI();

		const runtime = await ModelRuntime.create();
		runtime.registerProvider(PROVIDER_ID, {
			name: "pi-loop mock",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "test",
			api: "anthropic-messages",
			streamSimple: ((model: unknown, context: { messages: { role: string; content: unknown }[] }) => {
				const tools = getCurrentTools(context.messages as never) as Tool[];
				const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
				const text =
					typeof lastUser?.content === "string"
						? lastUser.content
						: ((lastUser?.content ?? []) as { type: string; text?: string }[])
								.filter((part) => part.type === "text")
								.map((part) => part.text ?? "")
								.join("\n");
				const request: Request = { text, tools: tools.map((tool) => tool.name) };
				const index = state.requests.push(request) - 1;
				const reply = script(request, index);
				const delayMs = state.slowFor > 0 ? (state.slowFor--, state.holdMs) : 0;
				return createStream(modelFrom(model), reply, delayMs);
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
		const model = runtime.getModel(PROVIDER_ID, "mock-model");
		expect(model, "mock provider should be registered").toBeDefined();

		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			additionalExtensionPaths: ["./extensions/loop/index.ts"],
			noExtensions: true,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			model: model!,
			modelRuntime: runtime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
			cwd: process.cwd(),
			// No `tools` allowlist: an empty one would filter out every extension tool, including
			// `loop_break`, and hide the activation behavior under test.
		});
		cleanups.push(() => session.dispose());
		// A UI is bound so `/loop` opens the panel instead of falling back to usage text. The
		// scripted answers keep the management path exercised rather than poking the engine.
		await session.bindExtensions({ uiContext: ui.ui, mode: "tui" });
		return { session, state, ui };
	}

	async function waitFor(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!condition() && Date.now() < deadline) await delay(25);
		if (!condition()) throw new Error(`timed out waiting for ${label}`);
	}

	it(
		"skips iterations during a run, injects when idle, and stops on request",
		async () => {
			const { session, state, ui } = await boot(() => ({ text: "ack" }));

			// 1. A 1s loop whose first iteration takes longer than its interval.
			state.slowFor = 1;
			await session.prompt("/loop 1s check the deploy");			await waitFor(() => state.requests.length >= 1, "first iteration");
			expect(state.requests[0]!.text).toBe("[loop l1 · run 1 · every 1s]\ncheck the deploy");
			expect(state.requests[0]!.tools).toContain(BREAK_TOOL_NAME);

			// 2. The interval passes while the first run is still active: skipped, not queued.
			await session.waitForIdle();
			expect(state.requests.length, "iterations must not queue behind a running turn").toBe(1);

			// 3. Once idle, the loop continues on its own.
			await waitFor(() => state.requests.length >= 2, "second iteration");
			expect(state.requests[1]!.text).toMatch(/^\[loop l1 · run 2 · every 1s\]\ncheck the deploy$/);

			// 4. Removing it through the panel ends it for good.
			await session.waitForIdle();
			await removeLoop(session, ui, "l1");
			const count = state.requests.length;
			await delay(2_500);
			expect(state.requests.length, "stopped loop must not fire again").toBe(count);
			expect(session.getActiveToolNames()).not.toContain(BREAK_TOOL_NAME);
		},
		120_000,
	);

	it(
		"serves /loop through the UI panel: pick a loop, disable it, close",
		async () => {
			// The panel is two nested `ctx.ui.select()` calls. This asserts the dialog path works in a
			// real session, which the fake UI in `extension.test.ts` cannot: a select() that is never
			// wired would leave `/loop` silently doing nothing.
			const { session, state, ui } = await boot(() => ({ text: "ack" }));

			await session.prompt("/loop 1s WORK");
			await session.waitForIdle();
			ui.script("Task 1", "Disable", "Close");
			await session.prompt("/loop");
			await session.waitForIdle();

			expect(ui.dialogs[0]!.title).toBe("Loops (1)");
			expect(ui.dialogs[0]!.rows[0]).toContain("every 1s");
			expect(ui.dialogs[0]!.rows.at(-1)).toBe("Close");
			expect(ui.dialogs[1]!.rows).toEqual(["Disable", "Run now", "Remove", "Back"]);
			// Presented as a centered overlay, so the panel owns the middle of the screen.
			expect(ui.presentation.every((dialog) => dialog.overlay && dialog.anchor === "center")).toBe(true);
			// Disabled: the loop is paused, so it is not due any more.
			await delay(2_500);
			expect(state.requests.filter((request) => /· run 2 ·/.test(request.text))).toHaveLength(0);

			await removeLoop(session, ui, "l1");
			session.dispose();
		},
		120_000,
	);

	it(
		"removes the loop on a done outcome, so the next message does not restart it",
		async () => {
			// The workflow this exists for: the model finishes the backlog, reports done, and a
			// follow-up "thanks" must not start working again.
			const { session, state, ui } = await boot((request, index) =>
				index === 0 && request.tools.includes(BREAK_TOOL_NAME)
					? { toolCall: { name: BREAK_TOOL_NAME, arguments: { reason: "all defects fixed", outcome: "done" } } }
					: { text: "ack" },
			);

			await session.prompt("/loop 1s FINISH_ME");
			await session.waitForIdle();
			await delay(2_500);

			// The loop is gone, so the tool that only exists for a loop is withdrawn too.
			expect(session.getActiveToolNames()).not.toContain(BREAK_TOOL_NAME);

			// A human reply must not resurrect it. The reply itself reaches the model — that is a
			// normal turn — but it must not start another *iteration*.
			await session.prompt("thanks, great work");
			await session.waitForIdle();
			const afterReply = state.requests.length;
			await delay(2_500);
			expect(state.requests.length, "no scheduled iteration after a finished loop").toBe(afterReply);
			expect(state.requests.some((request) => /· run 2 ·/.test(request.text))).toBe(false);

			session.dispose();
		},
		120_000,
	);

	it(
		"pins that slash commands are not reported as user input",
		async () => {
			// The loop resumes when the user replies. "Opened the panel" must not count as a reply, or
			// a loop the model deliberately stopped would restart itself.
			//
			// This holds because pi dispatches a slash command without emitting `input` at all — a
			// slash command never reaches the handler. That is an assumption about pi, not a guard in
			// this extension (the handler cannot tell a command from a message it does receive), so it
			// is pinned here: if pi ever starts emitting `input` for commands, this fails and the
			// handler needs a real guard.
			const { session, state, ui } = await boot((request, index) =>
				index === 0 && request.tools.includes(BREAK_TOOL_NAME)
					? { toolCall: { name: BREAK_TOOL_NAME, arguments: { reason: "which environment?" } } }
					: { text: "ack" },
			);
			await session.prompt("/loop 1s WAIT_FOR_ME");
			await session.waitForIdle();
			await delay(2_500);
			const whilePaused = state.requests.length;

			ui.script("Close");
			await session.prompt("/loop");
			await session.waitForIdle();
			await delay(2_500);

			expect(
				state.requests.length,
				"opening the panel must not resume a loop that is waiting for an answer",
			).toBe(whilePaused);
			expect(state.requests.some((request) => /· run 2 ·/.test(request.text))).toBe(false);

			await removeLoop(session, ui, "l1");
			session.dispose();
		},
		120_000,
	);

	it(
		"starts a turn from Run now even though the panel is on screen",
		async () => {
			// `Run now` injects a prompt through the same path a scheduled iteration uses, and it is
			// clicked while an overlay holds keyboard focus. Whether that starts a run in a real
			// session — rather than being swallowed or queued behind the dialog — is not something a
			// fake can answer.
			const { session, state, ui } = await boot(() => ({ text: "ack" }));
			await session.prompt("/loop 1h WORK");
			await session.waitForIdle();
			const before = state.requests.length;

			ui.script("Task 1", "Run now");
			await session.prompt("/loop");
			await session.waitForIdle();

			const manual = state.requests.slice(before);
			expect(manual, "Run now must deliver exactly one iteration").toHaveLength(1);
			expect(manual[0]!.text).toMatch(/^\[loop l1 · run \d+ · every 1h\]\nWORK$/);

			// The schedule is untouched: nothing else fires for an hour.
			await delay(2_500);
			expect(state.requests.slice(before)).toHaveLength(1);

			await removeLoop(session, ui, "l1");
			session.dispose();
		},
		120_000,
	);

	it(
		"keeps the first loop injection as text even when the prompt starts with a slash",
		async () => {
			const { session, state, ui } = await boot(() => ({ text: "ack" }));
			await session.prompt("/loop 1s /help");
			await waitFor(() => state.requests.length >= 1, "slash-prompt iteration");
			// `/help` must reach the model as prompt text, not as a slash command.
			expect(state.requests[0]!.text).toBe("[loop l1 · run 1 · every 1s]\n/help");
			await session.waitForIdle();
			await removeLoop(session, ui, "l1");
		},
		120_000,
	);

	it(
		"pauses on loop_break and resumes on the user's next message",
		async () => {
			// Break only on the first iteration. The mock is called again for every tool result
			// inside the same run, and asking to break a second time has nothing to pause.
			const { session, state, ui } = await boot((request, index) =>
				index === 0 && request.tools.includes(BREAK_TOOL_NAME)
					? { toolCall: { name: BREAK_TOOL_NAME, arguments: { reason: "Which environment is the target?" } } }
					: { text: "ack" },
			);

			await session.prompt("/loop 1s BREAK_FIRST");
			await waitFor(() => state.requests.length >= 1, "first iteration");

			// The model called loop_break, so the loop is paused: only its own run's follow-up
			// turn may appear, and no new iteration with an increasing run count.
			await session.waitForIdle();
			const afterBreak = state.requests.length;
			await delay(2_500);
			expect(state.requests.length, "paused loop must not fire again").toBe(afterBreak);
			expect(state.requests.some((request) => /· run 2 ·/.test(request.text))).toBe(false);

			// The user answers: the loop resumes, so a fresh iteration (with the header) arrives.
			await session.prompt("production, thanks");
			// Resuming waits one interval, so the next iteration arrives a moment later.
			await waitFor(
				() => state.requests.some((request) => /· run 2 ·/.test(request.text)),
				"second iteration after the answer",
				20_000,
			);

			await session.waitForIdle();
			await removeLoop(session, ui, "l1");
			const count = state.requests.length;
			await delay(2_500);
			expect(state.requests.length).toBe(count);
		},
		120_000,
	);
});
