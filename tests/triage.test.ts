/**
 * Reproduces the target workflow end to end: a /loop over a defect backlog where the agent
 * either fixes a clear ticket or breaks the loop to ask about an ambiguous one.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { isLoopInjection } from "../src/commands.ts";
import { removeLoop, scriptedUI } from "./helpers/scripted-ui.ts";

describe("triage workflow", () => {
  it("fixes clear tickets and breaks the loop on an ambiguous one", async () => {
    const requests: { text: string; tools: string[] }[] = [];
    const runtime = await ModelRuntime.create();
    runtime.registerProvider("m", {
      name: "m", baseUrl: "http://127.0.0.1:1", apiKey: "t", api: "anthropic-messages",
      streamSimple: ((model: any, context: any) => {
        const tools = (getCurrentTools(context.messages) as any[]).map((t) => t.name);
        const lastUser = [...context.messages].reverse().find((m: any) => m.role === "user");
        const text =
          typeof lastUser?.content === "string"
            ? lastUser.content
            : ((lastUser?.content ?? []) as { type: string; text?: string }[])
                .filter((part) => part.type === "text")
                .map((part) => part.text ?? "")
                .join(String.fromCharCode(10));
        const index = requests.push({ text, tools }) - 1;
        // First iteration sees the ambiguous ticket -> break the loop; later ones proceed.
        const wantBreak = index === 0 && text.includes("BUG-101") && tools.includes("loop_break");
        const content: any[] = wantBreak
          ? [{ type: "toolCall", id: "c1", name: "loop_break", arguments: { reason: "BUG-101 缺少期望行为与验收标准" } }]
          : [{ type: "text", text: "ack" }];
        const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: wantBreak ? "toolUse" : "stop", timestamp: Date.now() };
        const s = createAssistantMessageEventStream();
        s.push({ type: "start", partial: message });
        if (wantBreak) s.push({ type: "toolcall_end", contentIndex: 0, toolCall: content[0], partial: message });
        s.push({ type: "done", reason: wantBreak ? "toolUse" : "stop", message } as any);
        s.end(message);
        return s;
      }) as any,
      models: [{ id: "mm", name: "MM", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    });
    const model = runtime.getModel("m", "mm")!;
    const rl = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), additionalExtensionPaths: ["./extensions/loop/index.ts"], noExtensions: true });
    await rl.reload();
    const { session } = await createAgentSession({ model, modelRuntime: runtime, resourceLoader: rl, sessionManager: SessionManager.inMemory(), cwd: process.cwd() });
    const ui = scriptedUI();
    await session.bindExtensions({ uiContext: ui.ui, mode: "tui" });

    await session.prompt("/loop 1s 检查缺陷单 BUG-101 BUG-102，清晰就修复，不清晰就阻断");
    await session.waitForIdle();
    await delay(2500);
    // Paused: no new *iteration*. The follow-up turns inside the breaking run share the same
    // loop header, so assert on the run counter rather than the raw request count.
    expect(requests.some((r) => /· run 2 ·/.test(r.text)), "paused loop must not start run 2").toBe(false);

    // The user answers; the loop resumes and proceeds.
    await session.prompt("期望行为：超时后重试 3 次；验收标准：90s 内给出最终状态");
        const deadline = Date.now() + 15000;
    while (!requests.some((r) => /· run 2 ·/.test(r.text)) && Date.now() < deadline) await delay(50);
    expect(requests.some((r) => /· run 2 ·/.test(r.text)), "loop resumed after the answer").toBe(true);
    expect(requests.every((r) => r.text.includes("BUG-101") || !isLoopInjection(r.text))).toBe(true);

        await session.waitForIdle();
    await removeLoop(session, ui, "l1");
    session.dispose();
  }, 90000);
});
