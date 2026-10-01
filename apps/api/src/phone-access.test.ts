import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLlm } from "@bench_bot/providers";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, PHONE_COOKIE } from "./app.ts";
import { compose } from "./compose.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const MAC_LAN = "192.168.1.20";
const PHONE = "192.168.1.55";

async function setup(enabled = true, from = PHONE) {
  const dataDir = mkdtempSync(join(tmpdir(), "bench-phone-"));
  const phone = { enabled, password: "secret-pass", generated: false };
  const config = {
    repoRoot: dataDir,
    dataDir,
    botsDir: dataDir,
    llmBaseUrl: "x",
    apiKey: undefined,
    defaultModel: "m",
    host: "127.0.0.1",
    port: 0,
    phone,
  };
  const services = await compose(config, { llm: new ScriptedLlm([]) });
  cleanups.push(
    () => rmSync(dataDir, { recursive: true, force: true }),
    () => services.close(),
  );
  let caller = from;
  const app = createApp(services, { remoteAddress: () => caller, lanAddresses: () => [MAC_LAN] });
  const call = (path: string, init: RequestInit = {}, host = MAC_LAN) =>
    app.request(`http://${host}:8787${path}`, init);
  return { call, setCaller: (a: string) => (caller = a) };
}

const cookieFrom = (res: Response) =>
  /bench_phone=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[0];
const form = (password: string) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }).toString(),
});

describe("phone mode", () => {
  it("refuses other devices while phone mode is off", async () => {
    const { call } = await setup(false);
    expect((await call("/api/bots")).status).toBe(403);
  });

  it("refuses devices outside the home network and unknown host names", async () => {
    const { call, setCaller } = await setup();
    setCaller("8.8.8.8");
    expect((await call("/api/bots")).status).toBe(403);
    setCaller(PHONE);
    expect((await call("/api/bots", {}, "evil.example")).status).toBe(403);
  });

  it("asks a phone without login to log in", async () => {
    const { call } = await setup();
    expect((await call("/api/bots")).status).toBe(401);
    const page = await call("/");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/phone-login");
    expect(await (await call("/phone-login")).text()).toContain("phone password");
  });

  it("logs in with the right password and then serves the app", async () => {
    const { call } = await setup();
    expect((await call("/phone-login", form("wrong"))).status).toBe(401);
    const ok = await call("/phone-login", form("secret-pass"));
    expect(ok.status).toBe(302);
    const cookie = cookieFrom(ok);
    expect(cookie).toMatch(new RegExp(`^${PHONE_COOKIE}=`));
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(ok.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
    expect((await call("/api/bots", { headers: { cookie: cookie ?? "" } })).status).toBe(200);
    expect(
      (await call("/api/bots", { headers: { cookie: `${PHONE_COOKIE}=forged` } })).status,
    ).toBe(401);
  });

  it("logs in through the QR link (?key=…)", async () => {
    const { call } = await setup();
    const res = await call("/?key=secret-pass");
    expect(res.status).toBe(302);
    expect((await call("/api/bots", { headers: { cookie: cookieFrom(res) ?? "" } })).status).toBe(
      200,
    );
    expect((await call("/?key=old-pass")).status).toBe(401);
  });

  it("blocks password guessing after 10 wrong tries", async () => {
    const { call } = await setup();
    for (let i = 0; i < 10; i++) await call("/phone-login", form(`guess${i}`));
    expect((await call("/phone-login", form("secret-pass"))).status).toBe(429);
  });

  it("keeps the engine bridge and the phone settings Mac-only, even when logged in", async () => {
    const { call } = await setup();
    const cookie = cookieFrom(await call("/?key=secret-pass")) ?? "";
    expect((await call("/api/internal/tools", { headers: { cookie } })).status).toBe(403);
    expect((await call("/api/phone", { headers: { cookie } })).status).toBe(403);
  });

  it("gives the Mac the phone address, password and a QR code", async () => {
    const { call } = await setup(true, "127.0.0.1");
    const info = (await (await call("/api/phone", {}, "localhost")).json()) as Record<
      string,
      unknown
    >;
    expect(info).toMatchObject({
      enabled: true,
      password: "secret-pass",
      urls: [`http://${MAC_LAN}:8787/`],
    });
    expect(String(info.qrSvg)).toContain("<svg");
  });
});
