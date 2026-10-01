import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  type Migration,
  openDatabase,
  SchemaTooNewError,
  schemaVersion,
} from "./database.ts";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "bench-db-"));
  dirs.push(dir);
  return join(dir, "nested", "bench.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("creates a new database at the latest schema version, including missing folders", () => {
    const db = openDatabase(tempDbPath());
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    db.close();
  });

  it("applies only the new steps when an older database is opened", () => {
    const path = tempDbPath();
    openDatabase(path, MIGRATIONS).close();
    const extra: Migration = {
      version: MIGRATIONS.length + 1,
      description: "test step",
      sql: "CREATE TABLE extra (id TEXT)",
    };
    const db = openDatabase(path, [...MIGRATIONS, extra]);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length + 1);
    db.close();
  });

  it("refuses a database made by a newer app", () => {
    const path = tempDbPath();
    const future: Migration = { version: 2, description: "future", sql: "SELECT 1" };
    openDatabase(path, [...MIGRATIONS.slice(0, 1), future]).close();
    expect(() => openDatabase(path, MIGRATIONS.slice(0, 1))).toThrow(SchemaTooNewError);
  });

  it("rolls back a failing step and leaves the version unchanged", () => {
    const path = tempDbPath();
    const broken: Migration = {
      version: MIGRATIONS.length + 1,
      description: "broken",
      sql: "CREATE TABLE ok_part (id TEXT); THIS IS NOT SQL;",
    };
    expect(() => openDatabase(path, [...MIGRATIONS, broken])).toThrow();
    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_part'").get(),
    ).toBeUndefined();
    db.close();
  });

  it("rejects migrations with gaps", () => {
    const gap: Migration = { version: 3, description: "gap", sql: "SELECT 1" };
    expect(() => openDatabase(":memory:", [...MIGRATIONS, gap])).toThrow(/missing or out of order/);
  });

  it("blocks changing or deleting log entries at the database level", () => {
    const db = openDatabase(":memory:");
    db.exec("INSERT INTO threads VALUES ('t1', 'b1', 'x', '2026-01-01T00:00:00Z')");
    db.exec("INSERT INTO entries VALUES ('t1', 1, '2026-01-01T00:00:00Z', 'message', NULL, '{}')");
    expect(() => db.exec("UPDATE entries SET payload = '{\"x\":1}'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM entries")).toThrow(/append-only/);
    db.close();
  });

  it("requires a run id on bot events and forbids one on messages", () => {
    const db = openDatabase(":memory:");
    db.exec("INSERT INTO threads VALUES ('t1', 'b1', 'x', '2026-01-01T00:00:00Z')");
    expect(() =>
      db.exec("INSERT INTO entries VALUES ('t1', 1, '2026-01-01T00:00:00Z', 'event', NULL, '{}')"),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        "INSERT INTO entries VALUES ('t1', 1, '2026-01-01T00:00:00Z', 'message', 'r1', '{}')",
      ),
    ).toThrow(/CHECK/);
    db.close();
  });
});
