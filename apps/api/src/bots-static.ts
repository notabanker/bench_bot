import type { BotDefinition, BotDirectory } from "@bench_bot/services";

/** A fixed roster held in memory (tests, and the fallback when no bot files exist). */
export class StaticBotDirectory implements BotDirectory {
  readonly #bots: BotDefinition[];

  constructor(bots: BotDefinition[]) {
    this.#bots = bots;
  }

  async list(): Promise<BotDefinition[]> {
    return [...this.#bots];
  }

  async get(botId: string): Promise<BotDefinition | undefined> {
    return this.#bots.find((b) => b.id === botId);
  }
}
