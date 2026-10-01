import type { LlmChunk } from "@bench_bot/services";
import { describe, expect, it } from "vitest";
import { callTools, EchoLlm, reply, ScriptedLlm } from "./scripted.ts";

async function all(it: AsyncIterable<LlmChunk>) {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("ScriptedLlm", () => {
  it("plays turns in order, records requests, and errors when the script runs out", async () => {
    const llm = new ScriptedLlm([
      reply("hi there"),
      callTools({ callId: "c1", name: "t", args: {} }),
    ]);
    expect(
      await all(llm.stream({ model: "m", messages: [{ role: "user", content: "1" }] })),
    ).toEqual([
      { type: "text-delta", text: "hi " },
      { type: "text-delta", text: "there" },
      { type: "finish", reason: "stop" },
    ]);
    expect((await all(llm.stream({ model: "m", messages: [] }))).at(-1)).toEqual({
      type: "finish",
      reason: "tool-calls",
    });
    expect((await all(llm.stream({ model: "m", messages: [] }))).at(-1)).toEqual({
      type: "finish",
      reason: "error",
    });
    expect(llm.requests[0]?.messages).toEqual([{ role: "user", content: "1" }]);
  });

  it("stops with aborted when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = new ScriptedLlm([reply("never seen")]);
    expect(await all(llm.stream({ model: "m", messages: [], signal: controller.signal }))).toEqual([
      { type: "finish", reason: "aborted" },
    ]);
  });

  it("EchoLlm repeats the last user message", async () => {
    const text = (
      await all(new EchoLlm().stream({ model: "m", messages: [{ role: "user", content: "ping" }] }))
    )
      .map((c) => (c.type === "text-delta" ? c.text : ""))
      .join("");
    expect(text).toContain("You said: ping");
  });
});
