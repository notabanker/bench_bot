/**
 * A typed name for one service. The type parameter ties the name to the interface the service
 * must implement, so `kernel.get(key)` returns the right type without a cast.
 */
export class ServiceKey<T> {
  // Phantom field: carries T for the type checker only, never set at runtime.
  declare readonly __type?: T;

  constructor(readonly name: string) {}

  toString(): string {
    return `ServiceKey(${this.name})`;
  }
}

export class ServiceMissingError extends Error {
  constructor(readonly serviceName: string) {
    super(`Service "${serviceName}" is not registered`);
    this.name = "ServiceMissingError";
  }
}

export class ServiceAlreadyRegisteredError extends Error {
  constructor(readonly serviceName: string) {
    super(`Service "${serviceName}" is already registered`);
    this.name = "ServiceAlreadyRegisteredError";
  }
}

/** The service registry. No globals: every app builds its own kernel and passes it down. */
export class Kernel {
  readonly #services = new Map<string, unknown>();

  register<T>(key: ServiceKey<T>, service: T): void {
    if (this.#services.has(key.name)) throw new ServiceAlreadyRegisteredError(key.name);
    this.#services.set(key.name, service);
  }

  get<T>(key: ServiceKey<T>): T {
    if (!this.#services.has(key.name)) throw new ServiceMissingError(key.name);
    return this.#services.get(key.name) as T;
  }

  has(key: ServiceKey<unknown>): boolean {
    return this.#services.has(key.name);
  }

  /** Names of every registered service, in registration order. */
  names(): string[] {
    return [...this.#services.keys()];
  }
}
