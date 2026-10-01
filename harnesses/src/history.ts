import type { LlmMessage, LlmToolCall, StoredEntry } from "@bench_bot/services";

/**
 * Rebuilds the model conversation from a thread log: user messages, the bot's earlier answers,
 * and its tool calls with their results. Other events (usage, blocked, finish…) are not part of
 * what the model saw and are skipped.
 */
export function historyToMessages(entries: readonly StoredEntry[]): LlmMessage[] {
  const messages: LlmMessage[] = [];
  let runId: string | undefined;
  let assistant: { content: string; toolCalls: LlmToolCall[] } | undefined;
  const unanswered = new Set<string>();

  const flushAssistant = () => {
    if (assistant && (assistant.content || assistant.toolCalls.length)) {
      messages.push({
        role: "assistant",
        content: assistant.content,
        ...(assistant.toolCalls.length ? { toolCalls: assistant.toolCalls } : {}),
      });
    }
    assistant = undefined;
  };
  const closeRun = () => {
    flushAssistant();
    // Model APIs require an answer for every tool call, even if the run stopped first.
    for (const callId of unanswered) {
      messages.push({ role: "tool", callId, content: "(no result: the run was stopped)" });
    }
    unanswered.clear();
    runId = undefined;
  };

  for (const entry of entries) {
    if (entry.kind === "message") {
      closeRun();
      const text =
        entry.from.kind === "bot"
          ? `Message from bot "${entry.from.botId}":\n${entry.text}`
          : entry.text;
      messages.push({ role: "user", content: text });
      continue;
    }
    if (entry.runId !== runId) {
      closeRun();
      runId = entry.runId;
    }
    const event = entry.event;
    switch (event.type) {
      case "text-delta":
        assistant ??= { content: "", toolCalls: [] };
        assistant.content += event.text;
        break;
      case "tool-call":
        assistant ??= { content: "", toolCalls: [] };
        assistant.toolCalls.push({ callId: event.callId, name: event.tool, args: event.args });
        unanswered.add(event.callId);
        break;
      case "tool-result":
        flushAssistant();
        if (unanswered.delete(event.callId)) {
          messages.push({ role: "tool", callId: event.callId, content: event.output });
        }
        break;
      default:
        break;
    }
  }
  closeRun();
  return messages;
}
