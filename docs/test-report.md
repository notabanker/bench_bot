# Test report — 2026-10-02

Everything below was run in the Linux cloud machine where bench_bot is built, with the **real**
OpenCode 1.18.34, the **real** Prime Agent 0.9.8, a real Chromium browser and the real Electron
44.5.1 app (on a virtual screen). No OpenCode Go key was available, so AI answers came from
OpenCode's free model or from the offline echo.

## Results

| Area | Result |
|---|---|
| A. Fresh install, lint, type check, build | ✅ |
| A. Automatic tests | ✅ 202 / 202 |
| B. `pnpm ask` (offline, wrong key against the real OpenCode Go server, no question) | ✅ |
| C. Server end to end (chats, live stream, reconnect, pause/resume, stop, bad input, foreign host, bridge token, phone off) | ✅ 27 / 27 |
| E. Bot files edited while running (model change, broken file warning, new bot) | ✅ (in C) |
| F. Real OpenCode (answer, model warning, usage, `sudo` blocked, write to `/etc` blocked, write in own folder, Orchestrator → `list_bots`/`ask_bot` → Finance, Stop) | ✅ 9 / 9 |
| D. Hard crash mid-run → restart (chats kept, run "interrupted", chat not stuck) | ✅ |
| G. Real Prime Agent (start, model warning, Stop, no leftover processes) | ✅ 8 / 8 (with D) |
| H. Chat window in the browser (bots, groups, send, new chat, switch chats, computer panel remembered, tool chip, "Blocked" note, Stop, broken-file warning, server restart while open, no page errors) | ✅ 16 / 16 |
| I. Phone layout at Android size (bot list → chat → back, Enter = new line, Send, +, chat picker, no sideways scroll) + Mac phone panel + login page | ✅ 13 / 13 |
| J. Electron desktop app opens and quits, server stops with it | ✅ |

## Bugs found by these tests — all fixed

1. **OpenCode ran `sudo whoami` without asking** (its default), so the safety rules never saw it.
   Fix: bench_bot starts OpenCode with "ask before commands and edits"; the safety rules answer
   automatically. Re-tested: `sudo` and a write to `/etc` are refused with a "Blocked" note.
2. **Prime Agent left one worker + Python helper per run** (a Prime Agent 0.9.8 bug: they survive
   `session/close`). Fix: engines are ended gracefully in the background, and bench_bot stops the
   leftover sessions in the bot's own folder after each run and at start-up (crash leftovers).
   Re-tested: 0 leftovers, also after a hard crash; a Prime Agent session in another folder is
   left alone.
3. **Stopping a message that was still waiting in line left the chat on "working…" forever.**
   Fix: the chat gets a "Stopped before it started" note; "working" only shows while the bot is
   really busy.

## Not tested (cannot be tested in the cloud)

- **macOS**: the app, the macOS sandbox (`sandbox-exec`) and the install scripts on a Mac.
- **An OpenCode Go key**: real answers from our own loop, `kimi-k3`, `deepseek-v4-pro`, Grok models.
- **A real phone on a real home Wi-Fi** (the cloud machine has no home network). The phone-mode
  rules (password, home networks only, QR login, guess limit) are covered by automatic tests with
  simulated addresses.
- **Prime Agent giving a real answer** (needs the key).
- **Tool use by our own loop with a real model** (covered by automatic tests with a scripted model).

## Known limits (unchanged)

- Prime Agent never asks before running things; for it only the macOS sandbox protects.
- Shell tricks like `echo x > /etc/file` are not in the block list; on macOS the sandbox stops
  them, on Linux nothing does.
- Phone mode traffic on your Wi-Fi is not encrypted (plain http).
