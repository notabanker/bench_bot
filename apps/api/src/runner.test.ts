import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericLoopFactory, HarnessRegistry } from "@bench_bot/harnesses";
import {
  openDatabase,
  RunStore,
  reply,
  ScriptedLlm,
  SqliteSession,
  ToolRegistry,
} from "@bench_bot/providers";
import type {
  BotDefinition,
  BotEvent,
  Harness,
  HarnessFactory,
  StoredEntry,
} from "@bench_bot/services";
import { afterEach, describe, expect, it } from "vitest";
import { StaticBotDirectory } from "./bots-static.ts";
import { Hub, LiveSession } from "./hub.ts";
import { BotRunner } from "./runner.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bot(id: string, harness = "generic-loop"): BotDefinition {
  const ws = mkdtempSync(join(tmpdir(), `bench-${id}-`));
  dirs.push(ws);
  return {
    id,
    name: id,
    description: "",
    instructions: "test",
    model: "m",
    harness,
    tools: [],
    workspacePath: ws,
  };
}

/** A harness that waits until released, so tests can observe queueing. */
function gateFactory(id = "gate") {
  const gates: Array<() => void> = [];
  const factory: HarnessFactory = {
    id,
    capabilities: () => ({ resume: false, steer: false, tools: false, reasoning: false }),
    create(): Harness {
      let aborted = false;
      let release: () => void = () => {};
      return {
        id,
        async start() {},
        async *send(text) {
          await new Promise<void>((r) => {
            release = r;
            gates.push(r);
          });
          if (aborted) {
            yield { type: "finish", reason: "aborted" } as BotEvent;
            return;
          }
          yield { type: "text-delta", text: `done: ${text}` };
          yield { type: "finish", reason: "done" };
        },
        async abort() {
          aborted = true;
          release();
        },
      };
    },
  };
  /** Releases the oldest waiting run, waiting first until one is actually waiting. */
  const releaseNext = async () => {
    for (let i = 0; gates.length === 0 && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    gates.shift()?.();
  };
  return { factory, releaseNext };
}

async function setup(extra: HarnessFactory[] = [], llm = new ScriptedLlm([])) {
  const db = openDatabase(":memory:");
  const hub = new Hub();
  const session = new LiveSession(new SqliteSession(db), hub);
  const runs = new RunStore(db);
  const harnesses = new HarnessRegistry([
    new GenericLoopFactory({ llm, tools: new ToolRegistry() }),
    ...extra,
  ]);
  const bots = new StaticBotDirectory([
    bot("a"),
    bot("b"),
    bot("g1", "gate"),
    bot("g2", "gate"),
    bot("x", "nope"),
  ]);
  let n = 0;
  const runner = new BotRunner({
    bots,
    harnesses,
    session,
    runs,
    hub,
    newRunId: () => `run_${++n}`,
  });
  const send = async (botId: string, threadId: string, text: string, id = `d_${text}`) => {
    const entry = await session.append(threadId, { kind: "message", from: { kind: "user" }, text });
    return runner.enqueue({
      id,
      botId,
      threadId,
      from: { kind: "user" },
      text,
      seq: entry.seq,
      chain: [botId],
    });
  };
  return { session, runs, runner, hub, send };
}

const events = (entries: StoredEntry[]) =>
  entries.flatMap((e) => (e.kind === "event" ? [e.event] : []));

describe("BotRunner", () => {
  it("runs a message, writes every event to the log and records the run", async () => {
    const llm = new ScriptedLlm([reply("hi there")]);
    const { session, runs, runner, send } = await setup([], llm);
    const t = await session.createThread("a");
    expect(await send("a", t.id, "hello")).toBe(0);
    const outcome = await runner.whenDone("d_hello");

    expect(outcome).toEqual({ runId: "run_1", reason: "done", text: "hi there" });
    expect(events(await session.read(t.id))).toEqual([
      { type: "text-delta", text: "hi " },
      { type: "text-delta", text: "there" },
      { type: "finish", reason: "done" },
    ]);
    expect(runs.get("run_1")?.status).toBe("done");
  });

  it("runs one message per bot at a time, in order; other bots run in parallel", async () => {
    const gate = gateFactory();
    const { session, runner, send } = await setup([gate.factory]);
    const t1 = await session.createThread("g1");
    const t2 = await session.createThread("g2");

    expect(await send("g1", t1.id, "one")).toBe(0);
    expect(await send("g1", t1.id, "two")).toBe(1);
    expect(await send("g2", t2.id, "other")).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.isRunning("g1")).toBe(true);
    expect(runner.isRunning("g2")).toBe(true);
    expect(runner.pending("g1")).toBe(1);

    await gate.releaseNext();
    expect((await runner.whenDone("d_one")).text).toBe("done: one");
    await gate.releaseNext();
    await gate.releaseNext();
    expect((await runner.whenDone("d_two")).text).toBe("done: two");
    expect((await runner.whenDone("d_other")).text).toBe("done: other");
  });

  it("stops the running message of a thread and drops its queued ones", async () => {
    const gate = gateFactory();
    const { session, runner, runs, send } = await setup([gate.factory]);
    const t = await session.createThread("g1");
    await send("g1", t.id, "running");
    await send("g1", t.id, "queued");
    await new Promise((r) => setTimeout(r, 10));

    await runner.abortThread(t.id);
    expect(await runner.whenDone("d_running")).toMatchObject({ reason: "aborted" });
    expect(await runner.whenDone("d_queued")).toEqual({ runId: "", reason: "aborted", text: "" });
    expect(runs.listForThread(t.id).map((r) => r.status)).toEqual(["aborted"]);
  });

  it("holds a paused bot's line until resumed", async () => {
    const llm = new ScriptedLlm([reply("later")]);
    const { session, runner, send } = await setup([], llm);
    const t = await session.createThread("a");
    runner.pause("a");
    await send("a", t.id, "wait");
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.pending("a")).toBe(1);
    runner.resume("a");
    expect((await runner.whenDone("d_wait")).text).toBe("later");
  });

  it("finishes with an error for unknown bots and unknown harnesses", async () => {
    const { session, runner } = await setup();
    const t1 = await session.createThread("x");
    const t2 = await session.createThread("ghost");
    const base = { from: { kind: "user" as const }, text: "?", seq: 1 };
    runner.enqueue({ ...base, id: "d1", botId: "x", threadId: t1.id, chain: ["x"] });
    runner.enqueue({ ...base, id: "d2", botId: "ghost", threadId: t2.id, chain: ["ghost"] });
    expect((await runner.whenDone("d1")).reason).toBe("error");
    expect((await runner.whenDone("d2")).reason).toBe("error");
    expect(events(await session.read(t1.id))).toEqual([
      { type: "error", message: 'No harness "nope" is registered' },
      { type: "finish", reason: "error" },
    ]);
    expect(events(await session.read(t2.id))).toEqual([
      { type: "error", message: 'Unknown bot "ghost"' },
      { type: "finish", reason: "error" },
    ]);
  });

  it("adds a finish when an engine stops without one, and survives an engine that throws", async () => {
    const quiet: HarnessFactory = {
      id: "gate",
      capabilities: () => ({ resume: false, steer: false, tools: false, reasoning: false }),
      create: () => ({
        id: "gate",
        async start() {},
        async *send() {
          yield { type: "text-delta", text: "half" } as BotEvent;
        },
        async abort() {},
      }),
    };
    const { session, runner, send } = await setup([quiet]);
    const t = await session.createThread("g1");
    await send("g1", t.id, "hi");
    expect(await runner.whenDone("d_hi")).toMatchObject({ reason: "error", text: "half" });
    expect(events(await session.read(t.id)).at(-1)).toEqual({ type: "finish", reason: "error" });
  });

  it("announces new entries and run status on the hub", async () => {
    const { session, runner, hub, send } = await setup([], new ScriptedLlm([reply("x")]));
    const t = await session.createThread("a");
    const seen: string[] = [];
    hub.onEntry((e) => seen.push(e.kind === "event" ? e.event.type : "message"));
    hub.onRun((r) => seen.push(`run:${r.status}`));
    await send("a", t.id, "go");
    await runner.whenDone("d_go");
    expect(seen).toEqual(["message", "run:running", "text-delta", "finish", "run:done"]);
  });
});
