import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFs, MAX_READ_BYTES, OutsideWorkspaceError } from "./local-fs.ts";

const dirs: string[] = [];
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "bench-fs-"));
  dirs.push(base);
  const ws = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "nope");
  return { ws, outside };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("LocalFs", () => {
  const fs = new LocalFs();

  it("writes (creating folders), reads and lists inside the workspace", async () => {
    const { ws } = sandbox();
    expect(await fs.list(ws)).toEqual([]);
    await fs.write(ws, "notes/today.md", "hello");
    expect(await fs.read(ws, "notes/today.md")).toBe("hello");
    expect(await fs.list(ws)).toEqual([{ name: "notes", kind: "dir" }]);
    expect(await fs.list(ws, "notes")).toEqual([{ name: "today.md", kind: "file", size: 5 }]);
  });

  it.each([["../outside/secret.txt"], ["notes/../../outside/secret.txt"], ["/etc/passwd"]])(
    "refuses the escape %s",
    async (path) => {
      const { ws } = sandbox();
      await expect(fs.read(ws, path)).rejects.toThrow(OutsideWorkspaceError);
      await expect(fs.write(ws, path, "x")).rejects.toThrow(OutsideWorkspaceError);
    },
  );

  it("refuses symlinks that point outside, also for files that do not exist yet", async () => {
    const { ws, outside } = sandbox();
    mkdirSync(ws, { recursive: true });
    symlinkSync(outside, join(ws, "link"));
    await expect(fs.read(ws, "link/secret.txt")).rejects.toThrow(OutsideWorkspaceError);
    await expect(fs.write(ws, "link/new.txt", "x")).rejects.toThrow(OutsideWorkspaceError);
  });

  it("refuses files larger than the read limit", async () => {
    const { ws } = sandbox();
    await fs.write(ws, "big.txt", "x".repeat(MAX_READ_BYTES + 1));
    await expect(fs.read(ws, "big.txt")).rejects.toThrow(/limit/);
  });
});
