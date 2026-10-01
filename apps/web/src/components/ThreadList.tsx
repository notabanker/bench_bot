import type { BotView, Thread } from "../api.ts";

export function ThreadList(props: {
  bot: BotView | null;
  threads: Thread[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <section className="threads">
      <header className="pane-head">
        <span className="pane-title">{props.bot ? props.bot.name : "—"}</span>
        <button type="button" className="btn btn-small" onClick={props.onNew} disabled={!props.bot}>
          New chat
        </button>
      </header>
      <div className="thread-list">
        {props.threads.map((t) => (
          <button
            type="button"
            key={t.id}
            className={`thread-row${t.id === props.selectedId ? " selected" : ""}`}
            onClick={() => props.onSelect(t.id)}
          >
            <span className="thread-title">{t.title}</span>
            <span className="thread-date">{formatDate(t.createdAt)}</span>
          </button>
        ))}
        {props.bot && props.threads.length === 0 && (
          <p className="empty">No chats yet. Write a message to start one.</p>
        )}
      </div>
    </section>
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "short" });
}
