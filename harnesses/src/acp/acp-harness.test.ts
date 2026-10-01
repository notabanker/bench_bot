import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SafetyPolicy, SqliteSession } from "@bench_bot/providers";
import type { BotEvent, BotRunContext } from "@bench_bot/services";
import { afterEach, describe, expect, it } from "vitest";
import { AcpHarnessFactory, type AcpHarnessOptions } from "./acp-harness.ts";

const FAKE_AGENT = join(import.meta.dirname, "..", "..", "test", "fake-acp-agent.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(options: Partial<AcpHarnessOptions> = {}) {
  const ws = mkdtempSync(join(tmpdir(), "bench-acp-"));
  dirs.push(ws);
  const session = new SqliteSession(openDatabase(":memory:"));
  const thread = await session.createThread("bot");
  const factory = new AcpHarnessFactory({
    id: "fake",
    displayName: "FakeAgent",
    program: "fake-agent",
    args: [FAKE_AGENT],
    installHint: "Install it with: brew install fake-agent",
    resolveProgram: () => process.execPath,
    policy: new SafetyPolicy({ home: "/Users/test", protectedPaths: ["/opt/bench"] }),
    ...options,
  });
  const ctx = async (overrides: Partial<BotRunContext> = {}): Promise<BotRunContext> => ({
    botId: "bot",
    threadId: thread.id,
    runId: "r1",
    workspacePath: ws,
    model: "kimi-k3",
    instructions: "You are a test bot.",
    toolPolicy: { allowedTools: [] },
    sessionLog: session.log(thread.id),
    untilSeq: ((await session.read(thread.id)).at(-1)?.seq ?? 0) + 1,
    chain: ["bot"],
    ...overrides,
  });
  const run = async (
    text: string,
    overrides: Partial<BotRunContext> = {},
    onEvent?: (e: BotEvent, h: { abort(): Promise<void> }) => void,
  ) => {
    const harness = factory.create();
    await harness.start(await ctx(overrides));
    const events: BotEvent[] = [];
    for await (const e of harness.send(text)) {
      events.push(e);
      onEvent?.(e, harness);
    }
    return events;
  };
  return { factory, session, thread, run };
}

const text = (events: BotEvent[]) =>
  events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");

describe("ACP harness", () => {
  it("streams an answer with thinking and usage, then finishes", async () => {
    const { run } = await setup();
    expect(await run("hello")).toEqual([
      { type: "reasoning-delta", text: "greet" },
      { type: "text-delta", text: "Hi " },
      { type: "text-delta", text: "there" },
      { type: "usage", usage: { input: 10, output: 3 } },
      { type: "finish", reason: "done" },
    ]);
  });

  it("selects the bot's model from the engine's menu (also without the provider prefix)", async () => {
    const { run } = await setup();
    expect(text(await run("which model"))).toBe("opencode-go/kimi-k3");
  });

  it("warns and keeps the default when the model is not offered", async () => {
    const { run } = await setup();
    const events = await run("which model", { model: "gpt-unknown" });
    expect(events[0]).toEqual({
      type: "error",
      message:
        'Model "gpt-unknown" is not available in FakeAgent; using "opencode/big-pickle". Sign in or set OPENCODE_API_KEY to unlock it.',
    });
    expect(text(events)).toBe("opencode/big-pickle");
  });

  it("allows harmless commands through the safety policy", async () => {
    const { run } = await setup();
    const events = await run("run ls -la");
    expect(events).toContainEqual({
      type: "tool-call",
      callId: "t1",
      tool: "execute",
      args: { command: "ls -la" },
    });
    expect(events).toContainEqual({
      type: "tool-result",
      callId: "t1",
      ok: true,
      output: "file.txt",
    });
    expect(events.some((e) => e.type === "blocked")).toBe(false);
  });

  it("refuses blocked commands and notes it in the chat", async () => {
    const { run } = await setup();
    const events = await run("run sudo rm -rf /");
    expect(events).toContainEqual({
      type: "blocked",
      action: "sudo rm -rf /",
      reason: "admin rights (sudo) are not allowed",
    });
    expect(events).toContainEqual({
      type: "tool-result",
      callId: "t1",
      ok: false,
      output: "denied",
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "done" });
  });

  it("includes instructions and recent chat history in the prompt", async () => {
    const { session, thread, run } = await setup();
    await session.append(thread.id, {
      kind: "message",
      from: { kind: "user" },
      text: "My name is Flo.",
    });
    await session.append(thread.id, {
      kind: "event",
      runId: "r0",
      event: { type: "text-delta", text: "Nice to meet you." },
    });
    const prompt = text(await run("echo prompt"));
    expect(prompt).toContain("[Your role]\nYou are a test bot.");
    expect(prompt).toContain("User: My name is Flo.\n\nYou: Nice to meet you.");
    expect(prompt.endsWith("[New message]\necho prompt")).toBe(true);
  });

  it("stops on abort with exactly one aborted finish", async () => {
    const { run } = await setup();
    const events = await run("slow", {}, (e, h) => {
      if (e.type === "text-delta") void h.abort();
    });
    expect(events.filter((e) => e.type === "finish")).toEqual([
      { type: "finish", reason: "aborted" },
    ]);
  });

  it("reports a crashing program as an error with its last stderr line", async () => {
    const { run } = await setup();
    const events = await run("crash");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "error" });
    expect(events.find((e) => e.type === "error")).toMatchObject({
      message: expect.stringContaining("fatal: boom"),
    });
  });

  it("answers with a clear stand-in when the program is not installed", async () => {
    const { run } = await setup({ resolveProgram: () => null });
    const events = await run("hi there");
    expect(text(events)).toContain("FakeAgent is not installed on this computer");
    expect(text(events)).toContain("brew install fake-agent");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "done" });
  });

  it("hands MCP servers to the engine and disposes them after the run", async () => {
    let disposed = false;
    const { run } = await setup({
      mcpServers: () => ({
        servers: [{ name: "bench_bot", command: "x", args: [], env: [] }],
        dispose: () => (disposed = true),
      }),
    });
    await run("hello");
    expect(disposed).toBe(true);
  });
});
