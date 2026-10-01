import type { BotView } from "../api.ts";

/** Placeholder for a bot's computer. A live screen comes later; for now an honest empty state. */
export function ComputerPane({ bot, onClose }: { bot: BotView; onClose: () => void }) {
  return (
    <aside className="computer">
      <header className="pane-head">
        <span className="pane-title">{bot.name}'s computer</span>
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="computer-screen" role="img" aria-label="No computer connected">
        <svg viewBox="0 0 160 100" width="100%" aria-hidden="true">
          <rect x="8" y="8" width="144" height="74" rx="4" className="screen-frame" />
          <rect x="14" y="14" width="132" height="62" rx="2" className="screen-glass" />
          <rect x="66" y="84" width="28" height="6" rx="1" className="screen-frame" />
        </svg>
        <p>No computer connected yet.</p>
        <p className="muted">
          Later this shows a live view of the bot's screen. For now bots work in their own folder.
        </p>
      </div>
    </aside>
  );
}
