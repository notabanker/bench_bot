import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GenericLoopFactory, HarnessRegistry } from "@bench_bot/harnesses";
import { Kernel } from "@bench_bot/kernel";
import {
  EchoLlm,
  fsTools,
  LocalFs,
  OpenAiCompatibleLlm,
  openDatabase,
  RunStore,
  SqliteSession,
  ToolRegistry,
  YamlBotDirectory,
} from "@bench_bot/providers";
import {
  type BotDirectory,
  type HarnessFactory,
  type LlmService,
  Services,
} from "@bench_bot/services";
import { StaticBotDirectory } from "./bots-static.ts";
import { type AppConfig, isOffline } from "./config.ts";
import { Hub, LiveSession } from "./hub.ts";
import { BotRunner } from "./runner.ts";

export interface AppServices {
  config: AppConfig;
  /** Problems in bot files (when bots come from YAML). */
  botProblems(): { file: string; message: string }[];
  kernel: Kernel;
  runner: BotRunner;
  runs: RunStore;
  hub: Hub;
  db: DatabaseSync;
  /** True when no model endpoint is configured; the generic loop then echoes. */
  offline: boolean;
  close(): Promise<void>;
}

export interface ComposeOverrides {
  dbPath?: string;
  llm?: LlmService;
  bots?: BotDirectory;
  harnesses?: HarnessFactory[];
}

/** The default roster until bot files exist (Phase 8). */
export function fallbackBots(config: AppConfig): BotDirectory {
  return new StaticBotDirectory([
    {
      id: "assistant",
      name: "Assistant",
      description: "General helper on our own loop.",
      instructions: "You are a helpful assistant. Keep answers short and concrete.",
      model: config.defaultModel,
      harness: "generic-loop",
      tools: ["fs_read", "fs_write", "fs_list"],
      workspacePath: join(config.dataDir, "workspaces", "assistant"),
    },
  ]);
}

/** Builds every service, registers it in a kernel, and recovers runs cut off by a crash. */
export async function compose(
  config: AppConfig,
  overrides: ComposeOverrides = {},
): Promise<AppServices> {
  const db = openDatabase(overrides.dbPath ?? join(config.dataDir, "bench.db"));
  const hub = new Hub();
  const session = new LiveSession(new SqliteSession(db), hub);
  const runs = new RunStore(db);
  const offline = !overrides.llm && isOffline(config);
  const llm =
    overrides.llm ??
    (offline
      ? new EchoLlm()
      : new OpenAiCompatibleLlm({
          baseUrl: config.llmBaseUrl,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        }));
  const fs = new LocalFs();
  const tools = new ToolRegistry();
  for (const t of fsTools(fs)) tools.register(t);
  const harnesses = new HarnessRegistry([
    new GenericLoopFactory({ llm, tools }),
    ...(overrides.harnesses ?? []),
  ]);
  const yamlBots = new YamlBotDirectory({
    botsDir: config.botsDir,
    workspacesRoot: join(config.dataDir, "workspaces"),
    defaultModel: config.defaultModel,
  });
  // Bot files are the source of truth; the built-in Assistant only fills an empty folder.
  const bots: BotDirectory =
    overrides.bots ?? ((await yamlBots.list()).length > 0 ? yamlBots : fallbackBots(config));
  const runner = new BotRunner({ bots, harnesses, session, runs, hub });

  const kernel = new Kernel();
  kernel.register(Services.session, session);
  kernel.register(Services.llm, llm);
  kernel.register(Services.fs, fs);
  kernel.register(Services.tools, tools);
  kernel.register(Services.harnesses, harnesses);
  kernel.register(Services.bots, bots);
  kernel.register(Services.queue, runner);

  // Runs that were in progress when the app stopped can never finish: close them in the log too.
  for (const run of runs.markInterrupted()) {
    await session.append(run.threadId, {
      kind: "event",
      runId: run.id,
      event: {
        type: "error",
        message: "Interrupted: bench_bot stopped while this run was in progress.",
      },
    });
    await session.append(run.threadId, {
      kind: "event",
      runId: run.id,
      event: { type: "finish", reason: "aborted" },
    });
  }

  return {
    config,
    botProblems: () => (bots === yamlBots ? yamlBots.problems() : []),
    kernel,
    runner,
    runs,
    hub,
    db,
    offline,
    async close() {
      await runner.abortAll();
      await runner.idle();
      db.close();
    },
  };
}
