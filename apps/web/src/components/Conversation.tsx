import { useEffect, useRef, useState } from "react";
import type { BotView, StoredEntry, Thread } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import { argsSummary, buildTimeline, type TimelineItem, type TurnPart } from "../timeline.ts";
import { BotMark } from "./Roster.tsx";

export function Conversation(props: {
  bot: BotView | null;
  thread: Thread | null;
  entries: StoredEntry[];
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  computerOpen: boolean;
  onToggleComputer: () => void;
  /** Phone layout: back button, chat picker and "new chat" live in the header. */
  narrow?: {
    threads: Thread[];
    onBack: () => void;
    onSelectThread: (id: string) => void;
    onNew: () => void;
  };
}) {
  const items = buildTimeline(props.entries);
  const lastTurn = [...items].reverse().find((i) => i.kind === "turn");
  const lastIsUser = items.at(-1)?.kind === "user";
  const working = (lastTurn?.kind === "turn" && lastTurn.finish === null) || lastIsUser;
  const scroller = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever new entries arrive
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.entries.length]);

  if (!props.bot) return <main className="conversation empty-state">Pick a bot on the left.</main>;

  return (
    <main className="conversation">
      {props.narrow && (
        <header className="pane-head mobile-head">
          <button
            type="button"
            className="btn btn-small"
            onClick={props.narrow.onBack}
            aria-label="Back to bots"
          >
            ‹ Bots
          </button>
          <select
            className="thread-select"
            value={props.thread?.id ?? ""}
            onChange={(e) => props.narrow?.onSelectThread(e.target.value)}
            aria-label="Chat"
          >
            {!props.thread && <option value="">New chat</option>}
            {props.narrow.threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-small"
            onClick={props.narrow.onNew}
            aria-label="New chat"
          >
            +
          </button>
        </header>
      )}
      <header className={`pane-head${props.narrow ? " desktop-only" : ""}`}>
        <span className="pane-title">{props.thread?.title ?? "New chat"}</span>
        <span className="pane-sub">
          {props.bot.name} · {props.bot.harness} · {props.bot.model}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className={`btn btn-small${props.computerOpen ? " btn-on" : ""}`}
          onClick={props.onToggleComputer}
          title="Show this bot's computer"
        >
          Computer
        </button>
      </header>
      <div className="timeline" ref={scroller}>
        {items.map((item) => (
          <Item key={item.key} item={item} bot={props.bot as BotView} />
        ))}
        {working && <div className="working">{props.bot.name} is working…</div>}
        {items.length === 0 && <p className="empty">Say hello to {props.bot.name}.</p>}
      </div>
      <Composer
        working={working}
        onSend={props.onSend}
        onStop={props.onStop}
        touch={!!props.narrow}
      />
    </main>
  );
}

function Item({ item, bot }: { item: TimelineItem; bot: BotView }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg msg-user">
          <div className="msg-body">{item.text}</div>
        </div>
      );
    case "bot-message":
      return (
        <div className="msg msg-from-bot">
          <div className="msg-label">from {item.botId}</div>
          <div className="msg-body">
            <Markdown text={item.text} />
          </div>
        </div>
      );
    case "turn":
      return (
        <div className="msg msg-bot">
          <BotMark bot={bot} size={22} />
          <div className="turn">
            {item.parts.map((part, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts only ever get appended
              <Part key={i} part={part} />
            ))}
            <TurnFooter finish={item.finish} usage={item.usage} />
          </div>
        </div>
      );
  }
}

function Part({ part }: { part: TurnPart }) {
  switch (part.kind) {
    case "text":
      return (
        <div className="turn-text">
          <Markdown text={part.text} />
        </div>
      );
    case "reasoning":
      return (
        <details className="reasoning">
          <summary>thinking</summary>
          <div>{part.text}</div>
        </details>
      );
    case "tool": {
      const state = part.result ? (part.result.ok ? "ok" : "fail") : "run";
      return (
        <details className={`chip chip-${state}`}>
          <summary>
            <span className="chip-tool">{part.tool}</span>{" "}
            <span className="chip-args">{argsSummary(part.args)}</span>{" "}
            <span className="chip-state">{state === "run" ? "…" : state === "ok" ? "✓" : "✗"}</span>
          </summary>
          {part.result && <pre className="chip-output">{part.result.output}</pre>}
        </details>
      );
    }
    case "blocked":
      return (
        <div className="note note-blocked">
          Blocked: <code>{part.action}</code> — {part.reason}
        </div>
      );
    case "error":
      return <div className="note note-error">{part.message}</div>;
  }
}

function TurnFooter({
  finish,
  usage,
}: {
  finish: string | null;
  usage: { input: number; output: number } | null;
}) {
  if (!finish && !usage) return null;
  const label =
    finish === "aborted"
      ? "stopped"
      : finish === "max-steps"
        ? "stopped: step limit"
        : finish === "error"
          ? "failed"
          : null;
  return (
    <div className="turn-foot">
      {label && <span className="pill">{label}</span>}
      {usage && (
        <span title="tokens in / out">
          {usage.input}↑ {usage.output}↓
        </span>
      )}
    </div>
  );
}

function Composer(props: {
  working: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  /** Phone: Enter makes a new line; the Send button sends. */
  touch: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await props.onSend(value);
      setText("");
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        value={text}
        placeholder={
          props.touch ? "Message" : "Message (Enter to send, Shift+Enter for a new line)"
        }
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (!props.touch && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-actions">
        {props.working && (
          <button type="button" className="btn" onClick={props.onStop}>
            Stop
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending}>
          Send
        </button>
      </div>
    </form>
  );
}
