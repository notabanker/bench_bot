# bench_bot — build plan

The step-by-step plan for the first version. Design details live in `docs/ARCHITECTURE.md`;
the rules for the build live in `CLAUDE.md`.

## How we work

- **One phase at a time.** A phase is a small group of tasks. When a phase is done I tick it off
  here, save it to GitHub (`main`), explain in plain words what changed and how to check it, and
  **wait for your OK** before starting the next phase.
- **Small saves.** Each task is its own commit, so every step can be looked at or undone alone.
- **Fake AI in the cloud, real AI on your Mac.** While building I test with a fake stand-in AI.
  You try real answers on your iMac with your OpenCode Go key in a local `.env` file. That file is
  never saved to GitHub.
- **Mac first.** The desktop app is built and tested for macOS first.
- **Open questions** (bottom of this file) must be answered before the phase that needs them.

Legend: `[ ]` open · `[x]` done · **Check:** what you can look at or try yourself after the phase.

---

> **2026-10-01, user decision:** build all remaining phases (4–12) in one go, without stopping
> for an OK after each phase. The user adjusts the codebase afterwards. Defaults chosen without
> asking are marked **(default — adjust)** below and collected in the final report.

## Phase 1 — Project skeleton ✅ (done 2026-09-30, checked on Mac 2026-10-01)

Goal: an empty but correctly set-up project that builds and runs its tests.

- [x] 1.1 Workspace setup
  - [x] pnpm workspace with the folders from `CLAUDE.md` (`kernel/`, `services/`, `providers/`,
        `harnesses/`, `bots/`, `apps/api`, `apps/web`, `apps/desktop`)
  - [x] TypeScript (strict) shared config
  - [x] Test runner (Vitest) with one example test
  - [x] Formatter / linter
- [x] 1.2 Pin versions: Node version file, pnpm version
- [x] 1.3 `.gitignore` for `.env`, build output, local data
- [x] 1.4 `.env.example` listing `OPENCODE_API_KEY` and `LLM_BASE_URL` (no real values)
- [x] 1.5 README "How to run" section: `pnpm install`, `pnpm test`

**Check:** `pnpm install` and `pnpm test` work on your Mac and the example test passes.

## Phase 2 — Kernel (the wiring) ✅ (2026-10-01, OK given)

Goal: the small core that lets every part of the app find the others without knowing how they
are built ("register a service, get a service").

- [x] 2.1 Kernel: `register(name, service)` and `get(name)`
  - [x] Clear error when a service is missing or registered twice
  - [x] Tests for both
- [x] 2.2 Service interfaces only (no implementations yet) in `services/`:
      `llm`, `session`, `tool`, `harness`, `delegation`, `fs`, `policy`, plus `queue` (already in
      `docs/ARCHITECTURE.md`) and `bots` (the roster), needed in Phases 5 and 8
- [x] 2.3 Shared event type: the one list of things a bot run can report
      (text piece, tool call, tool result, usage, finished, error, blocked)

**Check:** tests pass; I show you the interface files with a short plain-words explanation of each.

## Phase 3 — Saving chats ✅ (2026-10-01)

Goal: every message and every step a bot takes is saved, so chats survive a restart.

- [x] 3.1 Database setup with Node's built-in `node:sqlite`
  - [x] Tables: `threads` + `entries` (messages and events in one ordered log). `runs`, queue and
        `bots` tables come with Phases 4, 5 and 8, as their own migrations (`docs/ARCHITECTURE.md` §6)
  - [x] Simple, numbered schema migrations
- [x] 3.2 Session service: append an event, read a thread, in one transaction per append
- [x] 3.3 Tests: write, read back, restart, read again

**Check:** tests pass, including "close and reopen the database, chat is still there".

## Phase 4 — Our own simple loop talking to an AI ✅

Goal: a bot can get a real answer from OpenCode Go ("Way 1": our app calls OpenCode Go directly).

- [x] 4.1 LLM provider: OpenAI-style `/chat/completions` with streaming
  - [x] Base URL from `LLM_BASE_URL` (default `https://opencode.ai/zen/go/v1`), key from
        `OPENCODE_API_KEY`
  - [x] Errors become a clean "error" event, never a crash
- [x] 4.2 Fake provider for tests (answers from a script, no network)
- [x] 4.3 generic-loop harness: send → stream answer → run tool calls → repeat until done; abort works
- [x] 4.4 First tools: `fs_read`, `fs_write`, `fs_list` (underscores: OpenAI-style APIs reject dots),
      limited to the bot's own folder
- [x] 4.5 Tiny command-line test script: `pnpm ask "…"` (default model `glm-5.3-flash`, max 12 tool
      rounds per message — **(default — adjust)**)

**Check:** on your Mac, with your key in `.env`, the test script prints a real answer.

## Phase 5 — Local server (API) ✅

Goal: the part the window talks to — list bots, open threads, send a message, stream the answer
live.

- [x] 5.1 Hono server on `127.0.0.1` only (not reachable from other computers)
- [x] 5.2 Endpoints: list bots, list threads, read a thread, send a message
- [x] 5.3 Live stream (SSE) of a bot's answer as it is typed
- [x] 5.4 One live run per bot; further messages wait in line (queue). The line is kept in memory:
      after a restart, queued (not yet started) messages stay in the chat but are not re-run
      **(default — adjust)**; runs cut off by a crash are marked "interrupted"
- [x] 5.5 Tests for each endpoint using the fake AI

**Check:** `pnpm start`, then `curl http://127.0.0.1:8787/api/bots`. Port 8787 and the data folder
`~/Library/Application Support/bench_bot` are **(default — adjust)** via `BENCH_PORT` / `BENCH_DATA_DIR`.

## Phase 6 — Chat window (web UI) ✅

Goal: something you can click and type into.

- [x] 6.1 React + Vite app
- [x] 6.2 Left: bot roster (like contacts). Middle: the thread. Bottom: the composer
- [x] 6.3 Answers appear live while the bot types; tool steps shown as small chips
- [x] 6.4 Our own look: dense, mail-like, own colours and font (not copied from the references)
- [x] 6.5 Screenshot: `docs/screenshots/chat-window.png`

**Check:** `pnpm build && pnpm start`, open http://127.0.0.1:8787 — or `pnpm dev` and open
http://127.0.0.1:5173 for live-reloading UI work.

## Phase 7 — Desktop app (Electron, Mac) ✅

Goal: bench_bot opens as a normal Mac app window.

- [x] 7.1 Electron shell: starts the local server, opens the chat window
- [x] 7.2 Closing the app stops the server and any bot programs cleanly
- [x] 7.3 `pnpm dev:desktop` for development
- [ ] 7.4 (Later, not in this phase) signed `.dmg` installer

**Check:** `pnpm dev:desktop` on your iMac opens the bench_bot window. Tested in the cloud on a
virtual screen (Linux, Electron 44.5.1); not yet on macOS.

## Phase 8 — Bots as config files ✅

Goal: each bot is a small text file you can edit: name, instructions, model, harness, tools.

- [x] 8.1 Bot file format (YAML) and validation with clear error messages
- [x] 8.2 Starter bots **(default — adjust, answers Q1 provisionally)**: Assistant (generic-loop,
      `glm-5.3-flash`), Orchestrator (opencode, `kimi-k3`), Finance (prime-agent, `deepseek-v4-pro`),
      Grok (opencode, `grok-4.7`). Format: `bots/README.md`
- [x] 8.3 Each bot gets its own work folder
- [x] 8.4 Changing a bot's `harness:` or `model:` line switches it — nothing hard-coded

**Check:** edit a bot file (e.g. change its model); the next message uses the new setting, no restart.

## Phase 9 — Bots asking bots ✅

Goal: the Orchestrator can hand a question to the Finance bot and use the answer.

- [x] 9.1 Tools `list_bots` and `ask_bot`
- [x] 9.2 The asked bot's answer goes back to the asking bot automatically
- [x] 9.3 Loop protection: no asking itself, no asking a bot already in the chain, max 3 bots per
      chain, 10-minute wait limit **(default — adjust)**; Stop also stops the asked bot
- [x] 9.4 The chat shows an `ask_bot → finance` chip with the answer; Finance's list shows the
      conversation as "Asked by orchestrator"

**Check:** works today between bots on our own loop (e.g. Assistant → Finance once Finance runs on
`generic-loop`). For the Orchestrator on OpenCode, see Phase 11.

## Phase 10 — Safety rules ✅

Goal: bots may do almost everything without asking, but can never break the Mac or the app.
Must be finished **before** any outside program (OpenCode, Prime Agent) runs commands.

- [x] 10.1 Policy service with two layers
  - [x] **Folder limits:** bots may write in their own folder and your normal user folders; never
        in macOS system folders, the bench_bot app, or bench_bot's own data
  - [x] **Block list:** no `sudo`, no disk erase/format tools, no deleting system paths, no
        shutting down or changing system settings
- [x] 10.2 When something is blocked: refuse, tell the bot why, show a short note in the chat
      (no pop-up)
- [x] 10.3 Sandbox profile + `sandbox-exec` wrapper built and tested; applied to OpenCode and
      Prime Agent in Phase 11. Not run on a real Mac yet (cloud is Linux)
- [x] 10.4 Tests with harmless "dangerous" examples (they must be refused)
- [x] 10.5 Honest limits written down in `docs/ARCHITECTURE.md`

**Check:** the rule list in plain words is in `docs/ARCHITECTURE.md` §7a; the block list is
**(default — adjust)** in `providers/src/policy/safety-policy.ts`.

## Phase 11 — OpenCode and Prime Agent ✅

Goal: bots can run on the two open-source programs ("Way 2").

- [x] 11.1 One shared ACP connector (both programs speak ACP)
- [x] 11.2 OpenCode setup: start `opencode acp`, pass the Go key
- [x] 11.3 Prime Agent setup: start `prime-agent --mode acp`, use its `opencode-go` provider
- [x] 11.4 If a program is not installed: stand-in mode that says so clearly
- [x] 11.5 Their permission questions go through the Phase 10 rules; on macOS they run inside the
      sandbox; a small tool bridge (MCP) gives them `list_bots` / `ask_bot`
- [x] 11.6 Install guide: `docs/engines.md`

**Check:** on your Mac (with both installed and the key in `.env`), the Orchestrator runs on OpenCode
and Finance on Prime Agent. Cloud-tested with the real programs on Linux; see `docs/engines.md`
"Tested".

## Phase 12 — Computer pane (placeholder)

Goal: a side panel where a bot's "computer" will later show. A placeholder image is enough for now.

- [ ] 12.1 Side panel with a placeholder screenshot
- [ ] 12.2 Open / close per bot

**Check:** the panel opens next to a chat.

---

## Later (not in the first version)

- Scheduler / routines (only after chat + two harnesses work)
- Codex CLI and Gemini CLI harnesses (same ACP connector where possible)
- Generic loop support for OpenCode Go's `/responses` (Grok) and `/messages` endpoints
- Ollama / LM Studio presets
- Signed macOS installer

## Open questions

- **Q1** (still open for you) Starter bots: I created four as a default (see Phase 8). Rename,
  change or delete them in `bots/*.yaml`; what the Finance bot should really do is yours to decide.
- ~~Q2~~ answered: save state directly + event log (simple).
- ~~Q3~~ answered: license left unset for now.
- ~~Q4~~ answered: "EU-built" pitch removed from the README.
