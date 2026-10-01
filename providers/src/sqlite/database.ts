import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One schema step. Versions start at 1 and have no gaps; a shipped step is never edited. */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "threads and the append-only thread log",
    sql: `
      CREATE TABLE threads (
        id         TEXT PRIMARY KEY,
        bot_id     TEXT NOT NULL,
        title      TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX threads_by_bot ON threads (bot_id, created_at);

      -- Every user message and every bot event, in order. Rows are only ever inserted.
      CREATE TABLE entries (
        thread_id TEXT    NOT NULL REFERENCES threads (id),
        seq       INTEGER NOT NULL,
        at        TEXT    NOT NULL,
        kind      TEXT    NOT NULL CHECK (kind IN ('message', 'event')),
        run_id    TEXT,
        payload   TEXT    NOT NULL,
        PRIMARY KEY (thread_id, seq),
        -- Bot events always belong to a run; user/bot messages never do.
        CHECK ((kind = 'event') = (run_id IS NOT NULL))
      ) WITHOUT ROWID;

      CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries
        BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
      CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
        BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
    `,
  },
  {
    version: 2,
    description: "runs: one row per bot run with status and token usage",
    sql: `
      CREATE TABLE runs (
        id                  TEXT PRIMARY KEY,
        thread_id           TEXT NOT NULL REFERENCES threads (id),
        bot_id              TEXT NOT NULL,
        harness             TEXT NOT NULL,
        model               TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN
                              ('running', 'done', 'aborted', 'error', 'max-steps', 'interrupted')),
        started_at          TEXT NOT NULL,
        finished_at         TEXT,
        input_tokens        INTEGER,
        output_tokens       INTEGER,
        cached_input_tokens INTEGER,
        -- The engine's own session id (OpenCode/Prime Agent), for resuming. Phase 11.
        harness_session_id  TEXT
      );
      CREATE INDEX runs_by_thread ON runs (thread_id, started_at);
    `,
  },
];

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly known: number,
  ) {
    super(
      `Database schema version ${found} is newer than this app knows (${known}). Update bench_bot.`,
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Opens (or creates) the database at `path` and applies any missing migrations.
 * Use ":memory:" for a throwaway database in tests.
 */
export function openDatabase(
  path: string,
  migrations: readonly Migration[] = MIGRATIONS,
): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  try {
    migrate(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration ${i + 1} is missing or out of order`);
  });

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  )`);

  const current = schemaVersion(db);
  if (current > migrations.length) throw new SchemaTooNewError(current, migrations.length);

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of migrations.slice(current)) {
    // Each step and its record land together or not at all.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      record.run(m.version, m.description, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
