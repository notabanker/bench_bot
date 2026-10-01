/**
 * Everything a bot run can report, as one closed list. Every harness (our loop, OpenCode,
 * Prime Agent) translates its own output into these events; the session log stores them and the
 * UI renders them. A harness never throws at its caller: failures become an `error` event
 * followed by `finish` with reason "error".
 */

export interface TokenUsage {
  input: number;
  output: number;
  cachedInput?: number;
}

export type FinishReason =
  /** The bot finished its answer normally. */
  | "done"
  /** The user (or a delegating bot) stopped the run. */
  | "aborted"
  /** The run failed; an `error` event comes first with the details. */
  | "error"
  /** The run hit its step limit (too many tool rounds in one turn). */
  | "max-steps";

export type BotEvent =
  /** A piece of the bot's visible answer, in order. */
  | { type: "text-delta"; text: string }
  /** A piece of the model's thinking, if the model reports it. Shown folded in the UI. */
  | { type: "reasoning-delta"; text: string }
  /** The bot wants to use a tool. `callId` links it to its `tool-result`. */
  | { type: "tool-call"; callId: string; tool: string; args: unknown }
  /** The outcome of a tool call. `ok: false` means the tool failed, not the run. */
  | { type: "tool-result"; callId: string; ok: boolean; output: string }
  /** The safety policy refused an action. The run continues; the bot is told why. */
  | { type: "blocked"; action: string; reason: string }
  /** Token counts for this run. Reported once, before `finish`; never summed across events. */
  | { type: "usage"; usage: TokenUsage }
  /** Something went wrong. `finish` with reason "error" follows if the run cannot continue. */
  | { type: "error"; message: string }
  /** The last event of every run, exactly once. */
  | { type: "finish"; reason: FinishReason };

export type BotEventType = BotEvent["type"];

export function isFinish(event: BotEvent): event is Extract<BotEvent, { type: "finish" }> {
  return event.type === "finish";
}
