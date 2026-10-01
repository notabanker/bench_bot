import type { BotEvent } from "./events.ts";
import type { ThreadLog } from "./session.ts";

/** What an engine can do, so the app never offers a control the engine cannot honour. */
export interface HarnessCapabilities {
  /** Can continue an earlier conversation after a restart. */
  resume: boolean;
  /** Accepts extra input while a run is in progress. */
  steer: boolean;
  /** Can call tools. */
  tools: boolean;
  /** Reports the model's reasoning as `reasoning-delta` events. */
  reasoning: boolean;
}

export interface ToolPolicy {
  /** Tool names the bot may use in this run. */
  allowedTools: string[];
}

export interface BotRunContext {
  botId: string;
  threadId: string;
  runId: string;
  workspacePath: string;
  model: string;
  instructions: string;
  toolPolicy: ToolPolicy;
  sessionLog: ThreadLog;
}

/**
 * One bot run. A harness instance serves exactly one run: `start` once, then `send`, `abort`
 * any time.
 */
export interface Harness {
  readonly id: string;
  /**
   * Resolves model, tools and the engine before anything model-visible is written to the log.
   * Rejects if the run cannot start (e.g. the engine program is missing and there is no stub).
   */
  start(ctx: BotRunContext): Promise<void>;
  /**
   * Sends one message and streams the run's events. Never throws: failures become an `error`
   * event. Always ends with exactly one `finish` event.
   */
  send(text: string): AsyncIterable<BotEvent>;
  /** Stops the run. Safe to call twice or after the run ended; the stream ends with "aborted". */
  abort(): Promise<void>;
  /** Only when `capabilities.resume`: "cursor" = continued the engine's own session, "replay" = rebuilt from the log. */
  resume?(): Promise<"cursor" | "replay">;
}

/** One engine (our loop, OpenCode, Prime Agent). Creates a fresh harness per run. */
export interface HarnessFactory {
  readonly id: string;
  capabilities(): HarnessCapabilities;
  create(): Harness;
}

export interface HarnessCatalog {
  /** Throws if no engine with this id is registered. */
  get(harnessId: string): HarnessFactory;
  ids(): string[];
}
