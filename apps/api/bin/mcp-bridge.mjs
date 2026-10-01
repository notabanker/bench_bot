#!/usr/bin/env node
// bench_bot tool bridge: a minimal MCP server (stdio) that an engine such as OpenCode starts.
// It offers the bot's bench_bot tools (list_bots, ask_bot) and forwards each call to the local
// bench_bot server, authenticated with a one-time token for the current run.
import { createInterface } from "node:readline";

const API = process.env.BENCH_API_URL;
const TOKEN = process.env.BENCH_TOOL_TOKEN;
if (!API || !TOKEN) {
  process.stderr.write("bench_bot bridge: BENCH_API_URL and BENCH_TOOL_TOKEN are required\n");
  process.exit(2);
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-bench-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`bench_bot answered ${res.status}: ${await res.text()}`);
  return res.json();
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "bench_bot", version: "0.1.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list": {
      const tools = await api("/api/internal/tools");
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
      });
    }
    case "tools/call": {
      const result = await api(
        `/api/internal/tools/${encodeURIComponent(params.name)}`,
        params.arguments ?? {},
      );
      return reply(id, { content: [{ type: "text", text: result.output }], isError: !result.ok });
    }
    default:
      if (id !== undefined) return fail(id, -32601, `Method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((error) => {
    if (msg.id !== undefined) fail(msg.id, -32603, String(error?.message ?? error));
  });
});
