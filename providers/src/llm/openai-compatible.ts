import type {
  LlmChunk,
  LlmFinishReason,
  LlmMessage,
  LlmRequest,
  LlmService,
  LlmToolCall,
  TokenUsage,
} from "@bench_bot/services";

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export interface OpenAiCompatibleOptions {
  /** e.g. https://opencode.ai/zen/go/v1 or http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>`. Local servers usually need none. */
  apiKey?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

/** LlmService for any OpenAI-style `/chat/completions` endpoint, streamed over SSE. */
export class OpenAiCompatibleLlm implements LlmService {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey || undefined;
    this.#fetch = options.fetch ?? fetch;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmChunk> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      yield* failure(error, request.signal);
      return;
    }

    if (!response.ok || !response.body) {
      const detail = await readErrorMessage(response);
      yield { type: "error", message: `Model endpoint answered ${response.status}: ${detail}` };
      yield { type: "finish", reason: "error" };
      return;
    }

    const calls = new ToolCallAssembler();
    let finishReason: LlmFinishReason = "stop";
    let usage: TokenUsage | undefined;

    try {
      for await (const data of sseData(response.body)) {
        if (data === "[DONE]") break;
        let chunk: WireChunk;
        try {
          chunk = JSON.parse(data) as WireChunk;
        } catch {
          continue; // Keep-alive comments or partial garbage: skip, the stream goes on.
        }
        if (chunk.error) {
          yield { type: "error", message: errorText(chunk.error) };
          yield { type: "finish", reason: "error" };
          return;
        }
        if (chunk.usage) usage = toUsage(chunk.usage);
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === "string" && reasoning) {
            yield { type: "reasoning-delta", text: reasoning };
          }
          if (typeof delta.content === "string" && delta.content) {
            yield { type: "text-delta", text: delta.content };
          }
          for (const part of delta.tool_calls ?? []) calls.add(part);
          if (choice.finish_reason) finishReason = mapFinish(choice.finish_reason);
        }
      }
    } catch (error) {
      yield* failure(error, request.signal);
      return;
    }

    for (const call of calls.complete()) yield { type: "tool-call", call };
    if (usage) yield { type: "usage", usage };
    if (calls.size > 0) finishReason = "tool-calls";
    yield { type: "finish", reason: finishReason };
  }
}

// --- wire format -----------------------------------------------------------------------------

interface WireToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: WireToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: unknown;
}

function toWireMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.callId,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.callId, content: message.content };
  }
}

/** Tool calls arrive in fragments (name first, arguments piece by piece); this joins them. */
class ToolCallAssembler {
  readonly #parts = new Map<number, { id: string; name: string; args: string }>();

  get size(): number {
    return this.#parts.size;
  }

  add(delta: WireToolCallDelta): void {
    const index = delta.index ?? 0;
    const part = this.#parts.get(index) ?? { id: "", name: "", args: "" };
    if (delta.id) part.id = delta.id;
    if (delta.function?.name) part.name += delta.function.name;
    if (delta.function?.arguments) part.args += delta.function.arguments;
    this.#parts.set(index, part);
  }

  complete(): LlmToolCall[] {
    return [...this.#parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, p]) => ({
        callId: p.id || `call_${index}`,
        name: p.name,
        args: parseArgs(p.args),
      }));
  }
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // The tool's own validation reports the problem back to the model.
  }
}

function mapFinish(reason: string): LlmFinishReason {
  if (reason === "tool_calls" || reason === "function_call") return "tool-calls";
  if (reason === "length") return "length";
  return "stop";
}

function toUsage(u: NonNullable<WireChunk["usage"]>): TokenUsage {
  const cached = u.prompt_tokens_details?.cached_tokens;
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    ...(cached ? { cachedInput: cached } : {}),
  };
}

/** Yields the `data:` payload of each server-sent event. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (data.length) yield data.join("\n");
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
  if (data.length) yield data.join("\n");
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (parsed.error) return errorText(parsed.error);
    if (typeof parsed.message === "string") return parsed.message;
  } catch {}
  return text.slice(0, 300) || response.statusText || "no details";
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return JSON.stringify(error);
}

function* failure(error: unknown, signal: AbortSignal | undefined): Iterable<LlmChunk> {
  if (signal?.aborted) {
    yield { type: "finish", reason: "aborted" };
    return;
  }
  yield { type: "error", message: `Could not reach the model endpoint: ${errorText(error)}` };
  yield { type: "finish", reason: "error" };
}
