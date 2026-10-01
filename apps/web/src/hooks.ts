import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BotView, type Health, type StoredEntry, type Thread } from "./api.ts";

/** The roster, refreshed whenever a run starts or ends anywhere. */
export function useBots() {
  const [bots, setBots] = useState<BotView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ file: string; message: string }[]>([]);
  const refresh = useCallback(() => {
    api.botProblems().then(setProblems, () => {});
    api
      .bots()
      .then((b) => {
        setBots(b);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    const source = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("run", () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 100);
    });
    source.addEventListener("ready", refresh);
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [refresh]);

  return { bots, problems, error, refresh };
}

export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    api.health().then(setHealth, () => setHealth(null));
  }, []);
  return health;
}

export function useThreads(botId: string | null) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const refresh = useCallback(async () => {
    if (!botId) return setThreads([]);
    setThreads(await api.threads(botId));
  }, [botId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { threads, refresh };
}

/** One thread's log, kept live over SSE. Reconnects resume after the last seen seq. */
export function useThreadEntries(threadId: string | null) {
  const [entries, setEntries] = useState<StoredEntry[]>([]);
  const lastSeq = useRef(0);

  useEffect(() => {
    setEntries([]);
    lastSeq.current = 0;
    if (!threadId) return;
    const source = new EventSource(`/api/threads/${threadId}/events`);
    source.addEventListener("entry", (e) => {
      const entry = JSON.parse((e as MessageEvent<string>).data) as StoredEntry;
      if (entry.seq <= lastSeq.current) return;
      lastSeq.current = entry.seq;
      setEntries((prev) => [...prev, entry]);
    });
    return () => source.close();
  }, [threadId]);

  return entries;
}
