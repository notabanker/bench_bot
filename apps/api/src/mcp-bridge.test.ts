import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ScriptedLlm } from "@bench_bot/providers";
import type { BotDefinition } from "@bench_bot/services";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { StaticBotDirectory } from "./bots-static.ts";
import { compose } from "./compose.ts";

const BRIDGE = join(import.meta.dirname, "..", "bin", "mcp-bridge.mjs");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const bot = (id: string): BotDefinition => ({
  id,
  name: id,
  description: `${id} bot`,
  instructions: "x",
  model: "m",
  harness: "generic-loop",
  tools: [],
  workspacePath: `/tmp/${id}`,
});

async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), "bench-bridge-"));
  const config = {
    repoRoot: dataDir,
    dataDir,
    botsDir: dataDir,
    llmBaseUrl: "x",
    apiKey: undefined,
    defaultModel: "m",
    host: "127.0.0.1",
    port: 0,
    phone: { enabled: false, password: "unused-pass", generated: false },
  };
  const services = await compose(config, {
    llm: new ScriptedLlm([]),
    bots: new StaticBotDirectory([bot("orch"), bot("fin")]),
  });
  const server = serve({
    fetch: createApp(services).fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () => rmSync(dataDir, { recursive: true, force: true }),
    () => services.close(),
    () => new Promise((r) => server.close(r)),
  );
  return { services, url };
}

function bridge(url: string, token: string) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, BENCH_API_URL: url, BENCH_TOOL_TOKEN: token },
  });
  cleanups.push(() => child.kill());
  const waiting = new Map<number, (msg: unknown) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as { id: number };
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  return (method: string, params: unknown = {}) =>
    new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve as (m: unknown) => void);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
}

describe("MCP bridge", () => {
  it("offers the bot's bench_bot tools and runs them as that bot", async () => {
    const { services, url } = await startServer();
    const { token } = services.runTokens.issue(
      { botId: "orch", threadId: "t", runId: "r", workspacePath: "/tmp/orch", chain: ["orch"] },
      ["list_bots"],
    );
    const call = bridge(url, token);

    expect((await call("initialize", { protocolVersion: "2025-06-18" })).result).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: "bench_bot" },
    });
    const list = await call("tools/list");
    expect(((list.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "list_bots",
    ]);
    const result = await call("tools/call", { name: "list_bots", arguments: {} });
    expect(result.result).toEqual({
      content: [{ type: "text", text: "fin — fin: fin bot" }],
      isError: false,
    });
    const denied = await call("tools/call", {
      name: "ask_bot",
      arguments: { bot_id: "fin", message: "?" },
    });
    expect(denied.result).toEqual({
      content: [{ type: "text", text: 'Tool "ask_bot" is not available to this bot' }],
      isError: true,
    });
  });

  it("refuses an unknown or revoked token", async () => {
    const { services, url } = await startServer();
    const { token, revoke } = services.runTokens.issue(
      { botId: "orch", threadId: "t", runId: "r", workspacePath: "/tmp", chain: ["orch"] },
      ["list_bots"],
    );
    revoke();
    const call = bridge(url, token);
    expect((await call("tools/list")).error?.message).toMatch(/401/);
    expect((await bridge(url, "made-up")("tools/list")).error?.message).toMatch(/401/);
  });
});
