import type { BotView } from "../api.ts";

const PALETTE = ["#2f6f5e", "#8a5a2b", "#4b5d8a", "#7a3e5c", "#5b6b2f", "#356f7a", "#8a3b2b"];

export function botColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? "#2f6f5e";
}

export function BotMark({ bot, size = 26 }: { bot: Pick<BotView, "id" | "name">; size?: number }) {
  const initials = bot.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="bot-mark" style={{ background: botColor(bot.id), width: size, height: size }}>
      {initials}
    </span>
  );
}

export function Roster(props: {
  bots: BotView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  offline: boolean;
}) {
  const sections = new Map<string, BotView[]>();
  for (const bot of props.bots) {
    const key = bot.section ?? "Bots";
    sections.set(key, [...(sections.get(key) ?? []), bot]);
  }
  return (
    <aside className="roster">
      <header className="roster-head">
        <span className="brand">bench_bot</span>
        {props.offline && (
          <span className="pill pill-warn" title="No OPENCODE_API_KEY: our own loop echoes">
            offline
          </span>
        )}
      </header>
      <nav>
        {[...sections].map(([section, bots]) => (
          <div key={section} className="roster-section">
            <div className="section-label">{section}</div>
            {bots.map((bot) => (
              <button
                type="button"
                key={bot.id}
                className={`bot-row${bot.id === props.selectedId ? " selected" : ""}`}
                onClick={() => props.onSelect(bot.id)}
                title={bot.description}
              >
                <BotMark bot={bot} />
                <span className="bot-text">
                  <span className="bot-name">{bot.name}</span>
                  <span className="bot-meta">
                    {bot.harness} · {bot.model}
                  </span>
                </span>
                <StatusDot bot={bot} />
              </button>
            ))}
          </div>
        ))}
        {props.bots.length === 0 && <p className="empty">No bots yet.</p>}
      </nav>
    </aside>
  );
}

function StatusDot({ bot }: { bot: BotView }) {
  if (!bot.harnessAvailable)
    return <span className="dot dot-bad" title={`Engine "${bot.harness}" is not available`} />;
  if (bot.status.running)
    return (
      <span
        className="dot dot-busy"
        title={`Working${bot.status.queued ? `, ${bot.status.queued} waiting` : ""}`}
      />
    );
  if (bot.status.paused) return <span className="dot dot-paused" title="Paused" />;
  return <span className="dot" title="Idle" />;
}
