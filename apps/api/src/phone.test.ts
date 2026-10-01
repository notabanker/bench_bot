import { describe, expect, it } from "vitest";
import {
  isLoopback,
  isPrivateNetwork,
  LoginLimiter,
  PhoneSessions,
  phoneConfigFromEnv,
  sameSecret,
} from "./phone.ts";

describe("phone config", () => {
  it("is off by default and makes a random readable password", () => {
    const c = phoneConfigFromEnv({});
    expect(c.enabled).toBe(false);
    expect(c.generated).toBe(true);
    expect(c.password).toMatch(/^[a-km-np-z2-9]{12}$/);
  });

  it("uses the chosen password and refuses short ones", () => {
    expect(phoneConfigFromEnv({ BENCH_PHONE: "1", BENCH_PHONE_PASSWORD: "longenough" })).toEqual({
      enabled: true,
      password: "longenough",
      generated: false,
    });
    expect(() => phoneConfigFromEnv({ BENCH_PHONE_PASSWORD: "short" })).toThrow(/at least 8/);
  });
});

describe("addresses", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("%s is this computer", (a) =>
    expect(isLoopback(a)).toBe(true),
  );
  it.each(["192.168.1.5", "10.0.0.2", "172.20.1.1", "::ffff:192.168.0.9", "fe80::1", "fd12::3"])(
    "%s is a home network",
    (a) => expect(isPrivateNetwork(a)).toBe(true),
  );
  it.each(["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1", undefined])("%s is not", (a) =>
    expect(isPrivateNetwork(a)).toBe(false),
  );
});

describe("sessions and limits", () => {
  it("accepts only issued session tokens", () => {
    const s = new PhoneSessions();
    const t = s.create();
    expect(s.valid(t)).toBe(true);
    expect(s.valid("forged")).toBe(false);
    expect(s.valid(undefined)).toBe(false);
  });

  it("blocks an address after too many wrong passwords, then forgives after the window", () => {
    let t = 0;
    const l = new LoginLimiter(3, 1000, () => t);
    for (let i = 0; i < 3; i++) l.fail("a");
    expect(l.blocked("a")).toBe(true);
    expect(l.blocked("b")).toBe(false);
    t = 2000;
    expect(l.blocked("a")).toBe(false);
  });

  it("compares secrets correctly", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });
});
