import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

/**
 * Phone mode: lets a phone on the same home network open the chat page. Off by default.
 * Every request from another device needs the password (or a session cookie from logging in).
 */
export interface PhoneConfig {
  enabled: boolean;
  password: string;
  /** True when no BENCH_PHONE_PASSWORD was set and a random one was made for this start. */
  generated: boolean;
}

/** Letters and digits that are hard to mix up when typed on a phone. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const MIN_PASSWORD_LENGTH = 8;

export function phoneConfigFromEnv(env: NodeJS.ProcessEnv): PhoneConfig {
  const enabled = ["1", "true", "yes", "on"].includes((env.BENCH_PHONE ?? "").toLowerCase());
  const chosen = env.BENCH_PHONE_PASSWORD?.trim();
  if (chosen && chosen.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`BENCH_PHONE_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (chosen) return { enabled, password: chosen, generated: false };
  const password = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return { enabled, password, generated: true };
}

/** Compares secrets in constant time (hashing first makes the lengths equal). */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Strips the IPv4-in-IPv6 prefix Node uses for IPv4 clients on dual-stack sockets. */
function plainAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = plainAddress(address);
  return a === "::1" || a.startsWith("127.");
}

/** Private home/office network ranges (never the open internet). */
export function isPrivateNetwork(address: string | undefined): boolean {
  if (!address) return false;
  const a = plainAddress(address).toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return (
      x === 10 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 169 && y === 254)
    );
  }
  return a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd");
}

/** This computer's addresses on private networks, e.g. ["192.168.1.20"]. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((i) =>
      i && !i.internal && i.family === "IPv4" && isPrivateNetwork(i.address) ? [i.address] : [],
    );
}

/** Logged-in phones (in memory: a server restart means logging in again). */
export class PhoneSessions {
  readonly #tokens = new Set<string>();

  create(): string {
    const token = randomBytes(32).toString("base64url");
    this.#tokens.add(token);
    return token;
  }

  valid(token: string | undefined): boolean {
    return !!token && [...this.#tokens].some((t) => sameSecret(t, token));
  }
}

/** Slows down password guessing: after 10 wrong tries an address waits 10 minutes. */
export class LoginLimiter {
  readonly #failures = new Map<string, { count: number; since: number }>();
  constructor(
    readonly maxFailures = 10,
    readonly windowMs = 10 * 60_000,
    readonly now: () => number = Date.now,
  ) {}

  blocked(address: string): boolean {
    const f = this.#failures.get(address);
    if (!f) return false;
    if (this.now() - f.since > this.windowMs) {
      this.#failures.delete(address);
      return false;
    }
    return f.count >= this.maxFailures;
  }

  fail(address: string): void {
    const f = this.#failures.get(address);
    if (!f || this.now() - f.since > this.windowMs)
      this.#failures.set(address, { count: 1, since: this.now() });
    else f.count++;
  }

  succeed(address: string): void {
    this.#failures.delete(address);
  }
}

export const LOGIN_PAGE = (message = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bench_bot — phone login</title>
<style>
  body{font:16px/1.4 -apple-system,system-ui,sans-serif;background:#f3f1ec;color:#1f2328;display:grid;place-items:center;min-height:100vh;margin:0}
  form{background:#fbfaf7;border:1px solid #e2ded6;border-radius:10px;padding:24px;width:min(340px,90vw)}
  h1{font-size:20px;margin:0 0 4px}p{color:#6b6f76;margin:0 0 16px;font-size:14px}
  input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #e2ded6;border-radius:6px;margin-bottom:12px}
  button{width:100%;font:inherit;font-weight:600;padding:10px;border:0;border-radius:6px;background:#2f6f5e;color:#fff}
  .err{color:#b42318}
  @media (prefers-color-scheme:dark){body{background:#16181b;color:#e7e5df}form{background:#1d2024;border-color:#2c3036}input{background:#16181b;color:inherit;border-color:#2c3036}}
</style></head><body>
<form method="post" action="/phone-login">
  <h1>bench_bot</h1><p>Enter the phone password shown on your Mac.</p>
  ${message ? `<p class="err">${message}</p>` : ""}
  <input name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Open</button>
</form></body></html>`;
