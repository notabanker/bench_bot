import type { DatabaseSync } from "node:sqlite";
import type { FinishReason, TokenUsage } from "@bench_bot/services";

export type RunStatus = "running" | FinishReason | "interrupted";

export interface RunRecord {
  id: string;
  threadId: string;
  botId: string;
  harness: string;
  model: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  usage: TokenUsage | null;
}

interface RunRow {
  id: string;
  thread_id: string;
  bot_id: string;
  harness: string;
  model: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
}

/** Bookkeeping for bot runs: which run happened, how it ended, what it cost. */
export class RunStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  start(run: {
    id: string;
    threadId: string;
    botId: string;
    harness: string;
    model: string;
  }): RunRecord {
    const startedAt = this.#now().toISOString();
    this.#db
      .prepare(
        "INSERT INTO runs (id, thread_id, bot_id, harness, model, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
      )
      .run(run.id, run.threadId, run.botId, run.harness, run.model, startedAt);
    return { ...run, status: "running", startedAt, finishedAt: null, usage: null };
  }

  finish(runId: string, status: FinishReason, usage?: TokenUsage): void {
    this.#db
      .prepare(
        "UPDATE runs SET status = ?, finished_at = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ? WHERE id = ? AND status = 'running'",
      )
      .run(
        status,
        this.#now().toISOString(),
        usage?.input ?? null,
        usage?.output ?? null,
        usage?.cachedInput ?? null,
        runId,
      );
  }

  get(runId: string): RunRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    return row && toRecord(row);
  }

  listForThread(threadId: string): RunRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at, rowid")
      .all(threadId) as unknown as RunRow[];
    return rows.map(toRecord);
  }

  /** After a crash or quit mid-run: runs still marked running can never finish. Returns them. */
  markInterrupted(): RunRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM runs WHERE status = 'running'")
      .all() as unknown as RunRow[];
    this.#db
      .prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'")
      .run(this.#now().toISOString());
    return rows.map(toRecord);
  }
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    botId: row.bot_id,
    harness: row.harness,
    model: row.model,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    usage:
      row.input_tokens === null
        ? null
        : {
            input: row.input_tokens,
            output: row.output_tokens ?? 0,
            ...(row.cached_input_tokens ? { cachedInput: row.cached_input_tokens } : {}),
          },
  };
}
