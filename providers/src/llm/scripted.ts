import type { LlmChunk, LlmRequest, LlmService, LlmToolCall } from "@bench_bot/services";

/** One scripted model reply: fixed chunks, or chunks computed from the request. */
export type ScriptedTurn = LlmChunk[] | ((request: LlmRequest) => LlmChunk[]);

/**
 * A fake model for tests and offline runs. Each `stream` call plays the next turn of the script
 * and records the request it received.
 */
export class ScriptedLlm implements LlmService {
  readonly requests: LlmRequest[] = [];
  readonly #turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.#turns = [...turns];
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmChunk> {
    const { signal: _signal, ...copyable } = request;
    this.requests.push(structuredClone(copyable));
    const turn = this.#turns.shift();
    if (!turn) {
      yield { type: "error", message: "ScriptedLlm: no scripted turn left" };
      yield { type: "finish", reason: "error" };
      return;
    }
    for (const chunk of typeof turn === "function" ? turn(request) : turn) {
      // Yield to the event loop so abort() between chunks takes effect, like a real stream.
      await Promise.resolve();
      if (request.signal?.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      yield chunk;
    }
  }
}

/** A plain text answer, split into word-sized pieces. */
export function reply(text: string): LlmChunk[] {
  const pieces = text.match(/\S+\s*/g) ?? [text];
  return [
    ...pieces.map((t): LlmChunk => ({ type: "text-delta", text: t })),
    { type: "finish", reason: "stop" },
  ];
}

/** A turn in which the model asks for tool calls. */
export function callTools(...calls: LlmToolCall[]): LlmChunk[] {
  return [
    ...calls.map((call): LlmChunk => ({ type: "tool-call", call })),
    { type: "finish", reason: "tool-calls" },
  ];
}

/** A model that echoes the last user message; handy for offline demos. */
export class EchoLlm implements LlmService {
  async *stream(request: LlmRequest): AsyncIterable<LlmChunk> {
    const last = [...request.messages].reverse().find((m) => m.role === "user");
    const text = last && "content" in last ? last.content : "";
    yield* reply(`(offline echo, no API key set) You said: ${text}`);
  }
}
