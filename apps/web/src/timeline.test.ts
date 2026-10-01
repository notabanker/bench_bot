import type { StoredEntry } from "@bench_bot/services";
import { describe, expect, it } from "vitest";
import { argsSummary, buildTimeline } from "./timeline.ts";

let seq = 0;
const at = "2026-10-01T10:00:00Z";
const msg = (
  text: string,
  from: StoredEntry extends never ? never : { kind: "user" } | { kind: "bot"; botId: string } = {
    kind: "user",
  },
): StoredEntry => ({ kind: "message", from, text, threadId: "t", seq: ++seq, at }) as StoredEntry;
const ev = (runId: string, event: object): StoredEntry =>
  ({ kind: "event", runId, event, threadId: "t", seq: ++seq, at }) as StoredEntry;

describe("buildTimeline", () => {
  it("groups each run into one turn, merging text pieces and pairing tool results", () => {
    const items = buildTimeline([
      msg("hi"),
      ev("r1", { type: "reasoning-delta", text: "hm" }),
      ev("r1", { type: "reasoning-delta", text: "m" }),
      ev("r1", { type: "tool-call", callId: "c1", tool: "fs_list", args: {} }),
      ev("r1", { type: "tool-result", callId: "c1", ok: true, output: "(empty)" }),
      ev("r1", { type: "text-delta", text: "Hel" }),
      ev("r1", { type: "text-delta", text: "lo" }),
      ev("r1", { type: "blocked", action: "sudo", reason: "no" }),
      ev("r1", { type: "usage", usage: { input: 1, output: 2 } }),
      ev("r1", { type: "finish", reason: "done" }),
      msg("from finance", { kind: "bot", botId: "finance" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "turn", "bot-message"]);
    const turn = items[1];
    expect(turn?.kind === "turn" && turn.parts).toEqual([
      { kind: "reasoning", text: "hmm" },
      {
        kind: "tool",
        callId: "c1",
        tool: "fs_list",
        args: {},
        result: { ok: true, output: "(empty)" },
      },
      { kind: "text", text: "Hello" },
      { kind: "blocked", action: "sudo", reason: "no" },
    ]);
    expect(turn?.kind === "turn" && [turn.finish, turn.usage]).toEqual([
      "done",
      { input: 1, output: 2 },
    ]);
  });

  it("leaves a turn without finish open (still running)", () => {
    const [, turn] = buildTimeline([msg("hi"), ev("r1", { type: "text-delta", text: "typing" })]);
    expect(turn?.kind === "turn" && turn.finish).toBeNull();
  });
});

describe("argsSummary", () => {
  it("prefers a path, shortens long JSON", () => {
    expect(argsSummary({ path: "a.txt", content: "x" })).toBe("a.txt");
    expect(argsSummary({ bot_id: "finance", message: "?" })).toBe("→ finance");
    expect(argsSummary({ long: "x".repeat(100) }).length).toBe(58);
  });
});
