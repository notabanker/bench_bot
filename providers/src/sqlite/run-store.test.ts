import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { RunStore } from "./run-store.ts";
import { SqliteSession } from "./sqlite-session.ts";

async function setup() {
  const db = openDatabase(":memory:");
  const thread = await new SqliteSession(db).createThread("b1");
  let t = Date.parse("2026-10-01T10:00:00Z");
  const runs = new RunStore(db, () => {
    t += 1000;
    return new Date(t);
  });
  return { runs, thread };
}

describe("RunStore", () => {
  it("records a run from start to finish with usage", async () => {
    const { runs, thread } = await setup();
    runs.start({ id: "r1", threadId: thread.id, botId: "b1", harness: "generic-loop", model: "m" });
    expect(runs.get("r1")?.status).toBe("running");
    runs.finish("r1", "done", { input: 10, output: 4, cachedInput: 2 });
    expect(runs.get("r1")).toMatchObject({
      status: "done",
      finishedAt: "2026-10-01T10:00:02.000Z",
      usage: { input: 10, output: 4, cachedInput: 2 },
    });
  });

  it("never changes a run that already finished", async () => {
    const { runs, thread } = await setup();
    runs.start({ id: "r1", threadId: thread.id, botId: "b1", harness: "h", model: "m" });
    runs.finish("r1", "aborted");
    runs.finish("r1", "done");
    expect(runs.get("r1")?.status).toBe("aborted");
  });

  it("marks runs left running by a crash as interrupted", async () => {
    const { runs, thread } = await setup();
    runs.start({ id: "r1", threadId: thread.id, botId: "b1", harness: "h", model: "m" });
    runs.start({ id: "r2", threadId: thread.id, botId: "b1", harness: "h", model: "m" });
    runs.finish("r2", "done");
    expect(runs.markInterrupted().map((r) => r.id)).toEqual(["r1"]);
    expect(runs.listForThread(thread.id).map((r) => r.status)).toEqual(["interrupted", "done"]);
  });
});
