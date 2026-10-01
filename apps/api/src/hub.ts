import { EventEmitter } from "node:events";
import type { RunStatus } from "@bench_bot/providers";
import type {
  SessionEntry,
  SessionService,
  StoredEntry,
  Thread,
  ThreadLog,
} from "@bench_bot/services";

export interface RunStatusChange {
  threadId: string;
  botId: string;
  runId: string;
  status: RunStatus;
}

/** In-process notifications for live views (SSE): new log entries and run status changes. */
export class Hub {
  readonly #emitter = new EventEmitter().setMaxListeners(0);

  entry(entry: StoredEntry): void {
    this.#emitter.emit("entry", entry);
  }

  run(change: RunStatusChange): void {
    this.#emitter.emit("run", change);
  }

  onEntry(listener: (entry: StoredEntry) => void): () => void {
    this.#emitter.on("entry", listener);
    return () => this.#emitter.off("entry", listener);
  }

  onRun(listener: (change: RunStatusChange) => void): () => void {
    this.#emitter.on("run", listener);
    return () => this.#emitter.off("run", listener);
  }
}

/** A SessionService that also announces every appended entry on the hub. */
export class LiveSession implements SessionService {
  constructor(
    readonly inner: SessionService,
    readonly hub: Hub,
  ) {}

  createThread(botId: string, title?: string): Promise<Thread> {
    return this.inner.createThread(botId, title);
  }
  getThread(threadId: string): Promise<Thread | undefined> {
    return this.inner.getThread(threadId);
  }
  listThreads(botId: string): Promise<Thread[]> {
    return this.inner.listThreads(botId);
  }
  read(threadId: string, options?: { afterSeq?: number }): Promise<StoredEntry[]> {
    return this.inner.read(threadId, options);
  }
  async append(threadId: string, entry: SessionEntry): Promise<StoredEntry> {
    const stored = await this.inner.append(threadId, entry);
    this.hub.entry(stored);
    return stored;
  }
  log(threadId: string): ThreadLog {
    return {
      threadId,
      append: (entry) => this.append(threadId, entry),
      read: () => this.read(threadId),
    };
  }
}
