import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  AcpHarnessFactory,
  findProgram,
  GenericLoopFactory,
  HarnessRegistry,
  type McpStdioServer,
} from "@bench_bot/harnesses";
import { Kernel } from "@bench_bot/kernel";
import {
  EchoLlm,
  fsTools,
  LocalFs,
  OpenAiCompatibleLlm,
  openDatabase,
  RunStore,
  SafetyPolicy,
  SqliteSession,
  sandboxed,
  ToolRegistry,
  YamlBotDirectory,
} from "@bench_bot/providers";
import {
  type BotDirectory,
  type BotRunContext,
  type HarnessFactory,
  type LlmService,
  Services,
} from "@bench_bot/services";
import { StaticBotDirectory } from "./bots-static.ts";
import { type AppConfig, isOffline } from "./config.ts";
import { BotDelegation, delegationTools } from "./delegation.ts";
import { Hub, LiveSession } from "./hub.ts";
import { RunTokens } from "./run-tokens.ts";
import { BotRunner } from "./runner.ts";

export interface AppServices {
  config: AppConfig;
  runTokens: RunTokens;
  /** Called once the server listens; engine tool bridges need the address. */
  setApiUrl(url: string): void;
  policy: SafetyPolicy;
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
      tools: ["fs_read", "fs_write", "fs_list", "list_bots", "ask_bot"],
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
  // Bots may not write bench_bot's own data (other workspaces, the database) or program.
  const policy = new SafetyPolicy({
    home: homedir(),
    protectedPaths: [config.dataDir, config.repoRoot],
  });
  const tools = new ToolRegistry();
  for (const t of fsTools(fs, policy)) tools.register(t);
  const runTokens = new RunTokens();
  let apiUrl: string | null = null;
  const harnesses = new HarnessRegistry([
    new GenericLoopFactory({ llm, tools }),
    ...acpHarnesses(config, policy, runTokens, () => apiUrl),
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
  const delegation = new BotDelegation({ bots, session, queue: runner });
  for (const t of delegationTools(delegation)) tools.register(t);

  const kernel = new Kernel();
  kernel.register(Services.session, session);
  kernel.register(Services.llm, llm);
  kernel.register(Services.fs, fs);
  kernel.register(Services.policy, policy);
  kernel.register(Services.tools, tools);
  kernel.register(Services.harnesses, harnesses);
  kernel.register(Services.bots, bots);
  kernel.register(Services.queue, runner);
  kernel.register(Services.delegation, delegation);

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
    runTokens,
    setApiUrl(url) {
      apiUrl = url;
    },
    policy,
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

/** OpenCode config layer: send every command and file edit to bench_bot's safety policy first. */
export const OPENCODE_PERMISSIONS = { permission: { bash: "ask", edit: "ask" } };

/** Tools that engines like OpenCode reach through the bench_bot bridge. */
const BRIDGED_TOOLS = ["list_bots", "ask_bot"];
const BRIDGE_SCRIPT = join(import.meta.dirname, "..", "bin", "mcp-bridge.mjs");
let warnedUnconfined = false;

/** OpenCode and Prime Agent: both speak ACP; on macOS they run inside the sandbox. */
function acpHarnesses(
  config: AppConfig,
  policy: SafetyPolicy,
  runTokens: RunTokens,
  apiUrl: () => string | null,
): HarnessFactory[] {
  const env: Record<string, string> = config.apiKey ? { OPENCODE_API_KEY: config.apiKey } : {};
  const wrap = (command: string, args: string[], ctx: BotRunContext) => {
    const result = sandboxed(command, args, policy.sandboxPaths(ctx.workspacePath));
    if (!result.confined && !warnedUnconfined) {
      warnedUnconfined = true;
      console.warn(
        "bench_bot: no sandbox on this system; OpenCode/Prime Agent run without folder limits",
      );
    }
    return result;
  };
  const mcpServers = (ctx: BotRunContext) => {
    const allowed = ctx.toolPolicy.allowedTools.filter((t) => BRIDGED_TOOLS.includes(t));
    const url = apiUrl();
    if (allowed.length === 0 || !url) return { servers: [] as McpStdioServer[], dispose: () => {} };
    const { token, revoke } = runTokens.issue(
      {
        botId: ctx.botId,
        threadId: ctx.threadId,
        runId: ctx.runId,
        workspacePath: ctx.workspacePath,
        chain: ctx.chain,
      },
      allowed,
    );
    const server: McpStdioServer = {
      name: "bench_bot",
      command: process.execPath,
      args: [BRIDGE_SCRIPT],
      env: [
        { name: "BENCH_API_URL", value: url },
        { name: "BENCH_TOOL_TOKEN", value: token },
        // Inside the desktop app, process.execPath is Electron; this makes it act as plain Node.
        ...(process.versions.electron ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }] : []),
      ],
    };
    return { servers: [server], dispose: revoke };
  };
  return [
    new AcpHarnessFactory({
      id: "opencode",
      displayName: "OpenCode",
      program: "opencode",
      args: ["acp"],
      ...(process.env.OPENCODE_PATH ? { programPath: process.env.OPENCODE_PATH } : {}),
      // OpenCode runs commands and edits files without asking by default, which would bypass the
      // safety policy. "ask" makes it send each one to bench_bot, where the policy answers
      // automatically (allowed → runs, blocked → refused + note). No pop-ups for the user.
      env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_PERMISSIONS) },
      installHint:
        "Install it with `curl -fsSL https://opencode.ai/install | bash` (or `npm i -g opencode-ai`), then send the message again. See docs/engines.md.",
      policy,
      wrap,
      mcpServers,
    }),
    new AcpHarnessFactory({
      id: "prime-agent",
      displayName: "Prime Agent",
      // Prime Agent 0.9.8 keeps one worker per ACP session alive even after session/close (found
      // in testing). Stop the idle sessions it holds in this bot's private folder; the user's own
      // Prime Agent sessions elsewhere are not touched.
      afterRun: (ctx) => stopIdlePrimeAgentSessions(ctx.workspacePath),
      program: "prime-agent",
      args: ["--mode", "acp"],
      ...(process.env.PRIME_AGENT_PATH ? { programPath: process.env.PRIME_AGENT_PATH } : {}),
      env,
      installHint:
        "Install it with `curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh`, then send the message again. See docs/engines.md.",
      policy,
      wrap,
      mcpServers,
    }),
  ];
}

const run = promisify(execFile);

/** `prime-agent stop` for every idle, unattached Prime Agent session whose folder is `workspace`. */
export async function stopIdlePrimeAgentSessions(workspace: string): Promise<void> {
  const program = findProgram("prime-agent", process.env.PRIME_AGENT_PATH);
  if (!program) return;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const folder = real(workspace);
  const { stdout } = await run(program, ["list", "--json"], { timeout: 20_000 });
  const sessions = (JSON.parse(stdout) as { sessions?: PrimeSession[] }).sessions ?? [];
  for (const s of sessions) {
    if (real(s.cwd) === folder && s.attachedClients === 0 && s.activity === "idle") {
      await run(program, ["stop", s.id], { timeout: 20_000 }).catch(() => {});
    }
  }
}

interface PrimeSession {
  id: string;
  cwd: string;
  attachedClients: number;
  activity: string;
}
