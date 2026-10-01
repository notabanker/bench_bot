// A tiny ACP agent for tests. Behaviour depends on the prompt's [New message] text.
import { createInterface } from "node:readline";

let model = "opencode/big-pickle";
let nextId = 1000;
const waiting = new Map();
let cancelled = null;
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const update = (sessionId, u) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

async function prompt(id, { sessionId, prompt }) {
  const full = prompt.map((p) => p.text).join("");
  const text = full.split("[New message]\n").at(-1).trim();
  const done = (stopReason = "end_turn") =>
    send({
      jsonrpc: "2.0",
      id,
      result: { stopReason, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
    });

  if (text === "hello") {
    update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "greet" },
    });
    say(sessionId, "Hi ");
    say(sessionId, "there");
    return done();
  }
  if (text === "which model") {
    say(sessionId, model);
    return done();
  }
  if (text === "echo prompt") {
    say(sessionId, full);
    return done();
  }
  if (text.startsWith("run ")) {
    const command = text.slice(4);
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "bash",
      kind: "execute",
      status: "pending",
      rawInput: { command },
    });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "t1", kind: "execute", rawInput: { command } },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = answer.outcome?.optionId === "yes";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: allowed ? "completed" : "failed",
      content: [
        { type: "content", content: { type: "text", text: allowed ? "file.txt" : "denied" } },
      ],
    });
    say(sessionId, allowed ? "listed" : "not allowed");
    return done();
  }
  if (text === "slow") {
    say(sessionId, "starting");
    await new Promise((resolve) => {
      cancelled = resolve;
    });
    return done("cancelled");
  }
  if (text === "crash") {
    process.stderr.write("fatal: boom\n");
    process.exit(3);
  }
  say(sessionId, `unknown: ${text}`);
  return done();
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result);
    waiting.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
    case "session/new":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "s1",
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: model,
              options: [
                { value: "opencode/big-pickle", name: "Big Pickle" },
                { value: "opencode-go/kimi-k3", name: "Kimi K3" },
              ],
            },
          ],
          _mcp: msg.params.mcpServers,
        },
      });
    case "session/set_config_option":
      model = msg.params.value;
      return send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    case "session/prompt":
      return prompt(msg.id, msg.params);
    case "session/cancel":
      cancelled?.();
      return;
    default:
      if (msg.id !== undefined)
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
