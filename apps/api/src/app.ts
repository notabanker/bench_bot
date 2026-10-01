import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type BotDefinition, Services, type StoredEntry } from "@bench_bot/services";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppServices } from "./compose.ts";
import type { RunStatusChange } from "./hub.ts";

const MAX_MESSAGE_CHARS = 100_000;
const HEARTBEAT_MS = 15_000;

export interface AppOptions {
  /** Built web UI to serve at `/` (apps/web/dist). */
  webDist?: string;
}

/** The local HTTP API. Only reachable from this computer (see the Host check). */
export function createApp(services: AppServices, options: AppOptions = {}): Hono {
  const { kernel, runner, runs, hub } = services;
  const session = kernel.get(Services.session);
  const bots = kernel.get(Services.bots);
  const harnesses = kernel.get(Services.harnesses);
  const app = new Hono();

  // Refuse requests that name another host: stops web pages elsewhere from reaching this API
  // through DNS tricks. The server only listens on 127.0.0.1 anyway.
  app.use("*", async (c, next) => {
    // The Node server builds the request URL from the Host header.
    const host = new URL(c.req.url).hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      return c.json({ error: "Forbidden host" }, 403);
    }
    await next();
  });

  app.onError((error, c) => {
    console.error("bench_bot api error:", error);
    return c.json({ error: error.message }, 500);
  });

  const botView = (bot: BotDefinition) => {
    let capabilities = null;
    try {
      capabilities = harnesses.get(bot.harness).capabilities();
    } catch {}
    return {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      model: bot.model,
      harness: bot.harness,
      harnessAvailable: capabilities !== null,
      capabilities,
      tools: bot.tools,
      section: bot.section ?? null,
      status: {
        running: runner.isRunning(bot.id),
        queued: runner.pending(bot.id),
        paused: runner.isPaused(bot.id),
      },
    };
  };

  app.get("/api/health", (c) =>
    c.json({ ok: true, offline: services.offline, model: services.config.defaultModel }),
  );

  app.get("/api/harnesses", (c) =>
    c.json(harnesses.ids().map((id) => ({ id, capabilities: harnesses.get(id).capabilities() }))),
  );

  app.get("/api/bots", async (c) => c.json((await bots.list()).map(botView)));

  app.get("/api/bots/:botId", async (c) => {
    const bot = await bots.get(c.req.param("botId"));
    return bot ? c.json(botView(bot)) : c.json({ error: "Unknown bot" }, 404);
  });

  app.get("/api/bots/:botId/threads", async (c) => {
    const botId = c.req.param("botId");
    if (!(await bots.get(botId))) return c.json({ error: "Unknown bot" }, 404);
    return c.json(await session.listThreads(botId));
  });

  app.post("/api/bots/:botId/threads", async (c) => {
    const botId = c.req.param("botId");
    if (!(await bots.get(botId))) return c.json({ error: "Unknown bot" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 200)
        : undefined;
    return c.json(await session.createThread(botId, title), 201);
  });

  app.post("/api/bots/:botId/pause", async (c) => {
    runner.pause(c.req.param("botId"));
    return c.json({ paused: true });
  });

  app.post("/api/bots/:botId/resume", async (c) => {
    runner.resume(c.req.param("botId"));
    return c.json({ paused: false });
  });

  app.get("/api/threads/:threadId", async (c) => {
    const thread = await session.getThread(c.req.param("threadId"));
    if (!thread) return c.json({ error: "Unknown thread" }, 404);
    return c.json({
      thread,
      entries: await session.read(thread.id),
      runs: runs.listForThread(thread.id),
    });
  });

  app.post("/api/threads/:threadId/messages", async (c) => {
    const thread = await session.getThread(c.req.param("threadId"));
    if (!thread) return c.json({ error: "Unknown thread" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text must be a non-empty string" }, 400);
    if (text.length > MAX_MESSAGE_CHARS)
      return c.json({ error: `text is longer than ${MAX_MESSAGE_CHARS} characters` }, 400);

    const entry = await session.append(thread.id, {
      kind: "message",
      from: { kind: "user" },
      text,
    });
    const deliveryId = `dlv_${randomUUID()}`;
    const position = runner.enqueue({
      id: deliveryId,
      botId: thread.botId,
      threadId: thread.id,
      from: { kind: "user" },
      text,
      seq: entry.seq,
      chain: [thread.botId],
    });
    return c.json({ entry, deliveryId, position }, 202);
  });

  app.post("/api/threads/:threadId/abort", async (c) => {
    const thread = await session.getThread(c.req.param("threadId"));
    if (!thread) return c.json({ error: "Unknown thread" }, 404);
    await runner.abortThread(thread.id);
    return c.json({ aborted: true });
  });

  /** Live thread: everything after `afterSeq`, then new entries and run changes as they happen. */
  app.get("/api/threads/:threadId/events", async (c) => {
    const thread = await session.getThread(c.req.param("threadId"));
    if (!thread) return c.json({ error: "Unknown thread" }, 404);
    const afterSeq = Number(c.req.query("afterSeq") ?? 0) || 0;

    return streamSSE(c, async (stream) => {
      let lastSeq = afterSeq;
      const pending: StoredEntry[] = [];
      let live = false;
      const send = async (entry: StoredEntry) => {
        if (entry.seq <= lastSeq) return;
        lastSeq = entry.seq;
        await stream.writeSSE({
          event: "entry",
          id: String(entry.seq),
          data: JSON.stringify(entry),
        });
      };
      // Subscribe before reading the backlog so nothing slips through the gap; dedupe by seq.
      const offEntry = hub.onEntry((entry) => {
        if (entry.threadId !== thread.id) return;
        if (live) void send(entry);
        else pending.push(entry);
      });
      const offRun = hub.onRun((change: RunStatusChange) => {
        if (change.threadId === thread.id)
          void stream.writeSSE({ event: "run", data: JSON.stringify(change) });
      });
      stream.onAbort(() => {
        offEntry();
        offRun();
      });

      for (const entry of await session.read(thread.id, { afterSeq })) await send(entry);
      for (const entry of pending.splice(0)) await send(entry);
      live = true;
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ lastSeq }) });

      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
      offEntry();
      offRun();
    });
  });

  /** Roster-wide live updates: which bots are working. */
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const off = hub.onRun(
        (change) => void stream.writeSSE({ event: "run", data: JSON.stringify(change) }),
      );
      stream.onAbort(off);
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
      off();
    }),
  );

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (options.webDist && existsSync(options.webDist)) {
    // serveStatic resolves `root` against the working directory.
    const root = relative(process.cwd(), options.webDist) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  return app;
}
