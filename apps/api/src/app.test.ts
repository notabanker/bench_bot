import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reply, ScriptedLlm } from "@bench_bot/providers";
import type { StoredEntry } from "@bench_bot/services";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { compose } from "./compose.ts";
import type { AppConfig } from "./config.ts";

// biome-ignore lint/suspicious/noExplicitAny: test helper for loosely typed JSON responses
type Json = any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(llm = new ScriptedLlm([reply("Hello from the bot")])) {
  const dataDir = mkdtempSync(join(tmpdir(), "bench-api-"));
  const config: AppConfig = {
    repoRoot: dataDir,
    dataDir,
    botsDir: join(dataDir, "bots"),
    llmBaseUrl: "http://unused.test",
    apiKey: undefined,
    defaultModel: "m",
    host: "127.0.0.1",
    port: 0,
  };
  const services = await compose(config, { llm });
  cleanups.push(
    () => rmSync(dataDir, { recursive: true, force: true }),
    () => services.close(),
  );
  const app = createApp(services);
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    });
  const json = async (path: string, init?: RequestInit) =>
    (await call(path, init)).json() as Promise<Json>;
  return { services, call, json };
}

/** Reads SSE events from a response until `until` returns true. */
async function readSse(
  res: Response,
  until: (events: Array<{ event: string; data: string }>) => boolean,
) {
  if (!res.body) throw new Error("response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: string }> = [];
  let buffer = "";
  while (!until(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i = buffer.indexOf("\n\n");
    while (i !== -1) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      events.push({ event, data });
      i = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return events;
}

describe("API", () => {
  it("lists bots with their engine capabilities and status", async () => {
    const { json } = await setup();
    const bots = await json("/api/bots");
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
      id: "assistant",
      harness: "generic-loop",
      harnessAvailable: true,
      capabilities: { tools: true },
      status: { running: false, queued: 0, paused: false },
    });
    expect((await json("/api/health")).ok).toBe(true);
  });

  it("creates a thread, takes a message, runs the bot and stores the answer", async () => {
    const { services, call, json } = await setup();
    const created = await call("/api/bots/assistant/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Plans" }),
    });
    expect(created.status).toBe(201);
    const thread = (await created.json()) as Json;
    expect(await json("/api/bots/assistant/threads")).toEqual([thread]);

    const sent = await call(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(sent.status).toBe(202);
    const { deliveryId, position } = (await sent.json()) as Json;
    expect(position).toBe(0);
    await services.runner.whenDone(deliveryId);

    const detail = await json(`/api/threads/${thread.id}`);
    expect(detail.thread.title).toBe("Plans");
    const text = detail.entries
      .flatMap((e: StoredEntry) =>
        e.kind === "event" && e.event.type === "text-delta" ? [e.event.text] : [],
      )
      .join("");
    expect(text).toBe("Hello from the bot");
    expect(detail.runs.map((r: { status: string }) => r.status)).toEqual(["done"]);
  });

  it("streams the backlog and new entries over SSE", async () => {
    const { call, json } = await setup();
    const thread = await json("/api/bots/assistant/threads", { method: "POST", body: "{}" });
    const stream = await call(`/api/threads/${thread.id}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const reading = readSse(stream, (evs) =>
      evs.some((e) => e.event === "entry" && JSON.parse(e.data).event?.type === "finish"),
    );
    await new Promise((r) => setTimeout(r, 20));
    await call(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    const events = await reading;

    expect(events[0]?.event).toBe("ready");
    const kinds = events
      .filter((e) => e.event === "entry")
      .map((e) => {
        const entry = JSON.parse(e.data);
        return entry.kind === "message" ? "message" : entry.event.type;
      });
    expect(kinds[0]).toBe("message");
    expect(kinds.at(-1)).toBe("finish");
    expect(events.some((e) => e.event === "run" && JSON.parse(e.data).status === "running")).toBe(
      true,
    );
  });

  it("returns only entries after afterSeq when reconnecting", async () => {
    const { services, call, json } = await setup();
    const thread = await json("/api/bots/assistant/threads", { method: "POST", body: "{}" });
    const { deliveryId } = await json(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    await services.runner.whenDone(deliveryId);
    const events = await readSse(await call(`/api/threads/${thread.id}/events?afterSeq=2`), (evs) =>
      evs.some((e) => e.event === "ready"),
    );
    const seqs = events.filter((e) => e.event === "entry").map((e) => JSON.parse(e.data).seq);
    expect(seqs[0]).toBe(3);
  });

  it("validates input and unknown ids", async () => {
    const { call, json } = await setup();
    const thread = await json("/api/bots/assistant/threads", { method: "POST", body: "{}" });
    expect(
      (
        await call(`/api/threads/${thread.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ text: "  " }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/api/threads/thr_nope/messages", {
          method: "POST",
          body: JSON.stringify({ text: "x" }),
        })
      ).status,
    ).toBe(404);
    expect((await call("/api/bots/nope/threads")).status).toBe(404);
    expect((await call("/api/nothing")).status).toBe(404);
  });

  it("refuses requests for other host names", async () => {
    const { services } = await setup();
    const res = await createApp(services).request("http://evil.example/api/health");
    expect(res.status).toBe(403);
  });

  it("aborts a running thread", async () => {
    const slow = new ScriptedLlm([reply("a b c d e f g h i j k l m n o p")]);
    const { services, json } = await setup(slow);
    const thread = await json("/api/bots/assistant/threads", { method: "POST", body: "{}" });
    const { deliveryId } = await json(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "go" }),
    });
    await json(`/api/threads/${thread.id}/abort`, { method: "POST" });
    expect((await services.runner.whenDone(deliveryId)).reason).toBe("aborted");
  });

  it("closes runs cut off by a crash when the app starts again", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bench-api-crash-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = {
      repoRoot: dataDir,
      dataDir,
      botsDir: dataDir,
      llmBaseUrl: "x",
      apiKey: undefined,
      defaultModel: "m",
      host: "127.0.0.1",
      port: 0,
    };
    const first = await compose(config, { llm: new ScriptedLlm([]) });
    const session = (await import("@bench_bot/services")).Services.session;
    const thread = await first.kernel.get(session).createThread("assistant");
    first.runs.start({
      id: "run_cut",
      threadId: thread.id,
      botId: "assistant",
      harness: "generic-loop",
      model: "m",
    });
    first.db.close(); // Simulates a crash: the run never finished.

    const second = await compose(config, { llm: new ScriptedLlm([]) });
    cleanups.push(() => second.close());
    expect(second.runs.get("run_cut")?.status).toBe("interrupted");
    const entries = await second.kernel.get(session).read(thread.id);
    expect(entries.at(-1)).toMatchObject({
      kind: "event",
      runId: "run_cut",
      event: { type: "finish", reason: "aborted" },
    });
  });
});

describe("API with bot files", () => {
  it("serves bots from YAML files and reports broken files", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dataDir = mkdtempSync(join(tmpdir(), "bench-api-yaml-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const botsDir = join(dataDir, "bots");
    mkdirSync(botsDir);
    writeFileSync(
      join(botsDir, "helper.yaml"),
      "name: Helper\ninstructions: Help.\nharness: generic-loop\n",
    );
    writeFileSync(join(botsDir, "broken.yaml"), "name: Broken\n");
    const config = {
      repoRoot: dataDir,
      dataDir,
      botsDir,
      llmBaseUrl: "x",
      apiKey: undefined,
      defaultModel: "m",
      host: "127.0.0.1",
      port: 0,
    };
    const services = await compose(config, { llm: new ScriptedLlm([]) });
    cleanups.push(() => services.close());
    const app = createApp(services);

    const bots = (await (await app.request("http://localhost/api/bots")).json()) as Json;
    expect(bots.map((b: { id: string }) => b.id)).toEqual(["helper"]);
    expect(bots[0].workspacePath).toBeUndefined();
    const problems = (await (
      await app.request("http://localhost/api/bot-problems")
    ).json()) as Json;
    expect(problems).toEqual([{ file: "broken.yaml", message: '"instructions" is missing' }]);
  });
});
