import { describe, expect, it } from "vitest";
import { type BotEvent, isFinish } from "./events.ts";

describe("BotEvent", () => {
  it("marks only finish as the terminal event", () => {
    const events: BotEvent[] = [
      { type: "text-delta", text: "Hi" },
      { type: "reasoning-delta", text: "thinking" },
      { type: "tool-call", callId: "c1", tool: "fs.read", args: { path: "a.txt" } },
      { type: "tool-result", callId: "c1", ok: true, output: "content" },
      { type: "blocked", action: "sudo reboot", reason: "admin rights are not allowed" },
      { type: "usage", usage: { input: 10, output: 5 } },
      { type: "error", message: "network down" },
      { type: "finish", reason: "error" },
    ];
    expect(events.filter(isFinish)).toEqual([{ type: "finish", reason: "error" }]);
  });
});
