import type { TokenUsage } from "./events.ts";
import type { ToolSchema } from "./tool.ts";

export interface LlmToolCall {
  callId: string;
  name: string;
  args: unknown;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; callId: string; content: string };

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

export type LlmFinishReason = "stop" | "tool-calls" | "length" | "aborted" | "error";

/** One streamed piece of a model reply. Tool calls arrive complete, never in fragments. */
export type LlmChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; call: LlmToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; message: string }
  | { type: "finish"; reason: LlmFinishReason };

/** Talks to one model endpoint (OpenCode Go, Ollama, ...). */
export interface LlmService {
  /**
   * Streams one model reply. Never throws: network and API failures become an `error` chunk
   * followed by `finish` with reason "error". Ends with exactly one `finish`.
   */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}
