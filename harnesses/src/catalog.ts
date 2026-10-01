import type { HarnessCatalog, HarnessFactory } from "@bench_bot/services";

export class UnknownHarnessError extends Error {
  constructor(readonly harnessId: string) {
    super(`No harness "${harnessId}" is registered`);
    this.name = "UnknownHarnessError";
  }
}

export class HarnessRegistry implements HarnessCatalog {
  readonly #factories = new Map<string, HarnessFactory>();

  constructor(factories: HarnessFactory[] = []) {
    for (const f of factories) this.add(f);
  }

  add(factory: HarnessFactory): void {
    if (this.#factories.has(factory.id))
      throw new Error(`Harness "${factory.id}" is already registered`);
    this.#factories.set(factory.id, factory);
  }

  get(harnessId: string): HarnessFactory {
    const factory = this.#factories.get(harnessId);
    if (!factory) throw new UnknownHarnessError(harnessId);
    return factory;
  }

  ids(): string[] {
    return [...this.#factories.keys()];
  }
}
