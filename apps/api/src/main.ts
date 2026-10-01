/** Starts the bench_bot server: `pnpm dev:api` (or by the desktop app). */
import { join } from "node:path";
import { serve } from "@hono/node-server";
import QRCode from "qrcode";
import { createApp } from "./app.ts";
import { compose } from "./compose.ts";
import { loadConfig } from "./config.ts";
import { lanAddresses } from "./phone.ts";

const config = loadConfig();
const services = await compose(config);
const app = createApp(services, { webDist: join(config.repoRoot, "apps", "web", "dist") });

// Phone mode listens on the home network too, on a fixed port so the phone link stays the same.
const hostname = config.phone.enabled ? "0.0.0.0" : config.host;
const port = config.phone.enabled && config.port === 0 ? 8787 : config.port;

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  const url = `http://${config.host}:${info.port}`;
  services.setApiUrl(url);
  console.log(`bench_bot server on ${url}`);
  console.log(`data: ${config.dataDir}`);
  if (services.offline)
    console.log("no OPENCODE_API_KEY: bots on our own loop answer in offline echo mode");
  if (config.phone.enabled) void printPhoneHelp(info.port);
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

async function printPhoneHelp(port: number) {
  const urls = lanAddresses().map((a) => `http://${a}:${port}/`);
  if (urls.length === 0) {
    console.log("phone mode: no home network found (connect this computer to Wi-Fi)");
    return;
  }
  const { password, generated } = config.phone;
  console.log(`\nphone mode ON: on a phone in the same Wi-Fi, open ${urls.join(" or ")}`);
  console.log(
    `phone password: ${password}${generated ? " (new at every start; set BENCH_PHONE_PASSWORD to keep one)" : ""}`,
  );
  console.log("or scan this code (logs in directly):");
  console.log(
    await QRCode.toString(`${urls[0]}?key=${encodeURIComponent(password)}`, {
      type: "terminal",
      small: true,
    }),
  );
}
