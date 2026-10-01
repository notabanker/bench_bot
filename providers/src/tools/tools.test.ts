import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyService, ToolContext } from "@bench_bot/services";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFs } from "../fs/local-fs.ts";
import { fsTools } from "./fs-tools.ts";
import { ToolRegistry } from "./registry.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function ctx(): ToolContext {
  const ws = mkdtempSync(join(tmpdir(), "bench-tools-"));
  dirs.push(ws);
  return { botId: "b1", threadId: "t1", runId: "r1", workspacePath: ws, chain: ["b1"] };
}

describe("ToolRegistry", () => {
  it("refuses duplicate and invalid names", () => {
    const r = new ToolRegistry();
    const tool = {
      schema: { name: "a", description: "", parameters: {} },
      run: async () => ({ ok: true, output: "" }),
    };
    r.register(tool);
    expect(() => r.register(tool)).toThrow(/already registered/);
    expect(() => r.register({ ...tool, schema: { ...tool.schema, name: "fs.read" } })).toThrow(
      /must match/,
    );
  });

  it("never throws: unknown and crashing tools become ok:false", async () => {
    const r = new ToolRegistry();
    r.register({
      schema: { name: "boom", description: "", parameters: {} },
      run: async () => {
        throw new Error("kaput");
      },
    });
    expect(await r.run("missing", {}, ctx())).toEqual({
      ok: false,
      output: 'Unknown tool "missing"',
    });
    expect(await r.run("boom", {}, ctx())).toEqual({ ok: false, output: "kaput" });
  });

  it("returns schemas for the requested names only, skipping unknown ones", () => {
    const r = new ToolRegistry();
    for (const t of fsTools(new LocalFs())) r.register(t);
    expect(r.schemas(["fs_list", "nope", "fs_read"]).map((s) => s.name)).toEqual([
      "fs_list",
      "fs_read",
    ]);
    expect(r.schemas()).toHaveLength(3);
  });
});

describe("fs tools", () => {
  it("write, list and read through the registry", async () => {
    const r = new ToolRegistry();
    for (const t of fsTools(new LocalFs())) r.register(t);
    const c = ctx();
    expect(await r.run("fs_list", {}, c)).toEqual({ ok: true, output: "(empty)" });
    expect(await r.run("fs_write", { path: "a/b.txt", content: "hi" }, c)).toEqual({
      ok: true,
      output: "Wrote 2 characters to a/b.txt",
    });
    expect(await r.run("fs_list", { path: "a" }, c)).toEqual({
      ok: true,
      output: "b.txt (2 bytes)",
    });
    expect(await r.run("fs_read", { path: "a/b.txt" }, c)).toEqual({ ok: true, output: "hi" });
  });

  it("reports bad arguments and escapes as ok:false for the model to read", async () => {
    const r = new ToolRegistry();
    for (const t of fsTools(new LocalFs())) r.register(t);
    const c = ctx();
    expect((await r.run("fs_read", {}, c)).output).toMatch(/"path" must be a non-empty string/);
    expect((await r.run("fs_read", { path: "../x" }, c)).output).toMatch(
      /outside the bot's workspace/,
    );
  });

  it("turns a policy refusal into a blocked result", async () => {
    const policy: PolicyService = { check: () => ({ allow: false, reason: "no writing today" }) };
    const r = new ToolRegistry();
    for (const t of fsTools(new LocalFs(), policy)) r.register(t);
    expect(await r.run("fs_write", { path: "x.txt", content: "" }, ctx())).toEqual({
      ok: false,
      output: "Refused by the safety rules: no writing today",
      blocked: { action: "write x.txt", reason: "no writing today" },
    });
  });
});
