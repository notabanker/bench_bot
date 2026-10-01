// bench_bot desktop shell: starts the local server with Electron's own Node, waits until it is
// ready, opens the chat window, and stops the server when the app quits. All logic stays in the
// server; this file only manages one child process and one window.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serverEntry = join(repoRoot, "apps", "api", "src", "main.ts");
const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

/** @type {import("node:child_process").ChildProcess | null} */
let server = null;
let serverUrl = null;
let quitting = false;

function startServer() {
  const tsxCli = require.resolve("tsx/cli", { paths: [join(repoRoot, "apps", "api")] });
  return new Promise((resolve, reject) => {
    server = spawn(
      process.execPath,
      [tsxCli, "--disable-warning=ExperimentalWarning", serverEntry],
      {
        cwd: repoRoot,
        // Run Electron's binary as plain Node (Node 24 inside Electron 44 has node:sqlite).
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          BENCH_PORT: process.env.BENCH_PORT ?? "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(
      () => reject(new Error("The server did not start within 30 seconds.")),
      STARTUP_TIMEOUT_MS,
    );
    let buffer = "";
    server.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      buffer += chunk.toString();
      const match = /BENCH_READY (\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    server.on("exit", (code, signal) => {
      clearTimeout(timer);
      server = null;
      if (!quitting) {
        reject(new Error(`The server stopped (${signal ?? `exit code ${code}`}).`));
        if (serverUrl) {
          dialog.showErrorBox(
            "bench_bot",
            "The bench_bot server stopped unexpectedly. The app will close.",
          );
          app.quit();
        }
      }
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const child = server;
    const force = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "bench_bot",
    backgroundColor: "#f3f1ec",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const origin = new URL(url).origin;
  // Stay on the local app; anything else opens in the user's browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (/^https?:/.test(target)) void shell.openExternal(target);
    }
  });
  void win.loadURL(url);
  return win;
}

app.whenReady().then(async () => {
  try {
    serverUrl = await startServer();
  } catch (error) {
    dialog.showErrorBox("bench_bot could not start", String(error?.message ?? error));
    app.exit(1);
    return;
  }
  const win = createWindow(serverUrl);
  // Self-test: BENCH_DESKTOP_SMOKE=<file.png> saves a picture of the window and quits.
  const smokeFile = process.env.BENCH_DESKTOP_SMOKE;
  if (smokeFile) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(smokeFile, (await win.webContents.capturePage()).toPNG());
        app.quit();
      }, 1500);
    });
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverUrl) createWindow(serverUrl);
  });
});

app.on("window-all-closed", () => {
  // macOS apps usually stay open without windows; the server keeps running until Quit.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void stopServer().then(() => app.quit());
});
