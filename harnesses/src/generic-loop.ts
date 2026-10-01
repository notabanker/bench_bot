import type {
  BotEvent,
  BotRunContext,
  Harness,
  HarnessCapabilities,
  HarnessFactory,
  LlmMessage,
  LlmService,
  LlmToolCall,
  TokenUsage,
  ToolService,
} from "@bench_bot/services";
import { historyToMessages } from "./history.ts";

export const GENERIC_LOOP_ID = "generic-loop";
export const DEFAULT_MAX_STEPS = 12;

export interface GenericLoopOptions {
  llm: LlmService;
  tools: ToolService;
  /** Model rounds per message before the run stops with "max-steps". */
  maxSteps?: number;
}

/** Our own agent loop: model → tools → model … until the model answers without tool calls. */
export class GenericLoopFactory implements HarnessFactory {
  readonly id = GENERIC_LOOP_ID;
  readonly #options: GenericLoopOptions;

  constructor(options: GenericLoopOptions) {
    this.#options = options;
  }

  capabilities(): HarnessCapabilities {
    // Every run is rebuilt from the thread log, so continuing after a restart always works.
    return { resume: true, steer: false, tools: true, reasoning: true };
  }

  create(): Harness {
    return new GenericLoopHarness(this.#options);
  }
}

class GenericLoopHarness implements Harness {
  readonly id = GENERIC_LOOP_ID;
  readonly #llm: LlmService;
  readonly #tools: ToolService;
  readonly #maxSteps: number;
  readonly #abort = new AbortController();
  #ctx: BotRunContext | undefined;
  #history: LlmMessage[] = [];

  constructor(options: GenericLoopOptions) {
    this.#llm = options.llm;
    this.#tools = options.tools;
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  async start(ctx: BotRunContext): Promise<void> {
    const entries = await ctx.sessionLog.read();
    this.#history = historyToMessages(entries.filter((e) => e.seq < ctx.untilSeq));
    this.#ctx = ctx;
  }

  async resume(): Promise<"replay"> {
    return "replay";
  }

  async abort(): Promise<void> {
    this.#abort.abort();
  }

  async *send(text: string): AsyncIterable<BotEvent> {
    const ctx = this.#ctx;
    if (!ctx) {
      yield { type: "error", message: "The run was not started" };
      yield { type: "finish", reason: "error" };
      return;
    }
    const usage: TokenUsage = { input: 0, output: 0 };
    let sawUsage = false;
    const finish = (reason: "done" | "aborted" | "error" | "max-steps"): BotEvent[] => [
      ...(sawUsage ? [{ type: "usage", usage } as const] : []),
      { type: "finish", reason },
    ];

    try {
      const signal = this.#abort.signal;
      const allowed = new Set(ctx.toolPolicy.allowedTools);
      const tools = this.#tools.schemas(ctx.toolPolicy.allowedTools);
      const messages: LlmMessage[] = [
        { role: "system", content: systemPrompt(ctx, tools.length > 0) },
        ...this.#history,
        { role: "user", content: text },
      ];

      for (let step = 0; step < this.#maxSteps; step++) {
        if (signal.aborted) return yield* finish("aborted");
        let stepText = "";
        const calls: LlmToolCall[] = [];
        let reason: string = "stop";

        for await (const chunk of this.#llm.stream({
          model: ctx.model,
          messages,
          ...(tools.length ? { tools } : {}),
          signal,
        })) {
          switch (chunk.type) {
            case "text-delta":
              stepText += chunk.text;
              yield chunk;
              break;
            case "reasoning-delta":
              yield chunk;
              break;
            case "tool-call":
              calls.push(chunk.call);
              break;
            case "usage":
              sawUsage = true;
              usage.input += chunk.usage.input;
              usage.output += chunk.usage.output;
              if (chunk.usage.cachedInput)
                usage.cachedInput = (usage.cachedInput ?? 0) + chunk.usage.cachedInput;
              break;
            case "error":
              yield chunk;
              break;
            case "finish":
              reason = chunk.reason;
              break;
          }
        }

        if (reason === "aborted" || signal.aborted) return yield* finish("aborted");
        if (reason === "error") return yield* finish("error");
        if (reason === "length")
          yield { type: "error", message: "The answer was cut off (model length limit)." };
        if (calls.length === 0) return yield* finish("done");

        messages.push({ role: "assistant", content: stepText, toolCalls: calls });
        for (const call of calls) {
          yield { type: "tool-call", callId: call.callId, tool: call.name, args: call.args };
          const result = allowed.has(call.name)
            ? await this.#tools.run(call.name, call.args, {
                botId: ctx.botId,
                threadId: ctx.threadId,
                runId: ctx.runId,
                workspacePath: ctx.workspacePath,
                chain: ctx.chain,
                signal,
              })
            : { ok: false, output: `Tool "${call.name}" is not available to this bot` };
          if (result.blocked) yield { type: "blocked", ...result.blocked };
          yield { type: "tool-result", callId: call.callId, ok: result.ok, output: result.output };
          messages.push({ role: "tool", callId: call.callId, content: result.output });
        }
      }
      return yield* finish("max-steps");
    } catch (error) {
      // Defensive: a bug in a tool or provider must still end the run cleanly.
      yield { type: "error", message: error instanceof Error ? error.message : String(error) };
      return yield* finish("error");
    }
  }
}

function systemPrompt(ctx: BotRunContext, hasTools: boolean): string {
  const parts = [ctx.instructions.trim()];
  if (hasTools) {
    parts.push(
      `You have your own workspace folder. File tools take paths relative to it. Use tools when they help; answer directly when they do not.`,
    );
  }
  return parts.filter(Boolean).join("\n\n");
}
