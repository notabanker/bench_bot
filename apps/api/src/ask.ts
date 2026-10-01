/**
 * Sends one message to our own loop and prints the answer as it streams.
 *
 *   pnpm ask "What is 2 + 2?"
 *   pnpm ask --model deepseek-v4-flash "Hello"
 *
 * Reads OPENCODE_API_KEY and LLM_BASE_URL from `.env`. Without a key it answers offline (echo).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericLoopFactory } from "@bench_bot/harnesses";
import {
  EchoLlm,
  fsTools,
  LocalFs,
  OpenAiCompatibleLlm,
  openDatabase,
  SqliteSession,
  ToolRegistry,
} from "@bench_bot/providers";
import { isOffline, loadConfig } from "./config.ts";

const args = process.argv.slice(2);
let model: string | undefined;
const modelFlag = args.indexOf("--model");
if (modelFlag !== -1) {
  model = args[modelFlag + 1];
  args.splice(modelFlag, 2);
}
const question = args.join(" ").trim();
if (!question) {
  console.error('Usage: pnpm ask [--model <id>] "your question"');
  process.exit(2);
}

const config = loadConfig();
const offline = isOffline(config);
const llm = offline
  ? new EchoLlm()
  : new OpenAiCompatibleLlm({
      baseUrl: config.llmBaseUrl,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });

const tools = new ToolRegistry();
for (const t of fsTools(new LocalFs())) tools.register(t);
const session = new SqliteSession(openDatabase(":memory:"));
const thread = await session.createThread("ask");
const workspacePath = mkdtempSync(join(tmpdir(), "bench-ask-"));

const harness = new GenericLoopFactory({ llm, tools }).create();
const ctx = {
  botId: "ask",
  threadId: thread.id,
  runId: "run_ask",
  workspacePath,
  model: model ?? config.defaultModel,
  instructions: "You are a helpful assistant. Keep answers short.",
  toolPolicy: { allowedTools: ["fs_read", "fs_write", "fs_list"] },
  sessionLog: session.log(thread.id),
  untilSeq: 1,
  chain: ["ask"],
};

console.error(
  offline
    ? "(no OPENCODE_API_KEY in .env: offline echo mode)\n"
    : `(model ${ctx.model} via ${config.llmBaseUrl}; workspace ${workspacePath})\n`,
);

await harness.start(ctx);
let failed = false;
for await (const event of harness.send(question)) {
  switch (event.type) {
    case "text-delta":
      process.stdout.write(event.text);
      break;
    case "tool-call":
      console.error(`\n[tool] ${event.tool} ${JSON.stringify(event.args)}`);
      break;
    case "tool-result":
      console.error(`[tool result] ${event.ok ? "ok" : "failed"}: ${event.output.slice(0, 200)}`);
      break;
    case "blocked":
      console.error(`[blocked] ${event.action}: ${event.reason}`);
      break;
    case "error":
      failed = true;
      console.error(`\n[error] ${event.message}`);
      break;
    case "usage":
      console.error(`\n(tokens: ${event.usage.input} in, ${event.usage.output} out)`);
      break;
    case "finish":
      if (event.reason !== "done") {
        failed = true;
        console.error(`[finished: ${event.reason}]`);
      }
      break;
  }
}
process.stdout.write("\n");
process.exit(failed ? 1 : 0);
