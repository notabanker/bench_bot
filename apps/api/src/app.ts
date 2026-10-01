import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type BotDefinition, Services, type StoredEntry } from "@bench_bot/services";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import QRCode from "qrcode";
import type { AppServices } from "./compose.ts";
import type { RunStatusChange } from "./hub.ts";
import {
  isLoopback,
  isPrivateNetwork,
  LOGIN_PAGE,
  LoginLimiter,
  lanAddresses,
  type PhoneConfig,
  PhoneSessions,
  sameSecret,
} from "./phone.ts";

export const PHONE_COOKIE = "bench_phone";

const MAX_MESSAGE_CHARS = 100_000;
const HEARTBEAT_MS = 15_000;

export interface AppOptions {
  /** Built web UI to serve at `/` (apps/web/dist). */
  webDist?: string;
  /** Overrides the config's phone mode (tests). */
  phone?: PhoneConfig;
  /** The caller's IP address; defaults to the socket's (tests pass their own). */
  remoteAddress?: (c: Context) => string | undefined;
  /** This computer's home-network addresses; defaults to the network interfaces (tests). */
  lanAddresses?: () => string[];
}

/** The local HTTP API. Reachable from this computer, and in phone mode from logged-in home devices. */
export function createApp(services: AppServices, options: AppOptions = {}): Hono {
  const { kernel, runner, runs, hub } = services;
  const session = kernel.get(Services.session);
  const bots = kernel.get(Services.bots);
  const harnesses = kernel.get(Services.harnesses);
  const tools = kernel.get(Services.tools);
  const app = new Hono();

  const phone = options.phone ?? services.config.phone;
  const ownAddresses = () => options.lanAddresses?.() ?? lanAddresses();
  const remoteOf = (c: Context): string | undefined => {
    if (options.remoteAddress) return options.remoteAddress(c);
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined; // Unknown caller: treated as another device and refused.
    }
  };
  const sessions = new PhoneSessions();
  const limiter = new LoginLimiter();
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

  const login = (c: Context) => {
    const token = sessions.create();
    setCookie(c, PHONE_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 30 * 24 * 3600,
    });
  };

  // Who may talk to this server:
  // - this computer, under a local host name (DNS-rebinding protection);
  // - in phone mode, devices on the home network that logged in with the phone password.
  app.use("*", async (c, next) => {
    // The Node server builds the request URL from the Host header.
    const host = new URL(c.req.url).hostname;
    const remote = remoteOf(c);
    if (isLoopback(remote)) {
      if (!LOCAL_HOSTS.has(host)) return c.json({ error: "Forbidden host" }, 403);
      return next();
    }
    if (!phone.enabled || !isPrivateNetwork(remote)) {
      return c.json({ error: "bench_bot only accepts connections from this computer" }, 403);
    }
    if (!ownAddresses().includes(host)) return c.json({ error: "Forbidden host" }, 403);
    if (c.req.path.startsWith("/api/internal/") || c.req.path === "/api/phone") {
      return c.json({ error: "Only available on this computer" }, 403);
    }

    const address = remote ?? "?";
    if (c.req.path === "/phone-login") {
      if (c.req.method !== "POST") return c.html(LOGIN_PAGE());
      if (limiter.blocked(address))
        return c.html(LOGIN_PAGE("Too many tries. Wait 10 minutes."), 429);
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const password = typeof form.password === "string" ? form.password.trim() : "";
      if (!sameSecret(password, phone.password)) {
        limiter.fail(address);
        return c.html(LOGIN_PAGE("Wrong password."), 401);
      }
      limiter.succeed(address);
      login(c);
      return c.redirect("/");
    }
    // The QR code on the Mac carries the password as ?key=… so scanning logs in directly.
    const key = c.req.query("key");
    if (key !== undefined && c.req.method === "GET" && !c.req.path.startsWith("/api/")) {
      if (limiter.blocked(address))
        return c.html(LOGIN_PAGE("Too many tries. Wait 10 minutes."), 429);
      if (!sameSecret(key, phone.password)) {
        limiter.fail(address);
        return c.html(LOGIN_PAGE("That link has an old password. Enter the current one."), 401);
      }
      limiter.succeed(address);
      login(c);
      return c.redirect("/");
    }
    if (sessions.valid(getCookie(c, PHONE_COOKIE))) return next();
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Log in first" }, 401);
    return c.redirect("/phone-login");
  });

  /** For the Mac only: what the phone needs (address, password, QR code). */
  app.get("/api/phone", async (c) => {
    if (!phone.enabled) return c.json({ enabled: false });
    const port = new URL(c.req.url).port || "80";
    const urls = ownAddresses().map((a) => `http://${a}:${port}/`);
    const first = urls[0];
    return c.json({
      enabled: true,
      password: phone.password,
      urls,
      qrSvg: first
        ? await QRCode.toString(`${first}?key=${encodeURIComponent(phone.password)}`, {
            type: "svg",
            margin: 1,
          })
        : null,
    });
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

  app.get("/api/bot-problems", async (c) => {
    await bots.list(); // Refreshes the problem list.
    return c.json(services.botProblems());
  });

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
    // EventSource reconnects send the last seen id; honour it like afterSeq.
    const afterSeq = Math.max(
      Number(c.req.query("afterSeq") ?? 0) || 0,
      Number(c.req.header("last-event-id") ?? 0) || 0,
    );

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

  // Tool bridge for engines like OpenCode (apps/api/bin/mcp-bridge.mjs); needs a run token.
  app.get("/api/internal/tools", (c) => {
    const grant = services.runTokens.get(c.req.header("x-bench-token"));
    if (!grant) return c.json({ error: "Invalid or expired token" }, 401);
    return c.json(tools.schemas(grant.tools));
  });

  app.post("/api/internal/tools/:name", async (c) => {
    const grant = services.runTokens.get(c.req.header("x-bench-token"));
    if (!grant) return c.json({ error: "Invalid or expired token" }, 401);
    const name = c.req.param("name");
    if (!grant.tools.includes(name))
      return c.json({ ok: false, output: `Tool "${name}" is not available to this bot` });
    const args = await c.req.json().catch(() => ({}));
    return c.json(await tools.run(name, args, grant.ctx));
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (options.webDist && existsSync(options.webDist)) {
    // serveStatic resolves `root` against the working directory.
    const root = relative(process.cwd(), options.webDist) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  return app;
}
