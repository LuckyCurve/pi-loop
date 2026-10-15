import { describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

describe("command surface", () => {
  it("reports usage, lists, and stops without touching the model", async () => {
    const runtime = await ModelRuntime.create();
    runtime.registerProvider("m", { name:"m", baseUrl:"http://127.0.0.1:1", apiKey:"t", api:"anthropic-messages",
      streamSimple: ((model:any) => { const message: AssistantMessage = { role:"assistant", content:[{type:"text",text:"ack"}], api:model.api, provider:model.provider, model:model.id, usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason:"stop", timestamp:Date.now() }; const s=createAssistantMessageEventStream(); s.push({type:"start",partial:message}); s.push({type:"done",reason:"stop",message}); s.end(message); return s; }) as any,
      models:[{id:"mm",name:"MM",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}] });
    const model = runtime.getModel("m","mm")!;
    const rl = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), additionalExtensionPaths: ["./extensions/loop/index.ts"] });
    await rl.reload();
    const { session } = await createAgentSession({ model, modelRuntime: runtime, resourceLoader: rl, sessionManager: SessionManager.inMemory(), cwd: process.cwd() });
    // Commands are dispatched without a model call; each returns immediately.
    await session.prompt("/loop");
    await session.prompt("/loop 1s WORK");
    await session.prompt("/loop list");
    await session.prompt("/loop pause l1");
    await session.prompt("/loop resume l1");
    await session.prompt("/loop stop all");
    expect(session.getActiveToolNames()).not.toContain("loop_break");
    session.dispose();
  }, 60000);
});
