import { Kernel } from "@bench_bot/kernel";
import { describe, expect, it } from "vitest";
import type { BotEvent } from "./events.ts";
import type { Harness, HarnessCatalog, HarnessFactory } from "./harness.ts";
import { Services } from "./keys.ts";
import type { StoredEntry, ThreadLog } from "./session.ts";

// Minimal fakes: they prove the interfaces can be implemented and wired through the kernel.

function memoryLog(threadId: string): ThreadLog {
  const entries: StoredEntry[] = [];
  return {
    threadId,
    async append(entry) {
      const stored = { ...entry, threadId, seq: entries.length + 1, at: new Date(0).toISOString() };
      entries.push(stored);
      return stored;
    },
    async read() {
      return [...entries];
    },
  };
}

/** Echoes the message word by word; stops early when aborted. */
function echoFactory(): HarnessFactory {
  return {
    id: "echo",
    capabilities: () => ({ resume: false, steer: false, tools: false, reasoning: false }),
    create(): Harness {
      let aborted = false;
      return {
        id: "echo",
        async start() {},
        async *send(text): AsyncIterable<BotEvent> {
          for (const word of text.split(" ")) {
            if (aborted) {
              yield { type: "finish", reason: "aborted" };
              return;
            }
            yield { type: "text-delta", text: word };
          }
          yield { type: "finish", reason: "done" };
        },
        async abort() {
          aborted = true;
        },
      };
    },
  };
}

function catalog(...factories: HarnessFactory[]): HarnessCatalog {
  return {
    get(id) {
      const factory = factories.find((f) => f.id === id);
      if (!factory) throw new Error(`Unknown harness "${id}"`);
      return factory;
    },
    ids: () => factories.map((f) => f.id),
  };
}

const ctx = (log: ThreadLog) => ({
  botId: "b1",
  threadId: log.threadId,
  runId: "r1",
  workspacePath: "/tmp/b1",
  model: "fake-model",
  instructions: "Be brief.",
  toolPolicy: { allowedTools: [] },
  sessionLog: log,
  untilSeq: 1,
  chain: ["b1"],
});

describe("service contracts", () => {
  it("wires a harness catalog through the kernel and runs a bot to a single finish", async () => {
    const kernel = new Kernel();
    kernel.register(Services.harnesses, catalog(echoFactory()));

    const harness = kernel.get(Services.harnesses).get("echo").create();
    const log = memoryLog("t1");
    await harness.start(ctx(log));

    const events: BotEvent[] = [];
    for await (const event of harness.send("hello there")) {
      events.push(event);
      await log.append({ kind: "event", runId: "r1", event });
    }

    expect(events).toEqual([
      { type: "text-delta", text: "hello" },
      { type: "text-delta", text: "there" },
      { type: "finish", reason: "done" },
    ]);
    expect((await log.read()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("ends an aborted run with reason aborted, and abort is safe twice", async () => {
    const harness = echoFactory().create();
    await harness.start(ctx(memoryLog("t2")));
    const events: BotEvent[] = [];
    for await (const event of harness.send("one two three")) {
      events.push(event);
      if (events.length === 1) {
        await harness.abort();
        await harness.abort();
      }
    }
    expect(events.at(-1)).toEqual({ type: "finish", reason: "aborted" });
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
  });

  it("uses one kernel key per service", () => {
    const names = Object.values(Services).map((key) => key.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      [
        "bots",
        "delegation",
        "fs",
        "harnesses",
        "llm",
        "policy",
        "queue",
        "session",
        "tools",
      ].sort(),
    );
  });
});
