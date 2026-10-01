import type { MessageSender } from "./session.ts";

export interface Delivery {
  id: string;
  botId: string;
  threadId: string;
  from: MessageSender;
  text: string;
}

/** Per-bot waiting line: one live run per bot, the rest wait in order. */
export interface QueueService {
  /** Returns how many deliveries are ahead of this one (0 = starts now). */
  enqueue(delivery: Delivery): number;
  pending(botId: string): number;
  pause(botId: string): void;
  resume(botId: string): void;
  isPaused(botId: string): boolean;
}
