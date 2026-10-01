import { randomUUID } from "node:crypto";
import type {
  AskBotRequest,
  AskBotResult,
  BotDefinition,
  BotDirectory,
  BotSummary,
  DelegationService,
  QueueService,
  SessionService,
  ToolDefinition,
} from "@bench_bot/services";

/** How many bots may be in one ask-chain (user → A → B → C). (default — adjust) */
export const MAX_CHAIN = 3;
/** How long ask_bot waits for an answer. (default — adjust) */
export const ASK_TIMEOUT_MS = 10 * 60_000;

export interface BotDelegationOptions {
  bots: BotDirectory;
  session: SessionService;
  queue: QueueService;
  maxChain?: number;
  timeoutMs?: number;
}

/**
 * Bots asking bots. A question goes into a standing thread per pair ("Asked by <bot>") on the
 * asked bot, runs through its normal queue, and the answer comes back as the tool result.
 */
export class BotDelegation implements DelegationService {
  readonly #o: Required<BotDelegationOptions>;

  constructor(options: BotDelegationOptions) {
    this.#o = { maxChain: MAX_CHAIN, timeoutMs: ASK_TIMEOUT_MS, ...options };
  }

  async listBots(callerBotId: string): Promise<BotSummary[]> {
    return (await this.#o.bots.list())
      .filter((b) => b.id !== callerBotId)
      .map((b) => ({ id: b.id, name: b.name, description: b.description }));
  }

  async askBot(request: AskBotRequest): Promise<AskBotResult> {
    const { bots, session, queue } = this.#o;
    const all = await bots.list();
    const target = resolveBot(all, request.toBotId);
    if (!target) {
      const ids = all.filter((b) => b.id !== request.fromBotId).map((b) => b.id);
      return {
        ok: false,
        reason: `No bot "${request.toBotId}". Teammates: ${ids.join(", ") || "none"}`,
      };
    }
    if (target.id === request.fromBotId) return { ok: false, reason: "A bot cannot ask itself." };
    if (request.chain.includes(target.id)) {
      return {
        ok: false,
        reason: `${target.name} is already part of this request (${request.chain.join(" → ")}); asking again would loop.`,
      };
    }
    if (request.chain.length >= this.#o.maxChain) {
      return {
        ok: false,
        reason: `Too many hand-offs (${request.chain.join(" → ")}); answer with what you have.`,
      };
    }
    if (request.signal?.aborted) return { ok: false, reason: "Stopped." };

    const title = `Asked by ${request.fromBotId}`;
    const thread =
      (await session.listThreads(target.id)).find((t) => t.title === title) ??
      (await session.createThread(target.id, title));
    const message = await session.append(thread.id, {
      kind: "message",
      from: { kind: "bot", botId: request.fromBotId },
      text: request.text,
    });
    const deliveryId = `dlv_${randomUUID()}`;
    queue.enqueue({
      id: deliveryId,
      botId: target.id,
      threadId: thread.id,
      from: { kind: "bot", botId: request.fromBotId },
      text: request.text,
      seq: message.seq,
      chain: [...request.chain, target.id],
    });

    const onAbort = () => void queue.abortThread(thread.id);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#o.timeoutMs);
    });
    try {
      const outcome = await Promise.race([queue.whenDone(deliveryId), timeout]);
      if (outcome === "timeout") {
        return {
          ok: false,
          reason: `${target.name} did not answer in time; it may still be working.`,
        };
      }
      if (outcome.reason === "done")
        return { ok: true, answer: outcome.text.trim() || "(no text answer)" };
      if (outcome.reason === "aborted") return { ok: false, reason: `${target.name} was stopped.` };
      return {
        ok: false,
        reason: `${target.name} could not finish (${outcome.reason}).${outcome.text ? ` Partial answer: ${outcome.text}` : ""}`,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** By id first, then by unique name (case-insensitive). */
function resolveBot(bots: BotDefinition[], idOrName: string): BotDefinition | undefined {
  const byId = bots.find((b) => b.id === idOrName);
  if (byId) return byId;
  const byName = bots.filter((b) => b.name.toLowerCase() === idOrName.trim().toLowerCase());
  return byName.length === 1 ? byName[0] : undefined;
}

/** The `list_bots` and `ask_bot` tools on top of a DelegationService. */
export function delegationTools(delegation: DelegationService): ToolDefinition[] {
  return [
    {
      schema: {
        name: "list_bots",
        description: "List your teammates (other bots) with what each one is good at.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      async run(_args, ctx) {
        const bots = await delegation.listBots(ctx.botId);
        if (bots.length === 0) return { ok: true, output: "You have no teammates." };
        return {
          ok: true,
          output: bots
            .map((b) => `${b.id} — ${b.name}: ${b.description || "(no description)"}`)
            .join("\n"),
        };
      },
    },
    {
      schema: {
        name: "ask_bot",
        description:
          "Ask a teammate a question or give it a task, and wait for its answer. Include everything it needs; it does not see this conversation.",
        parameters: {
          type: "object",
          properties: {
            bot_id: { type: "string", description: "The teammate's id from list_bots" },
            message: { type: "string", description: "A self-contained question or task" },
          },
          required: ["bot_id", "message"],
          additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const a = (args ?? {}) as { bot_id?: unknown; message?: unknown };
        if (typeof a.bot_id !== "string" || !a.bot_id)
          throw new Error('Argument "bot_id" must be a bot id');
        if (typeof a.message !== "string" || !a.message.trim())
          throw new Error('Argument "message" must be non-empty text');
        const result = await delegation.askBot({
          fromBotId: ctx.botId,
          toBotId: a.bot_id,
          text: a.message.trim(),
          chain: ctx.chain,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return result.ok
          ? { ok: true, output: result.answer }
          : { ok: false, output: result.reason };
      },
    },
  ];
}
