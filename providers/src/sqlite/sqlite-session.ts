import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  SessionEntry,
  SessionService,
  StoredEntry,
  Thread,
  ThreadLog,
} from "@bench_bot/services";

export class ThreadNotFoundError extends Error {
  constructor(readonly threadId: string) {
    super(`Thread "${threadId}" does not exist`);
    this.name = "ThreadNotFoundError";
  }
}

export interface SqliteSessionOptions {
  /** Defaults to the current time; tests pass a fixed clock. */
  now?: () => Date;
  /** Defaults to `thr_<uuid>`. */
  newThreadId?: () => string;
}

interface ThreadRow {
  id: string;
  bot_id: string;
  title: string;
  created_at: string;
}

interface EntryRow {
  thread_id: string;
  seq: number;
  at: string;
  kind: "message" | "event";
  run_id: string | null;
  payload: string;
}

const DEFAULT_TITLE = "New chat";

/** SessionService on SQLite: one transaction per append, gap-free `seq` per thread. */
export class SqliteSession implements SessionService {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #newThreadId: () => string;

  constructor(db: DatabaseSync, options: SqliteSessionOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#newThreadId = options.newThreadId ?? (() => `thr_${randomUUID()}`);
  }

  async createThread(botId: string, title = DEFAULT_TITLE): Promise<Thread> {
    const thread: Thread = {
      id: this.#newThreadId(),
      botId,
      title,
      createdAt: this.#now().toISOString(),
    };
    this.#db
      .prepare("INSERT INTO threads (id, bot_id, title, created_at) VALUES (?, ?, ?, ?)")
      .run(thread.id, thread.botId, thread.title, thread.createdAt);
    return thread;
  }

  async getThread(threadId: string): Promise<Thread | undefined> {
    const row = this.#db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as
      | ThreadRow
      | undefined;
    return row && toThread(row);
  }

  /** Newest first. */
  async listThreads(botId: string): Promise<Thread[]> {
    const rows = this.#db
      .prepare("SELECT * FROM threads WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(botId) as unknown as ThreadRow[];
    return rows.map(toThread);
  }

  async append(threadId: string, entry: SessionEntry): Promise<StoredEntry> {
    const at = this.#now().toISOString();
    const runId = entry.kind === "event" ? entry.runId : null;
    const payload = JSON.stringify(
      entry.kind === "message" ? { from: entry.from, text: entry.text } : { event: entry.event },
    );

    // IMMEDIATE takes the write lock first, so two appends can never pick the same seq.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.#db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId)) {
        throw new ThreadNotFoundError(threadId);
      }
      const { next } = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM entries WHERE thread_id = ?")
        .get(threadId) as { next: number };
      this.#db
        .prepare(
          "INSERT INTO entries (thread_id, seq, at, kind, run_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(threadId, next, at, entry.kind, runId, payload);
      this.#db.exec("COMMIT");
      return { ...entry, threadId, seq: next, at };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async read(threadId: string, options: { afterSeq?: number } = {}): Promise<StoredEntry[]> {
    const rows = this.#db
      .prepare("SELECT * FROM entries WHERE thread_id = ? AND seq > ? ORDER BY seq")
      .all(threadId, options.afterSeq ?? 0) as unknown as EntryRow[];
    return rows.map(toStoredEntry);
  }

  log(threadId: string): ThreadLog {
    return {
      threadId,
      append: (entry) => this.append(threadId, entry),
      read: () => this.read(threadId),
    };
  }
}

function toThread(row: ThreadRow): Thread {
  return { id: row.id, botId: row.bot_id, title: row.title, createdAt: row.created_at };
}

function toStoredEntry(row: EntryRow): StoredEntry {
  const base = { threadId: row.thread_id, seq: row.seq, at: row.at };
  const payload = JSON.parse(row.payload);
  if (row.kind === "message") {
    return { ...base, kind: "message", from: payload.from, text: payload.text };
  }
  // The schema guarantees run_id is set for events.
  return { ...base, kind: "event", runId: row.run_id as string, event: payload.event };
}
