# bench_bot — Architecture

Our design. Written after reading the reference repos (see `openbot-map.md`,
`reference-notes.md`). We copy the *shape*, never the code: OpenBot is PolyForm
Noncommercial, so clean-room is a legal requirement, not a preference.

## 1. What bench_bot is

A local-first workspace where **bots are contacts**. Each bot has a thread, its own
workspace directory, its own tools, and a **swappable harness**. Bots can ask other bots.

`Bot = identity + instructions + model + harness + tools`

**Non-goals for v1:** billing, hosting, multi-tenant, Kubernetes, remote desktop,
a provider×login matrix, enterprise approvals.

## 2. The kernel: everything outside the model is a Service

```
kernel/      tiny DI: register(name, service) / get(name). No globals, no decorators.
services/    interfaces only — no implementation may be imported from here
providers/   implementations, one file per backend
harnesses/   generic-loop, opencode, prime-agent (the one place a model/CLI meeting happens)
bots/        bot definitions (yaml)
apps/api/    HTTP + SSE
apps/web/    sidebar roster + thread + composer
apps/desktop/ Electron shell: starts apps/api, opens apps/web in a window
```

Interfaces live in `services/src/*.ts`; implementations are named per row. All are registered in
the kernel in `apps/api/src/compose.ts`.

| Service | Interface | Implementation |
|---|---|---|
| `llm` | `stream(request) -> AsyncIterable<LlmChunk>` | `OpenAiCompatibleLlm` (`/chat/completions`; OpenCode Go by default, also Ollama / LM Studio); `ScriptedLlm`/`EchoLlm` for tests and offline |
| `session` | `createThread` / `listThreads` / `append` / `read(afterSeq)` / `log(threadId)` | `SqliteSession` (`node:sqlite`), wrapped by `LiveSession` for live updates |
| `tools` | `register` / `schemas(names)` / `run(name, args, ctx)` | `ToolRegistry` with `fs_read`, `fs_write`, `fs_list`, `list_bots`, `ask_bot` |
| `harnesses` | catalog of `HarnessFactory` (§3): `get(id)` / `ids()` | `generic-loop` (`GenericLoopFactory`), `opencode` + `prime-agent` (`AcpHarnessFactory`) |
| `delegation` | `listBots(caller)` / `askBot({from, to, text, chain})` | `BotDelegation`: standing thread per bot pair, runs through the queue |
| `fs` | `read` / `write` / `list` scoped to a bot workspace | `LocalFs` |
| `queue` | `enqueue` / `whenDone` / `abortThread` / `pause` / `resume` | `BotRunner`: per-bot FIFO in memory, one live run per bot |
| `bots` | `list()` / `get(id)` | `YamlBotDirectory` (`bots/*.yaml`, re-read on every call) |
| `policy` | `check(action, ctx) -> allow \| refuse(reason)` | `SafetyPolicy`: folder limits + block list (§7a) |

Rule: **interfaces before implementations**, and never a god object. `AgentService` does not exist here.

## 3. The Harness contract

Evidence for each requirement is in `reference-notes.md`. All parts below are implemented;
`resume` means "rebuild from the log" for every engine (no engine-native session resume yet).

```ts
// One engine (generic-loop, opencode, prime-agent). Registered in the HarnessCatalog.
interface HarnessFactory {
  id: string
  capabilities(): { resume: boolean; steer: boolean; tools: boolean; reasoning: boolean }
  create(): Harness                            // a fresh harness for every bot run
}

// One bot run (the CLAUDE.md contract + optional resume).
interface Harness {
  id: string
  start(ctx: BotRunContext): Promise<void>     // resolve model + tools before logging anything
  send(text: string): AsyncIterable<BotEvent>  // never throws; ends with exactly one `finish`
  abort(): Promise<void>                       // idempotent; stream ends with reason 'aborted'
  resume?(): Promise<'cursor' | 'replay'>
}
```

Source of truth: `services/src/harness.ts` and `services/src/events.ts`. One harness instance
per run keeps runs apart without run ids on every call.

- **Start before you commit:** model + tools + adapter are resolved *before* any
  model-visible input is written to the session log (dsh `prepareCall`, PA `ProviderTarget`).
- **One canonical event union (`BotEvent`):** `text-delta | reasoning-delta | tool-call |
  tool-result | blocked | usage | error | finish(done|aborted|error|max-steps)`. A provider throw
  becomes an `error` event + `finish` — never a raw throw.
- **Abort is signal-driven** and safe to call twice; an aborted run records zero usage.
- **Capabilities gate the UI**: never offer a control the bound harness cannot honour.
- **Resume** is either a cursor into a live native session or a replay of the durable log —
  and the two must be distinguishable by the caller.

`BotRunContext = { botId, threadId, runId, workspacePath, model, instructions, toolPolicy, sessionLog }`

## 4. Bot definition (config, never hardcoded)

```yaml
id: finance
name: Finance
section: Research
instructions: |
  You are the finance bot...
model: <model-id>
harness: prime-agent      # generic-loop | opencode | prime-agent
tools: [fs.read, fs.write, ask_bot]
workspace: ./bots/finance/workspace
access: workspace-only     # or 'full'
```

The Orchestrator→opencode / Finance→prime-agent / simple bots→generic-loop pairing lives
here, in yaml. A "Grok bot" is just a bot whose `model` is a Grok model from OpenCode Go;
there is no Grok harness. Swapping a bot's harness must be a one-line edit.

### Harnesses in v1 (open source only)

| Harness | How it runs | Status |
|---|---|---|
| `generic-loop` | our own loop in-process; calls `llm` over HTTP (OpenCode Go key, `OPENCODE_API_KEY`) | real |
| `opencode` | starts `opencode acp` (MIT) and talks ACP over stdio, as both references do | real; stand-in reply if not installed |
| `prime-agent` | starts `prime-agent --mode acp` (MIT, Rust) — same ACP transport (`crates/pa-cli/src/args.rs`, `crates/pa-daemon/src/acp/mod.rs`); its built-in `opencode-go` provider reads `OPENCODE_API_KEY` (`crates/pa-ai/src/env_api_keys.rs`) | real; stand-in reply if not installed |

Both outside programs speak ACP, so they share **one ACP adapter** with a per-program config
(command, args, env). Checked against prime-agent commit `839949b`, 2026-09-30.

Later, same pattern: Codex CLI (Apache-2.0), Gemini CLI (Apache-2.0). Claude Code is
excluded (proprietary). Because OpenCode and Gemini both speak ACP, the `opencode` adapter
should be written as a generic ACP adapter with an OpenCode config, not a one-off.

Known limit: OpenCode Go serves Grok on a `/responses` endpoint and some models on an
Anthropic-style `/messages` endpoint (opencode.ai/docs/go, read 2026-09-30). The v1
`generic-loop` only speaks `/chat/completions`; those models go through `opencode`.

## 5. Message → turn

```
web composer ──POST /api/threads/:id/messages──▶ api (apps/api/src/app.ts)
   session.append(threadId, message)             → stored entry with its seq
   runner.enqueue(delivery {seq, chain})          → per-bot FIFO, one live run per bot
   BotRunner (apps/api/src/runner.ts)
      runs.start(...)                            → runs table: status "running"
      harness = harnesses.get(bot.harness).create()
      harness.start(ctx)                         → history = log entries with seq < delivery.seq
      for event of harness.send(text)            → BotEvent stream
         session.append(event) → hub → SSE (/api/threads/:id/events) → web
      exactly one finish → runs.finish(status, usage) → next delivery
```

Engines like OpenCode reach `list_bots` / `ask_bot` through `apps/api/bin/mcp-bridge.mjs` (a
stdio MCP server the engine starts) → `/api/internal/tools/*`, authenticated by a per-run token.

No event-sourced projections: the session log and the relational tables are written
directly, in one transaction per append. (Deliberate difference, see §7.)

## 6. Storage (SQLite, direct relational)

| Table | Holds | Added in |
|---|---|---|
| `schema_migrations` | version, description, applied_at — which numbered steps ran | migration 1 |
| `threads` | id (public), bot_id, title, created_at | migration 1 |
| `entries` | thread_id, seq (1, 2, 3… per thread, no gaps), at, kind (`message` \| `event`), run_id (set exactly for events), payload JSON. **Append-only**: triggers refuse UPDATE/DELETE. User messages and bot events share this one ordered log. | migration 1 |
| `runs` | id, thread_id, bot_id, harness, model, status (`running` / `done` / `aborted` / `error` / `max-steps` / `interrupted`), started/finished, token usage, harness_session_id (reserved for engine-native resume) | migration 2 |

Not stored (deliberately, for v1): the waiting line (in memory; queued-but-not-started messages
stay in the chat after a restart but are not re-run), and bots (the YAML files are the source of
truth).

Each table arrives with the phase that first uses it, as a new numbered migration
(`providers/src/sqlite/database.ts`). A shipped migration is never edited.

Public↔external id split (OpenBot's best idea, kept): `threads.id` is stable and
user-facing; `runs.harness_session_id` is whatever the CLI calls its own session.

## 7. Deliberate differences from OpenBot

1. **Thin Electron shell, fat local server.** The desktop app is Electron from the start, but it
   only opens a window on the React UI and starts the local server. All logic stays in the server
   (HTTP + SSE), like OpenMausBot and unlike OpenBot's main/preload/renderer IPC split.
2. **No event-sourced projections.** Direct relational writes + a plain append-only event log.
   Migrations are plain DDL, not replay-based text substitution.
3. **Small harness set, open source only, honest stubs.** Three harnesses in v1; stubs keep the
   real interface and log the prompt instead of pretending.
4. **One explicit approval channel.** No attention registry, no auto-approve "Turbo" policy.
5. **Tools are ours, not a namespace zoo.** v0 ships `fs.*`, `list_bots`, `ask_bot` only.
6. **Computer-use is not in v1.** Screenshot placeholder pane at most; desktop control is a plugin later.
7. **Mailbox semantics are in the API:** `expectsReply` and idempotency keys are explicit
   parameters, not derived from message shape.

## 7a. Safety policy (confirmed 2026-09-30)

Bots may do almost everything **without asking**. Two layers stop the few things that could break
the Mac or bench_bot itself:

1. **Folder limits.** A bot may write inside its own workspace and the user's normal folders. It may
   not write macOS system folders, the bench_bot app, or bench_bot's data folder (so it cannot edit
   its own rules). Outside programs (`opencode`, `prime-agent`) run inside the macOS sandbox
   (`/usr/bin/sandbox-exec`, a Seatbelt profile), so the limits also cover any script or command
   they start. Idea from OpenBot `src/backend/process-confinement.ts`; our own profile.
2. **Block list.** Refuse `sudo`, disk erase/format tools, deletes of system paths, shutdown and
   system-setting changes — checked on every command or permission request we see.

When something is blocked: refuse, tell the bot why, and put a short note in the chat. No pop-up.

Implementation: `providers/src/policy/safety-policy.ts` (rules, block list) and
`providers/src/policy/seatbelt.ts` (macOS sandbox profile + `sandbox-exec` wrapper). One list of
protected places feeds both. Writing is refused in: macOS system folders (`/System`, `/Library`,
`/usr` except `/usr/local`, `/etc`, `/var` except temp, `/Applications`, `/dev`…), the disk root
and home folder itself, `~/Library/Keychains`, `~/Library/LaunchAgents|LaunchDaemons`, and
bench_bot's own data folder and program folder — except the bot's own workspace. Reading is
always allowed. Commands are refused for: sudo/su, disk formatting/erasing, raw disk writes,
shutdown/reboot, macOS security settings (csrutil, nvram, spctl…), stopping system services,
power settings, deleting Time Machine backups, deleting system folders or the whole home folder,
permission changes on system folders, fork bombs, killing core macOS processes.

Honest limits:
- The block list is pattern matching. It only sees commands that reach us (an engine's permission
  request); a determined or confused model can phrase the same thing differently. The sandbox is
  what makes the folder limits hold for everything a confined program does.
- Our own loop has no shell tool, so for `generic-loop` bots the folder limits are enforced by
  the file tools themselves (workspace containment + policy check).
- The sandbox exists only on macOS. On Linux/Windows outside programs run unconfined (a warning is
  logged). Apple labels `sandbox-exec` deprecated, but it ships with current macOS and OpenBot
  relies on it too.
- Reading is not limited: a bot can read any file your user can read.
- OpenCode only asks before commands/edits because bench_bot configures it to
  (`OPENCODE_PERMISSIONS` in `apps/api/src/compose.ts`). Prime Agent never asks; for it only the
  sandbox applies. Shell tricks such as `echo x > /etc/file` are not in the block list; on macOS
  the sandbox stops them, on Linux nothing does.

## 7b. Phone mode

Off by default. With `BENCH_PHONE=1` the server also listens on the home network; a gate in
`apps/api/src/app.ts` lets this computer through as before and lets other devices through only
from private network ranges, to the Mac's own address, after a password login (session cookie).
The engine bridge (`/api/internal/*`) and `/api/phone` stay loopback-only. Plain http on the LAN.
See `docs/phone.md`.

## 8. Stack

TypeScript · pnpm workspaces · **Hono** (HTTP + SSE) · **`node:sqlite`** (built into Node) ·
Vite + React (own UI: dense, mail-like, own type and colour — not their component tree) ·
**Electron** desktop shell (`apps/desktop`). Node ≥ 22. No Docker required for v0.

## 9. Build order (matches `CLAUDE.md` step 1–9)

1. ✅ `docs/openbot-map.md`, `docs/reference-notes.md`, this file
2. kernel + service registry (+ contract tests: register/get, missing-service error)
3. session log + generic-loop harness + one LLM provider (real API call if a key exists)
4. API: bots, threads, send message, SSE stream
5. web: sidebar roster + thread + composer, shown in the Electron shell
6. bot yaml + `harness` field
7. `ask_bot` delegation + mailbox fan-out
8. opencode / prime-agent harnesses (stub → real)
9. computer pane (placeholder screenshot)

All steps are done (see `plan.md`, Phases 1–12).

The detailed, phase-by-phase version of this order (with the safety phase before the outside
programs) is `plan.md`.

## 10. Decisions a human should confirm

Confirmed by the user on 2026-09-30:

- **D1** ✅ Electron desktop app from the start (thin shell, logic in the local server).
- **D3** ✅ Open-source harnesses only: `generic-loop`, `opencode`, `prime-agent` (all real; stand-in
  reply when a program is not installed).
  No Claude Code. Grok models via OpenCode Go, no Grok harness.
- **D6** ✅ Default model source: OpenCode Go subscription. `generic-loop` calls it directly;
  `opencode` uses the same key. Orchestrator runs on `opencode`.
- **D7** ✅ Name: bench_bot.
- **D8** ✅ Safety: folder limits + block list, refuse + note in chat, no confirmation pop-ups (§7a).
- **D9** ✅ macOS first. Real AI tested on the user's Mac; the cloud build uses a fake AI.
- **D10** ✅ Build follows `plan.md`; stop for the user's OK after each phase.
- **D2** ✅ Storage: Node's built-in `node:sqlite` (no native module to rebuild for Electron;
  both reference apps use it). Hono + Vite/React unchanged.

- **D4** ✅ Direct relational state + append-only event log; no event-sourced projections.
- **D5** ✅ Repo is `notabanker/bench_bot`; license deliberately left unset for now.
- **D11** ✅ README carries no company story (no "EU-built" pitch).
