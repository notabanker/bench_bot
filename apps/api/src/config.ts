import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OPENCODE_GO_BASE_URL } from "@bench_bot/providers";
import { type PhoneConfig, phoneConfigFromEnv } from "./phone.ts";

/** Model our own loop uses when a bot names none. OpenCode Go, on /chat/completions. (default — adjust) */
export const DEFAULT_MODEL = "glm-5.3-flash";

export interface AppConfig {
  repoRoot: string;
  /** Where the database and bot workspaces live. */
  dataDir: string;
  /** Folder with the bot yaml files. */
  botsDir: string;
  llmBaseUrl: string;
  apiKey: string | undefined;
  defaultModel: string;
  host: string;
  port: number;
  /** Phone mode (BENCH_PHONE=1): other devices on the home network may connect with a password. */
  phone: PhoneConfig;
}

/** Walks up from this file to the folder holding pnpm-workspace.yaml. */
export function findRepoRoot(start = import.meta.dirname): string {
  let dir = resolve(start);
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("Could not find the bench_bot folder (pnpm-workspace.yaml)");
    dir = parent;
  }
  return dir;
}

/** Default data folder: the usual place on macOS, a dot-folder elsewhere. */
export function defaultDataDir(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "bench_bot")
    : join(homedir(), ".bench_bot");
}

/**
 * Reads settings from the environment, after loading `<repo>/.env` if it exists. Variables
 * already set in the environment win over `.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = findRepoRoot();
  const envFile = join(repoRoot, ".env");
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  return {
    repoRoot,
    dataDir: env.BENCH_DATA_DIR || defaultDataDir(),
    botsDir: env.BENCH_BOTS_DIR || join(repoRoot, "bots"),
    llmBaseUrl: env.LLM_BASE_URL || OPENCODE_GO_BASE_URL,
    apiKey: env.OPENCODE_API_KEY || undefined,
    defaultModel: env.BENCH_DEFAULT_MODEL || DEFAULT_MODEL,
    host: "127.0.0.1",
    port: Number(env.BENCH_PORT || 8787),
    phone: phoneConfigFromEnv(env),
  };
}

/** True when there is nothing to talk to: the default cloud endpoint but no key. */
export function isOffline(config: AppConfig): boolean {
  return !config.apiKey && config.llmBaseUrl === OPENCODE_GO_BASE_URL;
}
