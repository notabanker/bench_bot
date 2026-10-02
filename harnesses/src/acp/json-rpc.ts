import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** One line of JSON longer than this is treated as a broken peer. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

/**
 * JSON-RPC 2.0 over a child process's stdin/stdout, one JSON message per line (the ACP stdio
 * transport). Handles both directions: our requests to the agent and the agent's requests to us.
 */
export class JsonRpcConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #nextId = 1;
  #buffer = "";
  #closed: Error | null = null;
  onRequest: RequestHandler = async (method) => {
    throw new RpcError(-32601, `Method not found: ${method}`);
  };
  onNotification: NotificationHandler = () => {};
  /** Last stderr lines, for error messages when the program dies. */
  stderrTail = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on("exit", (code, signal) =>
      this.#close(new Error(`program exited (${signal ?? `code ${code}`})`)),
    );
    child.on("error", (error) => this.#close(error));
    child.stdin.on("error", () => {}); // EPIPE after exit is reported via "exit".
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", method, params });
  }

  /** Resolves when the program has exited. */
  readonly exited: Promise<void> = new Promise((resolve) => {
    queueMicrotask(() => {
      if (this.#closed) resolve();
      else this.#child.once("exit", () => resolve());
    });
  });

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.#closed) this.#child.kill(signal);
  }

  /**
   * Ends the program politely: closes its input (ACP agents clean up on end of input), waits,
   * then SIGTERM, then SIGKILL. Resolves once it has exited.
   */
  async shutdown(graceMs = 5_000): Promise<void> {
    if (this.#closed) return;
    const exited = (ms: number) =>
      Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref()),
      ]);
    this.#child.stdin.end();
    if (await exited(graceMs)) return;
    this.#child.kill("SIGTERM");
    if (await exited(2_000)) return;
    this.#child.kill("SIGKILL");
    await exited(2_000);
  }

  #write(message: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_LINE_BYTES && !this.#buffer.includes("\n")) {
      this.#close(new Error("program sent an oversized message"));
      this.kill("SIGKILL");
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let msg: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Programs sometimes print logs to stdout; ignore non-JSON lines.
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const id = msg.id;
      this.onRequest(msg.method, msg.params).then(
        (result) => this.#write({ jsonrpc: "2.0", id, result: result ?? null }),
        (error: unknown) =>
          this.#write({
            jsonrpc: "2.0",
            id,
            error: {
              code: error instanceof RpcError ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
    } else if (msg.method !== undefined) {
      this.onNotification(msg.method, msg.params);
    } else if (typeof msg.id === "number") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error)
        pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else pending.resolve(msg.result);
    }
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const p of this.#pending.values()) p.reject(error);
    this.#pending.clear();
  }
}
