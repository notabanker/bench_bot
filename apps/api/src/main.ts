/** Starts the bench_bot server: `pnpm dev:api` (or by the desktop app). */
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { compose } from "./compose.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const services = await compose(config);
const app = createApp(services, { webDist: join(config.repoRoot, "apps", "web", "dist") });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const url = `http://${config.host}:${info.port}`;
  console.log(`bench_bot server on ${url}`);
  console.log(`data: ${config.dataDir}`);
  if (services.offline)
    console.log("no OPENCODE_API_KEY: bots on our own loop answer in offline echo mode");
  // Machine-readable line for the desktop shell.
  console.log(`BENCH_READY ${url}`);
});

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal}: stopping bots and closing the database…`);
  server.close();
  await services.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
