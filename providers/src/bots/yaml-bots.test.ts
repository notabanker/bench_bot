import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { YamlBotDirectory } from "./yaml-bots.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "bench-bots-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return new YamlBotDirectory({
    botsDir: dir,
    workspacesRoot: "/data/workspaces",
    defaultModel: "default-m",
  });
}

describe("YamlBotDirectory", () => {
  it("reads bot files with defaults for id, model, tools and workspace", async () => {
    const bots = setup({
      "finance.yaml":
        "name: Finance\ninstructions: |\n  Count money.\nharness: prime-agent\nmodel: opencode-go/deepseek-v4-pro\ntools: [ask_bot]\nsection: Research\n",
      "helper.yml": "name: Helper\ninstructions: Help.\nharness: generic-loop\n",
      "notes.txt": "ignored",
    });
    expect(await bots.list()).toEqual([
      {
        id: "finance",
        name: "Finance",
        description: "",
        instructions: "Count money.",
        model: "opencode-go/deepseek-v4-pro",
        harness: "prime-agent",
        tools: ["ask_bot"],
        workspacePath: "/data/workspaces/finance",
        section: "Research",
      },
      {
        id: "helper",
        name: "Helper",
        description: "",
        instructions: "Help.",
        model: "default-m",
        harness: "generic-loop",
        tools: [],
        workspacePath: "/data/workspaces/helper",
      },
    ]);
    expect(await bots.get("helper")).toMatchObject({ name: "Helper" });
    expect(bots.problems()).toEqual([]);
  });

  it("skips broken files and explains why", async () => {
    const bots = setup({
      "a.yaml": "name: A\ninstructions: x\n",
      "b.yaml": "name: B\ninstructions: x\nharness: generic-loop\ncolour: red\n",
      "c.yaml": "- just\n- a list\n",
      "d.yaml": "id: Bad Id\nname: D\ninstructions: x\nharness: h\n",
      "e.yaml": "name: E\ninstructions: x\nharness: h\ntools: fs_read\n",
      "f.yaml": "name: [unclosed\n",
      "g.yaml": "id: ok\nname: G\ninstructions: x\nharness: h\n",
      "h.yaml": "id: ok\nname: H\ninstructions: x\nharness: h\n",
    });
    expect((await bots.list()).map((b) => b.id)).toEqual(["ok"]);
    const problems = Object.fromEntries(bots.problems().map((p) => [p.file, p.message]));
    expect(problems["a.yaml"]).toBe('"harness" is missing');
    expect(problems["b.yaml"]).toBe("unknown field(s): colour");
    expect(problems["c.yaml"]).toBe("the file must contain key: value pairs");
    expect(problems["d.yaml"]).toMatch(/may only use/);
    expect(problems["e.yaml"]).toBe('"tools" must be a list of tool names');
    expect(problems["f.yaml"]).toBeTruthy();
    expect(problems["h.yaml"]).toBe('id "ok" is used by another bot file');
  });

  it("returns no bots when the folder does not exist", async () => {
    const bots = new YamlBotDirectory({
      botsDir: "/no/such/dir",
      workspacesRoot: "/w",
      defaultModel: "m",
    });
    expect(await bots.list()).toEqual([]);
  });

  it("picks up edits without a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-bots-"));
    dirs.push(dir);
    const file = join(dir, "x.yaml");
    writeFileSync(file, "name: X\ninstructions: x\nharness: generic-loop\nmodel: one\n");
    const bots = new YamlBotDirectory({ botsDir: dir, workspacesRoot: "/w", defaultModel: "m" });
    expect((await bots.get("x"))?.model).toBe("one");
    writeFileSync(file, "name: X\ninstructions: x\nharness: opencode\nmodel: two\n");
    expect(await bots.get("x")).toMatchObject({ model: "two", harness: "opencode" });
  });
});
