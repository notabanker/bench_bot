import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callTools,
  fsTools,
  LocalFs,
  openDatabase,
  reply,
  ScriptedLlm,
  SqliteSession,
  ToolRegistry,
} from "@bench_bot/providers";
import type { BotEvent, BotRunContext, PolicyService } from "@bench_bot/services";
import { afterEach, describe, expect, it } from "vitest";
import { GenericLoopFactory } from "./generic-loop.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(options: { policy?: PolicyService } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "bench-loop-"));
  dirs.push(ws);
  const session = new SqliteSession(openDatabase(":memory:"));
  const thread = await session.createThread("b1");
  const tools = new ToolRegistry();
  for (const t of fsTools(new LocalFs(), options.policy)) tools.register(t);
  const ctx = async (overrides: Partial<BotRunContext> = {}): Promise<BotRunContext> => {
    const last = (await session.read(thread.id)).at(-1)?.seq ?? 0;
    return {
      botId: "b1",
      threadId: thread.id,
      runId: "r1",
      workspacePath: ws,
      model: "test-model",
      instructions: "You are a test bot.",
      toolPolicy: { allowedTools: ["fs_read", "fs_write", "fs_list"] },
      sessionLog: session.log(thread.id),
      untilSeq: last + 1,
      chain: ["b1"],
      ...overrides,
    };
  };
  return { ws, session, thread, tools, ctx };
}

async function run(factory: GenericLoopFactory, ctx: BotRunContext, text: string) {
  const harness = factory.create();
  await harness.start(ctx);
  const events: BotEvent[] = [];
  for await (const e of harness.send(text)) events.push(e);
  return events;
}

const finishes = (events: BotEvent[]) => events.filter((e) => e.type === "finish");

describe("generic loop", () => {
  it("answers in one step and sends instructions, tools and the message to the model", async () => {
    const { tools, ctx } = await setup();
    const llm = new ScriptedLlm([
      [
        ...reply("Hello!").slice(0, -1),
        { type: "usage", usage: { input: 5, output: 1 } },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const events = await run(new GenericLoopFactory({ llm, tools }), await ctx(), "Hi");

    expect(events).toEqual([
      { type: "text-delta", text: "Hello!" },
      { type: "usage", usage: { input: 5, output: 1 } },
      { type: "finish", reason: "done" },
    ]);
    const req = llm.requests[0];
    expect(req?.model).toBe("test-model");
    expect(req?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("You are a test bot."),
    });
    expect(req?.messages.at(-1)).toEqual({ role: "user", content: "Hi" });
    expect(req?.tools?.map((t) => t.name)).toEqual(["fs_read", "fs_write", "fs_list"]);
  });

  it("runs tool calls, feeds results back and finishes with the model's answer", async () => {
    const { ws, tools, ctx } = await setup();
    const llm = new ScriptedLlm([
      callTools({ callId: "c1", name: "fs_write", args: { path: "note.txt", content: "milk" } }),
      reply("Saved."),
    ]);
    const events = await run(new GenericLoopFactory({ llm, tools }), await ctx(), "Remember milk");

    expect(events).toEqual([
      {
        type: "tool-call",
        callId: "c1",
        tool: "fs_write",
        args: { path: "note.txt", content: "milk" },
      },
      { type: "tool-result", callId: "c1", ok: true, output: "Wrote 4 characters to note.txt" },
      { type: "text-delta", text: "Saved." },
      { type: "finish", reason: "done" },
    ]);
    expect(readFileSync(join(ws, "note.txt"), "utf8")).toBe("milk");
    expect(llm.requests[1]?.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { callId: "c1", name: "fs_write", args: { path: "note.txt", content: "milk" } },
        ],
      },
      { role: "tool", callId: "c1", content: "Wrote 4 characters to note.txt" },
    ]);
  });

  it("refuses tools the bot is not allowed to use and reports policy blocks", async () => {
    const policy: PolicyService = { check: () => ({ allow: false, reason: "not today" }) };
    const { tools, ctx } = await setup({ policy });
    const llm = new ScriptedLlm([
      callTools(
        { callId: "c1", name: "fs_list", args: {} },
        { callId: "c2", name: "fs_write", args: { path: "a", content: "" } },
      ),
      reply("ok"),
    ]);
    const events = await run(
      new GenericLoopFactory({ llm, tools }),
      await ctx({ toolPolicy: { allowedTools: ["fs_write"] } }),
      "go",
    );

    expect(events.slice(0, 5)).toEqual([
      { type: "tool-call", callId: "c1", tool: "fs_list", args: {} },
      {
        type: "tool-result",
        callId: "c1",
        ok: false,
        output: 'Tool "fs_list" is not available to this bot',
      },
      { type: "tool-call", callId: "c2", tool: "fs_write", args: { path: "a", content: "" } },
      { type: "blocked", action: "write a", reason: "not today" },
      {
        type: "tool-result",
        callId: "c2",
        ok: false,
        output: "Refused by the safety rules: not today",
      },
    ]);
  });

  it("stops with max-steps when the model keeps calling tools", async () => {
    const { tools, ctx } = await setup();
    const loop = Array.from({ length: 3 }, (_, i) =>
      callTools({ callId: `c${i}`, name: "fs_list", args: {} }),
    );
    const events = await run(
      new GenericLoopFactory({ llm: new ScriptedLlm(loop), tools, maxSteps: 3 }),
      await ctx(),
      "loop",
    );
    expect(finishes(events)).toEqual([{ type: "finish", reason: "max-steps" }]);
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(3);
  });

  it("ends with exactly one aborted finish when stopped mid-answer", async () => {
    const { tools, ctx } = await setup();
    const harness = new GenericLoopFactory({
      llm: new ScriptedLlm([reply("one two three four")]),
      tools,
    }).create();
    await harness.start(await ctx());
    const events: BotEvent[] = [];
    for await (const e of harness.send("talk")) {
      events.push(e);
      if (events.length === 1) {
        await harness.abort();
        await harness.abort();
      }
    }
    expect(events.at(-1)).toEqual({ type: "finish", reason: "aborted" });
    expect(finishes(events)).toHaveLength(1);
  });

  it("passes model errors through and finishes with error", async () => {
    const { tools, ctx } = await setup();
    const llm = new ScriptedLlm([
      [
        { type: "error", message: "Missing API key." },
        { type: "finish", reason: "error" },
      ],
    ]);
    expect(await run(new GenericLoopFactory({ llm, tools }), await ctx(), "hi")).toEqual([
      { type: "error", message: "Missing API key." },
      { type: "finish", reason: "error" },
    ]);
  });

  it("errors cleanly when send is called without start", async () => {
    const { tools } = await setup();
    const harness = new GenericLoopFactory({ llm: new ScriptedLlm([]), tools }).create();
    const events: BotEvent[] = [];
    for await (const e of harness.send("hi")) events.push(e);
    expect(events).toEqual([
      { type: "error", message: "The run was not started" },
      { type: "finish", reason: "error" },
    ]);
  });

  it("rebuilds earlier turns from the log and ignores messages queued after this one", async () => {
    const { session, thread, tools, ctx } = await setup();
    const user = (text: string) =>
      session.append(thread.id, { kind: "message", from: { kind: "user" }, text });
    const ev = (runId: string, event: BotEvent) =>
      session.append(thread.id, { kind: "event", runId, event });

    await user("first question");
    await ev("r0", { type: "tool-call", callId: "c0", tool: "fs_list", args: {} });
    await ev("r0", { type: "tool-result", callId: "c0", ok: true, output: "(empty)" });
    await ev("r0", { type: "text-delta", text: "first answer" });
    await ev("r0", { type: "finish", reason: "done" });
    await ev("r1", { type: "tool-call", callId: "lost", tool: "fs_list", args: {} });
    await ev("r1", { type: "finish", reason: "aborted" });
    const current = await user("second question");
    await user("queued later, not part of this run");

    const llm = new ScriptedLlm([reply("ok")]);
    await run(
      new GenericLoopFactory({ llm, tools }),
      await ctx({ untilSeq: current.seq }),
      "second question",
    );

    expect(llm.requests[0]?.messages.slice(1)).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "", toolCalls: [{ callId: "c0", name: "fs_list", args: {} }] },
      { role: "tool", callId: "c0", content: "(empty)" },
      { role: "assistant", content: "first answer" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ callId: "lost", name: "fs_list", args: {} }],
      },
      { role: "tool", callId: "lost", content: "(no result: the run was stopped)" },
      { role: "user", content: "second question" },
    ]);
  });
});
