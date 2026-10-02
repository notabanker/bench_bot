import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  BotEvent,
  BotRunContext,
  FinishReason,
  Harness,
  HarnessCapabilities,
  HarnessFactory,
  PolicyAction,
  PolicyService,
  StoredEntry,
} from "@bench_bot/services";
import { JsonRpcConnection } from "./json-rpc.ts";

/** An MCP server the engine should start for this run (ACP `McpServerStdio`). */
export interface McpStdioServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface WrappedCommand {
  command: string;
  args: string[];
}

export interface AcpHarnessOptions {
  /** Harness id used in bot files, e.g. "opencode". */
  id: string;
  /** Shown in messages, e.g. "OpenCode". */
  displayName: string;
  /** Program name to look up on PATH, e.g. "opencode". */
  program: string;
  /** Arguments that start the program in ACP mode, e.g. ["acp"]. */
  args: string[];
  /** Absolute path that wins over PATH lookup (e.g. from OPENCODE_PATH). */
  programPath?: string;
  /** Extra environment for the program (e.g. OPENCODE_API_KEY). */
  env?: Record<string, string>;
  /** One line telling the user how to install the program. */
  installHint: string;
  policy?: PolicyService;
  /** Wraps the program start, e.g. in the macOS sandbox. */
  wrap?: (command: string, args: string[], ctx: BotRunContext) => WrappedCommand;
  /** MCP servers to hand the engine for this run (our list_bots/ask_bot bridge), plus cleanup. */
  mcpServers?: (ctx: BotRunContext) => { servers: McpStdioServer[]; dispose: () => void };
  /** Runs after the engine has exited (e.g. to stop sessions an engine keeps alive by itself). */
  afterRun?: (ctx: BotRunContext) => Promise<void>;
  /** Older chat entries included as context in a fresh session. */
  historyLimit?: number;
  /** For tests: skip the PATH lookup. */
  resolveProgram?: () => string | null;
}

const INIT_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 10_000;
const MAX_TOOL_OUTPUT = 4_000;

/** Where programs installed by Homebrew, npm or curl scripts usually end up on a Mac. */
const EXTRA_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".local", "bin"),
  join(homedir(), ".opencode", "bin"),
  join(homedir(), ".npm-global", "bin"),
  join(homedir(), ".bun", "bin"),
];

/** Finds an executable on PATH (plus common install folders; apps started from Finder get no PATH). */
export function findProgram(name: string, override?: string): string | null {
  const candidates = override
    ? [override]
    : [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_DIRS].map((d) => join(d, name));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}

/** A harness for any program that speaks the Agent Client Protocol over stdio. */
export class AcpHarnessFactory implements HarnessFactory {
  readonly id: string;
  readonly #options: AcpHarnessOptions;

  constructor(options: AcpHarnessOptions) {
    this.id = options.id;
    this.#options = options;
  }

  capabilities(): HarnessCapabilities {
    // Each run starts a fresh engine session and replays recent chat history as context.
    return { resume: true, steer: false, tools: true, reasoning: true };
  }

  /** The program path, or null when it is not installed (runs then use a stand-in reply). */
  programPath(): string | null {
    return this.#options.resolveProgram
      ? this.#options.resolveProgram()
      : findProgram(this.#options.program, this.#options.programPath);
  }

  create(): Harness {
    return new AcpHarness(this.#options, this.programPath());
  }
}

/** Async queue: producers push events, the run's `send` iterates them. */
class EventQueue {
  readonly #items: BotEvent[] = [];
  #wake: (() => void) | null = null;
  #done = false;

  push(event: BotEvent): void {
    if (this.#done) return;
    this.#items.push(event);
    if (event.type === "finish") this.#done = true;
    this.#wake?.();
  }

  get done(): boolean {
    return this.#done;
  }

  async *drain(): AsyncIterable<BotEvent> {
    for (;;) {
      const next = this.#items.shift();
      if (next) {
        yield next;
        if (next.type === "finish") return;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}

class AcpHarness implements Harness {
  readonly id: string;
  readonly #o: AcpHarnessOptions;
  readonly #program: string | null;
  readonly #events = new EventQueue();
  #ctx: BotRunContext | undefined;
  #history: StoredEntry[] = [];
  #rpc: JsonRpcConnection | null = null;
  #sessionId: string | null = null;
  #aborted = false;
  #dispose: () => void = () => {};
  readonly #tools = new Map<string, string>();

  constructor(options: AcpHarnessOptions, program: string | null) {
    this.id = options.id;
    this.#o = options;
    this.#program = program;
  }

  async start(ctx: BotRunContext): Promise<void> {
    this.#ctx = ctx;
    this.#history = (await ctx.sessionLog.read()).filter((e) => e.seq < ctx.untilSeq);
  }

  async abort(): Promise<void> {
    if (this.#aborted) return;
    this.#aborted = true;
    // Cancel the turn; the program itself is ended by #cleanup once the stream closes.
    if (this.#rpc && this.#sessionId)
      this.#rpc.notify("session/cancel", { sessionId: this.#sessionId });
    else this.#rpc?.kill();
    this.#events.push({ type: "finish", reason: "aborted" });
  }

  async *send(text: string): AsyncIterable<BotEvent> {
    const ctx = this.#ctx;
    if (!ctx) {
      yield { type: "error", message: "The run was not started" };
      yield { type: "finish", reason: "error" };
      return;
    }
    if (!this.#program) {
      yield* this.#standIn(text);
      return;
    }
    void this.#run(ctx, this.#program, text).catch((error: unknown) => {
      this.#events.push({ type: "error", message: this.#describe(error) });
      this.#events.push({ type: "finish", reason: this.#aborted ? "aborted" : "error" });
    });
    try {
      yield* this.#events.drain();
    } finally {
      // In the background: the run is already finished for the user and the queue moves on.
      void this.#cleanup();
    }
  }

  async *#standIn(text: string): AsyncIterable<BotEvent> {
    console.log(`[${this.id} stand-in] ${this.#ctx?.botId}: ${text.slice(0, 200)}`);
    yield {
      type: "text-delta",
      text:
        `**${this.#o.displayName} is not installed on this computer**, so this is a stand-in reply.\n\n` +
        `${this.#o.installHint}\n\nYour message was: "${text.length > 300 ? `${text.slice(0, 300)}…` : text}"`,
    };
    yield { type: "finish", reason: "done" };
  }

  async #run(ctx: BotRunContext, program: string, text: string): Promise<void> {
    mkdirSync(ctx.workspacePath, { recursive: true });
    const launch = this.#o.wrap
      ? this.#o.wrap(program, this.#o.args, ctx)
      : { command: program, args: this.#o.args };
    const child = spawn(launch.command, launch.args, {
      cwd: ctx.workspacePath,
      env: { ...process.env, ...this.#o.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpc = new JsonRpcConnection(child);
    this.#rpc = rpc;
    rpc.onRequest = (method, params) => this.#handleRequest(method, params);
    rpc.onNotification = (method, params) => {
      if (method === "session/update")
        this.#onUpdate((params as { update: Record<string, unknown> }).update);
    };
    void rpc.exited.then(() => {
      if (!this.#events.done) {
        const detail = rpc.stderrTail.trim().split("\n").at(-1);
        this.#events.push({
          type: "error",
          message: `${this.#o.displayName} stopped unexpectedly${detail ? `: ${detail}` : ""}`,
        });
        this.#events.push({ type: "finish", reason: this.#aborted ? "aborted" : "error" });
      }
    });

    await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "bench_bot", version: "0.1.0" },
      },
      INIT_TIMEOUT_MS,
    );
    const mcp = this.#o.mcpServers?.(ctx) ?? { servers: [], dispose: () => {} };
    this.#dispose = mcp.dispose;
    const session = await rpc.request<{ sessionId: string; configOptions?: ConfigOption[] }>(
      "session/new",
      { cwd: ctx.workspacePath, mcpServers: mcp.servers },
      INIT_TIMEOUT_MS,
    );
    this.#sessionId = session.sessionId;
    if (this.#aborted) return;
    await this.#selectModel(rpc, session.sessionId, ctx.model, session.configOptions ?? []);

    const response = await rpc.request<{ stopReason: string; usage?: AcpUsage | null }>(
      "session/prompt",
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: this.#promptText(ctx, text) }],
      },
    );
    if (response.usage) {
      this.#events.push({
        type: "usage",
        usage: {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
          ...(response.usage.cachedReadTokens
            ? { cachedInput: response.usage.cachedReadTokens }
            : {}),
        },
      });
    }
    for (const event of finishFor(response.stopReason, this.#aborted)) this.#events.push(event);
  }

  /** Picks the bot's model from the engine's model menu (exact id, or the same id after a "provider/"). */
  async #selectModel(
    rpc: JsonRpcConnection,
    sessionId: string,
    model: string,
    options: ConfigOption[],
  ): Promise<void> {
    const menu = options.find((o) => o.id === "model" || o.category === "model");
    if (!menu || !model) return;
    const match = matchModel(flattenOptions(menu.options), model);
    if (!match) {
      this.#events.push({
        type: "error",
        message: `Model "${model}" is not available in ${this.#o.displayName}; using "${menu.currentValue}". Sign in or set OPENCODE_API_KEY to unlock it.`,
      });
      return;
    }
    if (match !== menu.currentValue) {
      await rpc.request(
        "session/set_config_option",
        { sessionId, configId: menu.id, value: match },
        INIT_TIMEOUT_MS,
      );
    }
  }

  #promptText(ctx: BotRunContext, text: string): string {
    const limit = this.#o.historyLimit ?? 20;
    const lines: string[] = [];
    const runText = new Map<string, string>();
    const order: Array<{ who: string; key?: string; text?: string }> = [];
    for (const e of this.#history) {
      if (e.kind === "message") {
        order.push({ who: e.from.kind === "user" ? "User" : `Bot ${e.from.botId}`, text: e.text });
      } else if (e.event.type === "text-delta") {
        if (!runText.has(e.runId)) order.push({ who: "You", key: e.runId });
        runText.set(e.runId, (runText.get(e.runId) ?? "") + e.event.text);
      }
    }
    for (const item of order.slice(-limit)) {
      const body = item.key ? runText.get(item.key) : item.text;
      if (body?.trim()) lines.push(`${item.who}: ${body.trim()}`);
    }
    const parts = [`[Your role]\n${ctx.instructions.trim()}`];
    if (lines.length) parts.push(`[Earlier in this conversation]\n${lines.join("\n\n")}`);
    parts.push(`[New message]\n${text}`);
    return parts.join("\n\n");
  }

  #onUpdate(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text)
          this.#events.push({ type: "text-delta", text: content.text });
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text)
          this.#events.push({ type: "reasoning-delta", text: content.text });
        break;
      }
      case "tool_call": {
        const callId = String(update.toolCallId);
        // Engines name tools differently: a name, a human title, or only a kind ("other").
        const tool = String(update.name || update.title || update.kind || "tool");
        this.#tools.set(callId, tool);
        this.#events.push({
          type: "tool-call",
          callId,
          tool,
          args: update.rawInput ?? { title: update.title },
        });
        this.#maybeResult(callId, update);
        break;
      }
      case "tool_call_update":
        this.#maybeResult(String(update.toolCallId), update);
        break;
      default:
        break;
    }
  }

  #maybeResult(callId: string, update: Record<string, unknown>): void {
    if (update.status !== "completed" && update.status !== "failed") return;
    if (!this.#tools.has(callId)) return;
    this.#tools.delete(callId);
    this.#events.push({
      type: "tool-result",
      callId,
      ok: update.status === "completed",
      output: toolOutput(update),
    });
  }

  async #handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission")
      return this.#permission(params as PermissionRequest);
    throw new Error(`bench_bot does not support ${method}`);
  }

  /** Answers the engine's "may I?" with the safety policy: allowed runs, blocked is refused and noted. */
  #permission(request: PermissionRequest): unknown {
    if (this.#aborted) return { outcome: { outcome: "cancelled" } };
    const pick = (kinds: string[]) => request.options.find((o) => kinds.includes(o.kind))?.optionId;
    const ctx = this.#ctx;
    const decision =
      ctx && this.#o.policy ? checkToolCall(this.#o.policy, request.toolCall, ctx) : null;
    if (decision && !decision.allowed) {
      this.#events.push({ type: "blocked", action: decision.action, reason: decision.reason });
      const reject = pick(["reject_once", "reject_always"]);
      return reject
        ? { outcome: { outcome: "selected", optionId: reject } }
        : { outcome: { outcome: "cancelled" } };
    }
    const allow = pick(["allow_once", "allow_always"]);
    return allow
      ? { outcome: { outcome: "selected", optionId: allow } }
      : { outcome: { outcome: "cancelled" } };
  }

  #describe(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const detail = this.#rpc?.stderrTail.trim().split("\n").at(-1);
    return `${this.#o.displayName}: ${message}${detail && !message.includes(detail) ? ` (${detail})` : ""}`;
  }

  /**
   * Ends the run's engine session. Some engines (Prime Agent) keep background workers per
   * session, so ask them to close it before stopping the program.
   */
  async #cleanup(): Promise<void> {
    this.#dispose();
    this.#dispose = () => {};
    const rpc = this.#rpc;
    if (!rpc) return;
    if (!rpc.closed && this.#sessionId) {
      await rpc
        .request("session/close", { sessionId: this.#sessionId }, CLOSE_TIMEOUT_MS)
        .catch(() => {});
    }
    await rpc.shutdown();
    if (this.#ctx && this.#o.afterRun) {
      await this.#o
        .afterRun(this.#ctx)
        .catch((error: unknown) =>
          console.warn(`bench_bot: ${this.#o.displayName} clean-up failed:`, error),
        );
    }
  }
}

interface ConfigOption {
  id: string;
  category?: string | null;
  currentValue?: string;
  options?: unknown;
}

interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number | null;
}

interface PermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    kind?: string | null;
    title?: string | null;
    rawInput?: unknown;
    locations?: Array<{ path: string }> | null;
  };
  options: Array<{ optionId: string; kind: string; name: string }>;
}

function flattenOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((o: { value?: string; options?: unknown }) =>
    typeof o.value === "string" ? [o.value] : flattenOptions(o.options),
  );
}

/**
 * The engine's menu value for a bot's model id. Engines write ids differently: OpenCode
 * "opencode-go/kimi-k3", Prime Agent '["opencode-go","kimi-k3"]'. Matches the full id first, then
 * the same id after any provider prefix.
 */
export function matchModel(values: string[], model: string): string | undefined {
  const plain = (value: string) => {
    if (value.startsWith("[")) {
      try {
        const parts = JSON.parse(value) as unknown;
        if (Array.isArray(parts) && parts.every((p) => typeof p === "string"))
          return parts.join("/");
      } catch {}
    }
    return value;
  };
  const entries = values.map((value) => ({ value, id: plain(value) }));
  const wanted = plain(model);
  return (
    entries.find((e) => e.id === wanted)?.value ??
    entries.find((e) => e.id.endsWith(`/${wanted}`))?.value ??
    entries.find((e) => wanted.endsWith(`/${e.id}`))?.value
  );
}

function finishFor(stopReason: string, aborted: boolean): BotEvent[] {
  if (aborted || stopReason === "cancelled") return [{ type: "finish", reason: "aborted" }];
  const map: Record<string, FinishReason> = { end_turn: "done", max_turn_requests: "max-steps" };
  if (stopReason === "refusal")
    return [
      { type: "error", message: "The model refused to answer." },
      { type: "finish", reason: "error" },
    ];
  if (stopReason === "max_tokens") {
    return [
      { type: "error", message: "The answer was cut off (model length limit)." },
      { type: "finish", reason: "done" },
    ];
  }
  return [{ type: "finish", reason: map[stopReason] ?? "done" }];
}

function toolOutput(update: Record<string, unknown>): string {
  const content = Array.isArray(update.content) ? update.content : [];
  const texts = content.flatMap(
    (c: { type?: string; content?: { type?: string; text?: string }; path?: string }) => {
      if (c.type === "content" && c.content?.type === "text" && c.content.text)
        return [c.content.text];
      if (c.type === "diff" && c.path) return [`(edited ${c.path})`];
      return [];
    },
  );
  let out = texts.join("\n");
  if (!out && update.rawOutput !== undefined) {
    out =
      typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
  }
  return out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}…` : out;
}

/** Maps an ACP tool call to policy checks. Commands and writes are checked; everything else is allowed. */
export function checkToolCall(
  policy: PolicyService,
  toolCall: PermissionRequest["toolCall"],
  ctx: Pick<BotRunContext, "botId" | "workspacePath">,
): { allowed: true } | { allowed: false; action: string; reason: string } {
  const input = (toolCall.rawInput ?? {}) as Record<string, unknown>;
  const actions: PolicyAction[] = [];
  const command = commandOf(input);
  if (toolCall.kind === "execute" || command) {
    if (command)
      actions.push({
        kind: "command",
        command,
        cwd: String(input.cwd ?? input.workdir ?? ctx.workspacePath),
      });
  }
  if (toolCall.kind === "edit" || toolCall.kind === "delete" || toolCall.kind === "move") {
    const paths = new Set<string>();
    for (const l of toolCall.locations ?? []) paths.add(l.path);
    for (const key of ["path", "filePath", "file_path", "destination", "target"]) {
      if (typeof input[key] === "string") paths.add(input[key] as string);
    }
    for (const p of paths)
      actions.push({ kind: "write", path: p.startsWith("/") ? p : join(ctx.workspacePath, p) });
  }
  for (const action of actions) {
    const decision = policy.check(action, ctx);
    if (!decision.allow) {
      return {
        allowed: false,
        action: action.kind === "command" ? action.command : `write ${action.path}`,
        reason: decision.reason,
      };
    }
  }
  return { allowed: true };
}

function commandOf(input: Record<string, unknown>): string | null {
  const c = input.command ?? input.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) return c.join(" ");
  return null;
}
