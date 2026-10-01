import type { FinishReason, StoredEntry, TokenUsage } from "@bench_bot/services";

export type TurnPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      args: unknown;
      result?: { ok: boolean; output: string };
    }
  | { kind: "blocked"; action: string; reason: string }
  | { kind: "error"; message: string };

export type TimelineItem =
  | { kind: "user"; key: string; text: string; at: string }
  | { kind: "bot-message"; key: string; botId: string; text: string; at: string }
  | {
      kind: "turn";
      key: string;
      runId: string;
      at: string;
      parts: TurnPart[];
      finish: FinishReason | null;
      usage: TokenUsage | null;
    };

/** Turns the raw thread log into what the chat shows: messages and one block per bot run. */
export function buildTimeline(entries: readonly StoredEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const turns = new Map<string, Extract<TimelineItem, { kind: "turn" }>>();

  for (const entry of entries) {
    if (entry.kind === "message") {
      items.push(
        entry.from.kind === "user"
          ? { kind: "user", key: `m${entry.seq}`, text: entry.text, at: entry.at }
          : {
              kind: "bot-message",
              key: `m${entry.seq}`,
              botId: entry.from.botId,
              text: entry.text,
              at: entry.at,
            },
      );
      continue;
    }
    let turn = turns.get(entry.runId);
    if (!turn) {
      turn = {
        kind: "turn",
        key: entry.runId,
        runId: entry.runId,
        at: entry.at,
        parts: [],
        finish: null,
        usage: null,
      };
      turns.set(entry.runId, turn);
      items.push(turn);
    }
    const last = turn.parts.at(-1);
    const event = entry.event;
    switch (event.type) {
      case "text-delta":
        if (last?.kind === "text") last.text += event.text;
        else turn.parts.push({ kind: "text", text: event.text });
        break;
      case "reasoning-delta":
        if (last?.kind === "reasoning") last.text += event.text;
        else turn.parts.push({ kind: "reasoning", text: event.text });
        break;
      case "tool-call":
        turn.parts.push({ kind: "tool", callId: event.callId, tool: event.tool, args: event.args });
        break;
      case "tool-result": {
        const call = turn.parts.find((p) => p.kind === "tool" && p.callId === event.callId);
        if (call?.kind === "tool") call.result = { ok: event.ok, output: event.output };
        break;
      }
      case "blocked":
        turn.parts.push({ kind: "blocked", action: event.action, reason: event.reason });
        break;
      case "error":
        turn.parts.push({ kind: "error", message: event.message });
        break;
      case "usage":
        turn.usage = event.usage;
        break;
      case "finish":
        turn.finish = event.reason;
        break;
    }
  }
  return items;
}

/** Short, single-line summary of tool arguments for a chip. */
export function argsSummary(args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.path === "string") return record.path;
    if (typeof record.bot_id === "string") return `→ ${record.bot_id}`;
  }
  const text = typeof args === "string" ? args : JSON.stringify(args);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
