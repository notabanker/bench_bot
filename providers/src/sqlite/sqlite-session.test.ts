import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotEvent, SessionEntry } from "@bench_bot/services";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { SqliteSession, ThreadNotFoundError } from "./sqlite-session.ts";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "bench-session-"));
  dirs.push(dir);
  return join(dir, "bench.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A clock that moves one second per call, so timestamps and ordering are predictable. */
function steppingClock(start = Date.parse("2026-10-01T10:00:00Z")) {
  let t = start;
  return () => {
    t += 1000;
    return new Date(t);
  };
}

function session(path = ":memory:") {
  let n = 0;
  return new SqliteSession(openDatabase(path), {
    now: steppingClock(),
    newThreadId: () => `thr_${++n}`,
  });
}

const userSays = (text: string): SessionEntry => ({
  kind: "message",
  from: { kind: "user" },
  text,
});
const botEvent = (event: BotEvent): SessionEntry => ({ kind: "event", runId: "run_1", event });

describe("SqliteSession", () => {
  it("creates threads and lists them per bot, newest first", async () => {
    const s = session();
    const a = await s.createThread("finance");
    const b = await s.createThread("finance", "Taxes 2026");
    await s.createThread("orchestrator");

    expect(a).toEqual({
      id: "thr_1",
      botId: "finance",
      title: "New chat",
      createdAt: "2026-10-01T10:00:01.000Z",
    });
    expect((await s.listThreads("finance")).map((t) => t.title)).toEqual([
      "Taxes 2026",
      "New chat",
    ]);
    expect(await s.getThread(b.id)).toEqual(b);
    expect(await s.getThread("thr_missing")).toBeUndefined();
  });

  it("stores messages and every kind of bot event and reads them back unchanged, in order", async () => {
    const s = session();
    const t = await s.createThread("finance");
    const events: BotEvent[] = [
      { type: "text-delta", text: "Last month: " },
      { type: "reasoning-delta", text: "sum the rows" },
      { type: "tool-call", callId: "c1", tool: "fs.read", args: { path: "sept.csv" } },
      { type: "tool-result", callId: "c1", ok: true, output: "rows…" },
      { type: "blocked", action: "sudo ls", reason: "admin rights are not allowed" },
      { type: "usage", usage: { input: 120, output: 30, cachedInput: 10 } },
      { type: "error", message: "temporary hiccup" },
      { type: "finish", reason: "done" },
    ];

    await s.append(t.id, userSays("What did I spend last month?"));
    for (const event of events) await s.append(t.id, botEvent(event));
    await s.append(t.id, {
      kind: "message",
      from: { kind: "bot", botId: "orchestrator" },
      text: "hi",
    });

    const read = await s.read(t.id);
    expect(read.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(read[0]).toMatchObject({
      kind: "message",
      from: { kind: "user" },
      text: "What did I spend last month?",
    });
    expect(read.slice(1, 9).map((e) => (e.kind === "event" ? e.event : null))).toEqual(events);
    expect(read[1]).toMatchObject({ kind: "event", runId: "run_1", threadId: t.id });
    expect(read[9]).toMatchObject({ from: { kind: "bot", botId: "orchestrator" } });
  });

  it("numbers each thread separately, without gaps", async () => {
    const s = session();
    const a = await s.createThread("finance");
    const b = await s.createThread("finance");
    await Promise.all([
      s.append(a.id, userSays("a1")),
      s.append(b.id, userSays("b1")),
      s.append(a.id, userSays("a2")),
      s.append(a.id, userSays("a3")),
    ]);
    expect((await s.read(a.id)).map((e) => [e.seq, e.kind === "message" && e.text])).toEqual([
      [1, "a1"],
      [2, "a2"],
      [3, "a3"],
    ]);
    expect((await s.read(b.id)).map((e) => e.seq)).toEqual([1]);
  });

  it("returns only newer entries with afterSeq (catching up after a reconnect)", async () => {
    const s = session();
    const t = await s.createThread("finance");
    for (const text of ["one", "two", "three"]) await s.append(t.id, userSays(text));
    expect((await s.read(t.id, { afterSeq: 2 })).map((e) => e.seq)).toEqual([3]);
    expect(await s.read(t.id, { afterSeq: 3 })).toEqual([]);
  });

  it("refuses to append to a thread that does not exist, and stores nothing", async () => {
    const s = session();
    await expect(s.append("thr_missing", userSays("hello"))).rejects.toThrow(ThreadNotFoundError);
    expect(await s.read("thr_missing")).toEqual([]);
  });

  it("gives a harness a log bound to one thread", async () => {
    const s = session();
    const mine = await s.createThread("finance");
    const other = await s.createThread("finance");
    const log = s.log(mine.id);
    await log.append(botEvent({ type: "text-delta", text: "hi" }));
    expect(log.threadId).toBe(mine.id);
    expect((await log.read()).map((e) => e.seq)).toEqual([1]);
    expect(await s.read(other.id)).toEqual([]);
  });

  it("keeps the chat after the database is closed and opened again (app restart)", async () => {
    const path = tempDbPath();
    const db1 = openDatabase(path);
    const first = new SqliteSession(db1);
    const t = await first.createThread("finance", "Budget");
    await first.append(t.id, userSays("Remember this"));
    await first.append(t.id, botEvent({ type: "finish", reason: "done" }));
    db1.close();

    const db2 = openDatabase(path);
    const second = new SqliteSession(db2);
    expect(await second.listThreads("finance")).toEqual([t]);
    const read = await second.read(t.id);
    expect(read.map((e) => e.seq)).toEqual([1, 2]);
    expect(read[0]).toMatchObject({ kind: "message", text: "Remember this" });

    // Numbering continues where it stopped.
    expect((await second.append(t.id, userSays("And this"))).seq).toBe(3);
    db2.close();
  });
});
