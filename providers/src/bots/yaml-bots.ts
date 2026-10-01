import { readdir, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import type { BotDefinition, BotDirectory } from "@bench_bot/services";
import { parse } from "yaml";

export interface BotFileProblem {
  file: string;
  message: string;
}

export interface YamlBotDirectoryOptions {
  /** Folder with one `<id>.yaml` per bot. */
  botsDir: string;
  /** Where bot workspaces live when a file names none (`<root>/<id>`). */
  workspacesRoot: string;
  /** Used when a bot file has no `model`. */
  defaultModel: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const KNOWN_KEYS = new Set([
  "id",
  "name",
  "description",
  "instructions",
  "model",
  "harness",
  "tools",
  "section",
  "workspace",
]);

/**
 * Bots defined as YAML files. Files are read on every call, so an edited file takes effect with
 * the next message, no restart needed. Broken files are skipped and reported by `problems()`.
 */
export class YamlBotDirectory implements BotDirectory {
  readonly #options: YamlBotDirectoryOptions;
  #problems: BotFileProblem[] = [];

  constructor(options: YamlBotDirectoryOptions) {
    this.#options = options;
  }

  async list(): Promise<BotDefinition[]> {
    const { bots, problems } = await this.load();
    this.#problems = problems;
    return bots;
  }

  async get(botId: string): Promise<BotDefinition | undefined> {
    return (await this.list()).find((b) => b.id === botId);
  }

  /** Problems found by the last `list()`. */
  problems(): BotFileProblem[] {
    return [...this.#problems];
  }

  async load(): Promise<{ bots: BotDefinition[]; problems: BotFileProblem[] }> {
    let names: string[];
    try {
      names = (await readdir(this.#options.botsDir)).filter((n) => /\.ya?ml$/.test(n)).sort();
    } catch {
      return { bots: [], problems: [] };
    }
    const bots: BotDefinition[] = [];
    const problems: BotFileProblem[] = [];
    for (const name of names) {
      try {
        const raw = parse(await readFile(join(this.#options.botsDir, name), "utf8"));
        const bot = this.#toBot(raw, basename(name, extname(name)));
        if (bots.some((b) => b.id === bot.id))
          throw new Error(`id "${bot.id}" is used by another bot file`);
        bots.push(bot);
      } catch (error) {
        problems.push({
          file: name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { bots, problems };
  }

  #toBot(raw: unknown, fileId: string): BotDefinition {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("the file must contain key: value pairs");
    const data = raw as Record<string, unknown>;
    const unknown = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k));
    if (unknown.length) throw new Error(`unknown field(s): ${unknown.join(", ")}`);

    const text = (key: string, required: boolean): string | undefined => {
      const value = data[key];
      if (value === undefined || value === null) {
        if (required) throw new Error(`"${key}" is missing`);
        return undefined;
      }
      if (typeof value !== "string" || !value.trim())
        throw new Error(`"${key}" must be non-empty text`);
      return value.trim();
    };

    const id = text("id", false) ?? fileId;
    if (!ID_PATTERN.test(id)) throw new Error(`id "${id}" may only use a-z, 0-9, "-" and "_"`);
    const tools = data.tools ?? [];
    if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) {
      throw new Error('"tools" must be a list of tool names');
    }
    const workspace = text("workspace", false);
    const section = text("section", false);

    return {
      id,
      name: text("name", true) as string,
      description: text("description", false) ?? "",
      instructions: text("instructions", true) as string,
      model: text("model", false) ?? this.#options.defaultModel,
      harness: text("harness", true) as string,
      tools: tools as string[],
      workspacePath: workspace
        ? isAbsolute(workspace)
          ? workspace
          : join(this.#options.workspacesRoot, workspace)
        : join(this.#options.workspacesRoot, id),
      ...(section ? { section } : {}),
    };
  }
}
