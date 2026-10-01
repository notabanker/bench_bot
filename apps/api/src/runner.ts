import { randomUUID } from "node:crypto";
import type { RunStore } from "@bench_bot/providers";
import type {
  BotDirectory,
  BotEvent,
  Delivery,
  FinishReason,
  Harness,
  HarnessCatalog,
  QueueService,
  RunOutcome,
  SessionService,
  TokenUsage,
} from "@bench_bot/services";
import type { Hub } from "./hub.ts";

/** How many finished deliveries `whenDone` can still answer for. */
const MAX_REMEMBERED_OUTCOMES = 1000;

export interface BotRunnerDeps {
  bots: BotDirectory;
  harnesses: HarnessCatalog;
  session: SessionService;
  runs: RunStore;
  hub: Hub;
  newRunId?: () => string;
}

interface Waiter {
  promise: Promise<RunOutcome>;
  resolve: (outcome: RunOutcome) => void;
}

interface Active {
  delivery: Delivery;
  runId: string;
  harness: Harness | undefined;
}

/**
 * The per-bot waiting line and the thing that actually runs bots. One live run per bot; every
 * event a harness reports is written to the thread log as it arrives.
 */
export class BotRunner implements QueueService {
  readonly #deps: BotRunnerDeps;
  readonly #newRunId: () => string;
  readonly #queues = new Map<string, Delivery[]>();
  readonly #active = new Map<string, Active>();
  readonly #paused = new Set<string>();
  readonly #waiters = new Map<string, Waiter>();
  readonly #idle = new Set<() => void>();

  constructor(deps: BotRunnerDeps) {
    this.#deps = deps;
    this.#newRunId = deps.newRunId ?? (() => `run_${randomUUID()}`);
  }

  enqueue(delivery: Delivery): number {
    this.#waiter(delivery.id);
    const queue = this.#queues.get(delivery.botId) ?? [];
    queue.push(delivery);
    this.#queues.set(delivery.botId, queue);
    const ahead = queue.length - 1 + (this.#active.has(delivery.botId) ? 1 : 0);
    void this.#drain(delivery.botId);
    return ahead;
  }

  whenDone(deliveryId: string): Promise<RunOutcome> {
    return this.#waiter(deliveryId).promise;
  }

  async abortThread(threadId: string): Promise<void> {
    for (const [botId, queue] of this.#queues) {
      const kept = queue.filter((d) => d.threadId !== threadId);
      for (const dropped of queue.filter((d) => d.threadId === threadId)) {
        this.#settle(dropped.id, { runId: "", reason: "aborted", text: "" });
      }
      this.#queues.set(botId, kept);
    }
    const running = [...this.#active.values()].filter((a) => a.delivery.threadId === threadId);
    await Promise.all(running.map((a) => a.harness?.abort()));
  }

  pending(botId: string): number {
    return this.#queues.get(botId)?.length ?? 0;
  }

  isRunning(botId: string): boolean {
    return this.#active.has(botId);
  }

  activeRun(botId: string): { runId: string; threadId: string } | undefined {
    const a = this.#active.get(botId);
    return a && { runId: a.runId, threadId: a.delivery.threadId };
  }

  pause(botId: string): void {
    this.#paused.add(botId);
  }

  resume(botId: string): void {
    this.#paused.delete(botId);
    void this.#drain(botId);
  }

  isPaused(botId: string): boolean {
    return this.#paused.has(botId);
  }

  /** Stops every running harness (app shutdown). */
  async abortAll(): Promise<void> {
    for (const queue of this.#queues.values()) {
      for (const d of queue.splice(0))
        this.#settle(d.id, { runId: "", reason: "aborted", text: "" });
    }
    await Promise.all([...this.#active.values()].map((a) => a.harness?.abort()));
  }

  /** Resolves once nothing is running or queued (tests). */
  idle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idle.add(resolve));
  }

  #isIdle(): boolean {
    return this.#active.size === 0 && [...this.#queues.values()].every((q) => q.length === 0);
  }

  #waiter(deliveryId: string): Waiter {
    let waiter = this.#waiters.get(deliveryId);
    if (!waiter) {
      let resolve!: (o: RunOutcome) => void;
      const promise = new Promise<RunOutcome>((r) => {
        resolve = r;
      });
      waiter = { promise, resolve };
      this.#waiters.set(deliveryId, waiter);
    }
    return waiter;
  }

  #settle(deliveryId: string, outcome: RunOutcome): void {
    // Keep the settled promise so a late whenDone() still gets the outcome; forget the oldest.
    this.#waiter(deliveryId).resolve(outcome);
    if (this.#waiters.size > MAX_REMEMBERED_OUTCOMES) {
      const oldest = this.#waiters.keys().next().value;
      if (oldest !== undefined) this.#waiters.delete(oldest);
    }
  }

  async #drain(botId: string): Promise<void> {
    if (this.#active.has(botId) || this.#paused.has(botId)) return;
    const delivery = this.#queues.get(botId)?.shift();
    if (!delivery) {
      if (this.#isIdle()) {
        const waiting = [...this.#idle];
        this.#idle.clear();
        for (const done of waiting) done();
      }
      return;
    }
    const active: Active = { delivery, runId: this.#newRunId(), harness: undefined };
    this.#active.set(botId, active);
    let outcome: RunOutcome = { runId: active.runId, reason: "error", text: "" };
    try {
      outcome = await this.#run(active);
    } catch (error) {
      // #run handles engine failures itself; this only catches storage failures.
      console.error(`bench_bot: run ${active.runId} failed:`, error);
    } finally {
      this.#active.delete(botId);
      this.#settle(delivery.id, outcome);
    }
    await this.#drain(botId);
  }

  async #run(active: Active): Promise<RunOutcome> {
    const { delivery, runId } = active;
    const { bots, harnesses, session, runs, hub } = this.#deps;
    let text = "";
    let reason: FinishReason | undefined;
    let usage: TokenUsage | undefined;
    const record = async (event: BotEvent) => {
      if (reason) return; // Exactly one finish per run; ignore anything after it.
      if (event.type === "text-delta") text += event.text;
      if (event.type === "usage") usage = event.usage;
      if (event.type === "finish") reason = event.reason;
      await session.append(delivery.threadId, { kind: "event", runId, event });
    };
    const fail = async (message: string) => {
      await record({ type: "error", message });
      await record({ type: "finish", reason: "error" });
    };

    const bot = await bots.get(delivery.botId);
    if (!bot) {
      await fail(`Unknown bot "${delivery.botId}"`);
      return { runId, reason: "error", text };
    }
    let factory: ReturnType<HarnessCatalog["get"]>;
    try {
      factory = harnesses.get(bot.harness);
    } catch (error) {
      await fail(errorMessage(error));
      return { runId, reason: "error", text };
    }

    runs.start({
      id: runId,
      threadId: delivery.threadId,
      botId: bot.id,
      harness: bot.harness,
      model: bot.model,
    });
    hub.run({ threadId: delivery.threadId, botId: bot.id, runId, status: "running" });

    const harness = factory.create();
    active.harness = harness;
    try {
      await harness.start({
        botId: bot.id,
        threadId: delivery.threadId,
        runId,
        workspacePath: bot.workspacePath,
        model: bot.model,
        instructions: bot.instructions,
        toolPolicy: { allowedTools: bot.tools },
        sessionLog: session.log(delivery.threadId),
        untilSeq: delivery.seq,
        chain: delivery.chain,
      });
      for await (const event of harness.send(delivery.text)) {
        await record(event);
        if (reason) break;
      }
      if (!reason) await fail("The engine stopped without finishing the run");
    } catch (error) {
      await fail(errorMessage(error));
    }

    const final = reason ?? "error";
    runs.finish(runId, final, usage);
    hub.run({ threadId: delivery.threadId, botId: bot.id, runId, status: final });
    return { runId, reason: final, text };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
