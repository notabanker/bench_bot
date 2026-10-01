import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { ComputerPane } from "./components/ComputerPane.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { Roster } from "./components/Roster.tsx";
import { ThreadList } from "./components/ThreadList.tsx";
import { useBots, useHealth, useThreadEntries, useThreads } from "./hooks.ts";

const STORAGE_KEY = "bench_bot.ui";

interface UiState {
  botId: string | null;
  computerFor: string[];
}

function loadUi(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { botId: null, computerFor: [], ...JSON.parse(raw) };
  } catch {}
  return { botId: null, computerFor: [] };
}

export function App() {
  const health = useHealth();
  const { bots, problems, error } = useBots();
  const [ui, setUi] = useState<UiState>(loadUi);
  const [threadId, setThreadId] = useState<string | null>(null);
  const botId = ui.botId && bots.some((b) => b.id === ui.botId) ? ui.botId : (bots[0]?.id ?? null);
  const bot = bots.find((b) => b.id === botId) ?? null;
  const { threads, refresh: refreshThreads } = useThreads(botId);
  const entries = useThreadEntries(threadId);
  const thread = threads.find((t) => t.id === threadId) ?? null;
  const computerOpen = !!botId && ui.computerFor.includes(botId);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
    } catch {}
  }, [ui]);

  // When the bot changes, open its newest chat.
  useEffect(() => {
    setThreadId((current) =>
      current && threads.some((t) => t.id === current) ? current : (threads[0]?.id ?? null),
    );
  }, [threads]);

  const send = async (text: string) => {
    if (!botId) return;
    let id = threadId;
    if (!id) {
      const created = await api.createThread(botId, text.split("\n")[0]?.slice(0, 60));
      id = created.id;
      setThreadId(id);
      await refreshThreads();
    }
    await api.send(id, text);
  };

  return (
    <div className={`app${computerOpen ? " with-computer" : ""}`}>
      <Roster
        bots={bots}
        selectedId={botId}
        offline={!!health?.offline}
        problems={problems}
        onSelect={(id) => {
          setUi((u) => ({ ...u, botId: id }));
          setThreadId(null);
        }}
      />
      <ThreadList
        bot={bot}
        threads={threads}
        selectedId={threadId}
        onSelect={setThreadId}
        onNew={async () => {
          if (!botId) return;
          const created = await api.createThread(botId);
          await refreshThreads();
          setThreadId(created.id);
        }}
      />
      <Conversation
        bot={bot}
        thread={thread}
        entries={entries}
        onSend={send}
        onStop={() => threadId && void api.abort(threadId)}
        computerOpen={computerOpen}
        onToggleComputer={() =>
          botId &&
          setUi((u) => ({
            ...u,
            computerFor: u.computerFor.includes(botId)
              ? u.computerFor.filter((b) => b !== botId)
              : [...u.computerFor, botId],
          }))
        }
      />
      {computerOpen && bot && (
        <ComputerPane
          bot={bot}
          onClose={() =>
            setUi((u) => ({ ...u, computerFor: u.computerFor.filter((b) => b !== bot.id) }))
          }
        />
      )}
      {error && <div className="toast">Server not reachable: {error}</div>}
    </div>
  );
}
