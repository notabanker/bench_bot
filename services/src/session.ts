import type { BotEvent } from "./events.ts";

export interface Thread {
  /** Stable, public id shown in the app. Never the harness's own session id. */
  id: string;
  botId: string;
  title: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

export type MessageSender = { kind: "user" } | { kind: "bot"; botId: string };

export type SessionEntry =
  | { kind: "message"; from: MessageSender; text: string }
  | { kind: "event"; runId: string; event: BotEvent };

export type StoredEntry = SessionEntry & {
  threadId: string;
  /** Position in the thread, starting at 1, without gaps. */
  seq: number;
  /** ISO 8601 timestamp. */
  at: string;
};

/** One thread's log, handed to a harness so it cannot write into other threads. */
export interface ThreadLog {
  readonly threadId: string;
  append(entry: SessionEntry): Promise<StoredEntry>;
  read(): Promise<StoredEntry[]>;
}

/** Append-only history of every thread. Entries are never changed or deleted. */
export interface SessionService {
  createThread(botId: string, title?: string): Promise<Thread>;
  getThread(threadId: string): Promise<Thread | undefined>;
  listThreads(botId: string): Promise<Thread[]>;
  append(threadId: string, entry: SessionEntry): Promise<StoredEntry>;
  /** Entries in order; `afterSeq` returns only newer entries (for catching up after a reconnect). */
  read(threadId: string, options?: { afterSeq?: number }): Promise<StoredEntry[]>;
  log(threadId: string): ThreadLog;
}
