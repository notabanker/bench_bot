import type { HarnessCapabilities, StoredEntry, Thread } from "@bench_bot/services";

export type { StoredEntry, Thread };

export interface BotView {
  id: string;
  name: string;
  description: string;
  model: string;
  harness: string;
  harnessAvailable: boolean;
  capabilities: HarnessCapabilities | null;
  tools: string[];
  section: string | null;
  status: { running: boolean; queued: number; paused: boolean };
}

export interface RunView {
  id: string;
  status: string;
  usage: { input: number; output: number; cachedInput?: number } | null;
}

export interface Health {
  ok: boolean;
  offline: boolean;
  model: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>("/api/health"),
  bots: () => request<BotView[]>("/api/bots"),
  threads: (botId: string) => request<Thread[]>(`/api/bots/${encodeURIComponent(botId)}/threads`),
  createThread: (botId: string, title?: string) =>
    request<Thread>(`/api/bots/${encodeURIComponent(botId)}/threads`, {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }),
  thread: (threadId: string) =>
    request<{ thread: Thread; entries: StoredEntry[]; runs: RunView[] }>(
      `/api/threads/${threadId}`,
    ),
  send: (threadId: string, text: string) =>
    request<{ entry: StoredEntry; position: number }>(`/api/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  abort: (threadId: string) =>
    request<{ aborted: boolean }>(`/api/threads/${threadId}/abort`, { method: "POST" }),
};
