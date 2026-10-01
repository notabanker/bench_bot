import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTools, reply, ScriptedLlm } from "@bench_bot/providers";
import {
  type BotDefinition,
  type BotEvent,
  type HarnessFactory,
  Services,
  type StoredEntry,
} from "@bench_bot/services";
import { afterEach, describe, expect, it } from "vitest";
import { StaticBotDirectory } from "./bots-static.ts";
import { compose } from "./compose.ts";
import { BotDelegation } from "./delegation.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function bot(id: string, tools: string[] = ["list_bots", "ask_bot"]): BotDefinition {
  return {
    id,
    name: id[0]?.toUpperCase() + id.slice(1),
    description: `${id} bot`,
    instructions: `You are ${id}.`,
    model: "m",
    harness: "generic-loop",
    tools,
    workspacePath: `/tmp/ws-${id}`,
  };
}

async function setup(
  llm: ScriptedLlm,
  bots = [bot("orch"), bot("fin", [])],
  harnesses: HarnessFactory[] = [],
) {
  const dataDir = mkdtempSync(join(tmpdir(), "bench-deleg-"));
  const config = {
    repoRoot: dataDir,
    dataDir,
    botsDir: dataDir,
    llmBaseUrl: "x",
    apiKey: undefined,
    defaultModel: "m",
    host: "127.0.0.1",
    port: 0,
  };
  const services = await compose(config, { llm, bots: new StaticBotDirectory(bots), harnesses });
  cleanups.push(
    () => rmSync(dataDir, { recursive: true, force: true }),
    () => services.close(),
  );
  const session = services.kernel.get(Services.session);
  const ask = async (botId: string, text: string) => {
    const thread = await session.createThread(botId);
    const entry = await session.append(thread.id, {
      kind: "message",
      from: { kind: "user" },
      text,
    });
    services.runner.enqueue({
      id: `d_${text}`,
      botId,
      threadId: thread.id,
      from: { kind: "user" },
      text,
      seq: entry.seq,
      chain: [botId],
    });
    return { thread, outcome: await services.runner.whenDone(`d_${text}`) };
  };
  return { services, session, ask };
}

const toolResults = (entries: StoredEntry[]) =>
  entries.flatMap((e) => (e.kind === "event" && e.event.type === "tool-result" ? [e.event] : []));

describe("delegation end to end", () => {
  it("lets one bot ask another and use the answer", async () => {
    const llm = new ScriptedLlm([
      callTools({
        callId: "c1",
        name: "ask_bot",
        args: { bot_id: "fin", message: "What is 12 * 3.5?" },
      }),
      reply("42"),
      (req) => reply(`Finance says ${(req.messages.at(-1) as { content: string }).content}.`),
    ]);
    const { session, ask } = await setup(llm);
    const { thread, outcome } = await ask("orch", "Ask finance for 12 * 3.5");

    expect(outcome).toMatchObject({ reason: "done", text: "Finance says 42." });
    expect(toolResults(await session.read(thread.id))).toEqual([
      { type: "tool-result", callId: "c1", ok: true, output: "42" },
    ]);

    const [finThread] = await session.listThreads("fin");
    expect(finThread?.title).toBe("Asked by orch");
    const finEntries = await session.read(finThread?.id ?? "");
    expect(finEntries[0]).toMatchObject({
      kind: "message",
      from: { kind: "bot", botId: "orch" },
      text: "What is 12 * 3.5?",
    });
    // The asked bot saw the question as a message from a bot.
    expect(llm.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "What is 12 * 3.5?",
    });
  });

  it("reuses one standing thread per pair of bots", async () => {
    const llm = new ScriptedLlm([
      callTools({ callId: "c1", name: "ask_bot", args: { bot_id: "fin", message: "one" } }),
      reply("1"),
      reply("ok"),
      callTools({ callId: "c2", name: "ask_bot", args: { bot_id: "Fin", message: "two" } }),
      reply("2"),
      reply("ok"),
    ]);
    const { session, ask } = await setup(llm);
    await ask("orch", "first");
    await ask("orch", "second");
    const threads = await session.listThreads("fin");
    expect(threads).toHaveLength(1);
    expect(
      (await session.read(threads[0]?.id ?? "")).filter((e) => e.kind === "message"),
    ).toHaveLength(2);
  });

  it("refuses loops: the asked bot cannot ask back up the chain", async () => {
    const llm = new ScriptedLlm([
      callTools({ callId: "c1", name: "ask_bot", args: { bot_id: "fin", message: "help" } }),
      callTools({
        callId: "c2",
        name: "ask_bot",
        args: { bot_id: "orch", message: "you help me" },
      }),
      reply("did it alone"),
      reply("done"),
    ]);
    const { session, ask } = await setup(llm, [bot("orch"), bot("fin")]);
    await ask("orch", "go");
    const [finThread] = await session.listThreads("fin");
    expect(toolResults(await session.read(finThread?.id ?? ""))[0]).toMatchObject({
      ok: false,
      output: expect.stringContaining("already part of this request (orch → fin)"),
    });
  });
});

describe("delegation and Stop", () => {
  it("stops the asked bot when the asking bot is stopped", async () => {
    let finAborted = false;
    const waiting: HarnessFactory = {
      id: "waiting",
      capabilities: () => ({ resume: false, steer: false, tools: false, reasoning: false }),
      create: () => {
        let release = () => {};
        return {
          id: "waiting",
          async start() {},
          async *send() {
            await new Promise<void>((r) => {
              release = r;
            });
            yield { type: "finish", reason: finAborted ? "aborted" : "done" } as BotEvent;
          },
          async abort() {
            finAborted = true;
            release();
          },
        };
      },
    };
    const llm = new ScriptedLlm([
      callTools({ callId: "c1", name: "ask_bot", args: { bot_id: "fin", message: "slow" } }),
    ]);
    const fin = { ...bot("fin", []), harness: "waiting" };
    const { services, session } = await setup(llm, [bot("orch"), fin], [waiting]);
    const thread = await session.createThread("orch");
    const entry = await session.append(thread.id, {
      kind: "message",
      from: { kind: "user" },
      text: "go",
    });
    services.runner.enqueue({
      id: "d1",
      botId: "orch",
      threadId: thread.id,
      from: { kind: "user" },
      text: "go",
      seq: entry.seq,
      chain: ["orch"],
    });
    for (let i = 0; !services.runner.isRunning("fin") && i < 100; i++)
      await new Promise((r) => setTimeout(r, 5));

    await services.runner.abortThread(thread.id);
    expect((await services.runner.whenDone("d1")).reason).toBe("aborted");
    expect(finAborted).toBe(true);
  });
});

describe("BotDelegation refusals", () => {
  const fakeQueue = {
    enqueue: () => 0,
    whenDone: async () => ({ runId: "r", reason: "done" as const, text: "x" }),
    abortThread: async () => {},
    pending: () => 0,
    isRunning: () => false,
    pause() {},
    resume() {},
    isPaused: () => false,
  };
  const fakeSession = {
    listThreads: async () => [],
    createThread: async (botId: string, title = "") => ({ id: "t", botId, title, createdAt: "" }),
    append: async () => ({
      kind: "message",
      from: { kind: "user" },
      text: "",
      threadId: "t",
      seq: 1,
      at: "",
    }),
  } as never;
  const d = new BotDelegation({
    bots: new StaticBotDirectory([bot("a"), bot("b"), bot("c"), bot("d")]),
    session: fakeSession,
    queue: fakeQueue,
    maxChain: 3,
  });

  it("lists teammates without the caller", async () => {
    expect((await d.listBots("a")).map((b) => b.id)).toEqual(["b", "c", "d"]);
  });

  it.each([
    [{ toBotId: "a", chain: ["a"] }, "A bot cannot ask itself."],
    [{ toBotId: "zz", chain: ["a"] }, 'No bot "zz". Teammates: b, c, d'],
    [
      { toBotId: "d", chain: ["a", "b", "c"] },
      "Too many hand-offs (a → b → c); answer with what you have.",
    ],
  ])("refuses %j", async (req, reason) => {
    expect(await d.askBot({ fromBotId: "a", text: "?", ...req })).toEqual({ ok: false, reason });
  });

  it("gives up after the timeout", async () => {
    const slow = { ...fakeQueue, whenDone: () => new Promise<never>(() => {}) };
    const quick = new BotDelegation({
      bots: new StaticBotDirectory([bot("a"), bot("b")]),
      session: fakeSession,
      queue: slow,
      timeoutMs: 20,
    });
    expect(await quick.askBot({ fromBotId: "a", toBotId: "b", text: "?", chain: ["a"] })).toEqual({
      ok: false,
      reason: "B did not answer in time; it may still be working.",
    });
  });
});
