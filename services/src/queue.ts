import type { FinishReason } from "./events.ts";
import type { MessageSender } from "./session.ts";

export interface Delivery {
  id: string;
  botId: string;
  threadId: string;
  from: MessageSender;
  text: string;
  /** Seq of the message in the thread log; the run answers this message. */
  seq: number;
  /** Ask-chain for delegated work; `[botId]` for user messages. */
  chain: string[];
}

export interface RunOutcome {
  runId: string;
  reason: FinishReason;
  /** The bot's visible answer (all text pieces joined). */
  text: string;
}

/** Per-bot waiting line: one live run per bot, the rest wait in order. */
export interface QueueService {
  /** Returns how many deliveries are ahead of this one (0 = starts now). */
  enqueue(delivery: Delivery): number;
  /** Resolves when the delivery's run has finished (or it was dropped: reason "aborted"). */
  whenDone(deliveryId: string): Promise<RunOutcome>;
  /** Stops the running delivery of this thread and drops its queued ones. */
  abortThread(threadId: string): Promise<void>;
  pending(botId: string): number;
  /** True while a run of this bot is in progress. */
  isRunning(botId: string): boolean;
  pause(botId: string): void;
  resume(botId: string): void;
  isPaused(botId: string): boolean;
}
