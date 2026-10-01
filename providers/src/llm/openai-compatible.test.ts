import type { LlmChunk, LlmRequest } from "@bench_bot/services";
import { describe, expect, it } from "vitest";
import { OpenAiCompatibleLlm } from "./openai-compatible.ts";

/** A Response whose body is the given SSE text, split into the given pieces. */
function sse(pieces: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

const event = (data: unknown) =>
  `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

async function collect(llm: OpenAiCompatibleLlm, request: Partial<LlmRequest> = {}) {
  const chunks: LlmChunk[] = [];
  for await (const c of llm.stream({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    ...request,
  })) {
    chunks.push(c);
  }
  return chunks;
}

describe("OpenAiCompatibleLlm", () => {
  it("streams text, reasoning and usage, then finishes", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1/",
      apiKey: "secret",
      fetch: async (url, init) => {
        sent = { url: String(url), init: init ?? {} };
        return sse([
          event({ choices: [{ delta: { reasoning_content: "think" } }] }),
          event({ choices: [{ delta: { content: "Hel" } }] }),
          event({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }),
          event({
            choices: [],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 3 },
            },
          }),
          event("[DONE]"),
        ]);
      },
    });

    expect(await collect(llm)).toEqual([
      { type: "reasoning-delta", text: "think" },
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", usage: { input: 7, output: 2, cachedInput: 3 } },
      { type: "finish", reason: "stop" },
    ]);
    expect(sent?.url).toBe("https://example.test/v1/chat/completions");
    expect((sent?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer secret",
    );
    const body = JSON.parse(String(sent?.init.body));
    expect(body).toMatchObject({
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("joins tool-call fragments and sends tools and earlier tool turns in OpenAI format", async () => {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        headers = init?.headers as Record<string, string>;
        return sse([
          event({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "c1", function: { name: "fs_read", arguments: '{"pa' } },
                  ],
                },
              },
            ],
          }),
          event({
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } },
            ],
          }),
          event({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 1, id: "c2", function: { name: "fs_list", arguments: "" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          event("[DONE]"),
        ]);
      },
    });

    const chunks = await collect(llm, {
      messages: [
        { role: "system", content: "sys" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ callId: "c0", name: "fs_list", args: {} }],
        },
        { role: "tool", callId: "c0", content: "[]" },
      ],
      tools: [{ name: "fs_read", description: "read", parameters: { type: "object" } }],
    });

    expect(chunks).toEqual([
      { type: "tool-call", call: { callId: "c1", name: "fs_read", args: { path: "a.txt" } } },
      { type: "tool-call", call: { callId: "c2", name: "fs_list", args: {} } },
      { type: "finish", reason: "tool-calls" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "fs_read", description: "read", parameters: { type: "object" } },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c0", type: "function", function: { name: "fs_list", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c0", content: "[]" },
    ]);
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("handles events split at awkward byte boundaries and CRLF line endings", async () => {
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1",
      fetch: async () =>
        sse([
          'data: {"choices":[{"delta":{"con',
          'tent":"A"}}]}\r\n\r',
          '\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
    });
    expect(await collect(llm)).toEqual([
      { type: "text-delta", text: "A" },
      { type: "text-delta", text: "B" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("turns an HTTP error into an error chunk with the server's message", async () => {
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1",
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "AuthError", message: "Missing API key." },
          }),
          { status: 401 },
        ),
    });
    expect(await collect(llm)).toEqual([
      { type: "error", message: "Model endpoint answered 401: Missing API key." },
      { type: "finish", reason: "error" },
    ]);
  });

  it("turns a network failure into an error chunk instead of throwing", async () => {
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await collect(llm)).toEqual([
      { type: "error", message: "Could not reach the model endpoint: fetch failed" },
      { type: "finish", reason: "error" },
    ]);
  });

  it("reports an error object inside the stream", async () => {
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1",
      fetch: async () =>
        sse([
          event({ choices: [{ delta: { content: "x" } }] }),
          event({ error: { message: "rate limited" } }),
        ]),
    });
    expect(await collect(llm)).toEqual([
      { type: "text-delta", text: "x" },
      { type: "error", message: "rate limited" },
      { type: "finish", reason: "error" },
    ]);
  });

  it("finishes with aborted when the caller aborts", async () => {
    const controller = new AbortController();
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1",
      fetch: async (_url, init) => {
        const signal = init?.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(event({ choices: [{ delta: { content: "par" } }] })),
            );
            signal.addEventListener("abort", () =>
              c.error(new DOMException("aborted", "AbortError")),
            );
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    const chunks: LlmChunk[] = [];
    for await (const c of llm.stream({ model: "m", messages: [], signal: controller.signal })) {
      chunks.push(c);
      if (c.type === "text-delta") controller.abort();
    }
    expect(chunks).toEqual([
      { type: "text-delta", text: "par" },
      { type: "finish", reason: "aborted" },
    ]);
  });
});
