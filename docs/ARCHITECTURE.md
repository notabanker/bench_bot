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

| Service | Interface (v0) | Provider(s) v0 |
|---|---|---|
| `llm` | `stream(messages, tools, signal) -> AsyncIterable<Chunk>` | OpenAI-compatible `/chat/completions` (one impl; default base URL OpenCode Go, also Ollama / LM Studio) |
| `session` | `append(threadId, event)` / `read(threadId)` / `resume(threadId)` | SQLite (`node:sqlite`) |
| `tool` | `schema()` / `run(call, ctx)` | host tools: `fs.*`, `ask_bot`, `list_bots` |
| `harness` | `start` / `send` / `abort` / `capabilities` | `generic-loop`, `opencode*`, `prime-agent*` (\*stub first) |
| `delegation` | `list_bots()` / `ask_bot(botId, text)` | mailbox over SQLite |
| `fs` | `read` / `write` / `list` scoped to a bot workspace | local |
| `queue` | `enqueue(msg)` / `drain(botId)` / `pause` | per-bot FIFO, one live turn per bot |
| `policy` | `check(action, ctx) -> allow \| block(reason)` | folder limits + block list (§7a) |

Rule: **interfaces before implementations**, and never a god object. `AgentService` does not exist here.

## 3. The Harness contract

v0 implements the **bold** parts; the rest is declared in the interface and returns
`unsupported` until built. Evidence for each requirement is in `reference-notes.md`.

```ts
interface Harness {
  id: string
  capabilities(): { resume: boolean; steer: boolean; tools: boolean; reasoning: boolean }
  start(ctx: BotRunContext): Promise<RunHandle>
  send(text: string, opts?: { tools?: ToolSchema[]; signal?: AbortSignal }): AsyncIterable<Chunk>
  abort(runId: string): Promise<void>          // idempotent, settles with reason 'aborted'
  resume?(runId: string): Promise<'cursor' | 'replay'>
}
```

- **Start before you commit:** model + tools + adapter are resolved *before* any
  model-visible input is written to the session log (dsh `prepareCall`, PA `ProviderTarget`).
- **One canonical chunk union:** `text-delta | reasoning-delta | tool-call | tool-result |
  usage | finish(reason)`. A provider throw becomes a terminal `error` chunk — never a raw throw.
- **Abort is signal-driven** and safe to call twice; an aborted run records zero usage.
- **Capabilities gate the UI**: never offer a control the bound harness cannot honour.
- **Resume** is either a cursor into a live native session or a replay of the durable log —
  and the two must be distinguishable by the caller.

`BotRunContext = { botId, threadId, workspacePath, model, toolPolicy, sessionLog }`

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
| `opencode` | starts `opencode acp` (MIT) and talks ACP over stdio, as both references do | stub → real |
| `prime-agent` | starts `prime-agent --mode acp` (MIT, Rust) — same ACP transport (`crates/pa-cli/src/args.rs`, `crates/pa-daemon/src/acp/mod.rs`); its built-in `opencode-go` provider reads `OPENCODE_API_KEY` (`crates/pa-ai/src/env_api_keys.rs`) | stub → real |

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
web composer ──POST /bots/:id/messages──▶ api
   session.append(threadId, message.received)
   queue.enqueue(botId, delivery)                → one message, N deliveries (fan-out)
   queue.drain(botId)                            → one live turn per bot, FIFO
      harness.start(ctx)                         → resolves model+tools first
      harness.send(text)                         → AsyncIterable<Chunk>
         each chunk → session.append(...) → SSE → web
      finish → session.append(turn.finished) → drain next queued delivery
```

No event-sourced projections: the session log and the relational tables are written
directly, in one transaction per append. (Deliberate difference, see §7.)

## 6. Storage (SQLite, direct relational)

| Table | Holds |
|---|---|
| `bots` | id, name, section, model, harness, access, workspace |
| `threads` | id (public), bot_id, title, created_at |
| `runs` | id, thread_id, harness_session_id (the CLI's own id), status, resume_cursor |
| `messages` | id, thread_id, role, content, run_id, created_at |
| `events` | id, thread_id, run_id, kind, payload_json — append-only, the replay source |
| `deliveries` | mailbox fan-out: message_id, recipient_bot_id, status, queue_order |
| `usage` | run_id, input_tokens, output_tokens, harness_id |

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

Honest limits: the block list only sees commands that pass through us; the sandbox is what makes
the folder limits hold. Apple labels `sandbox-exec` deprecated, but it is present on current macOS
and OpenBot relies on it. Mac first; Linux/Windows confinement is not planned for v1.

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

The detailed, phase-by-phase version of this order (with the safety phase before the outside
programs) is `plan.md`.

## 10. Decisions a human should confirm

Confirmed by the user on 2026-09-30:

- **D1** ✅ Electron desktop app from the start (thin shell, logic in the local server).
- **D3** ✅ Open-source harnesses only: `generic-loop` real, `opencode` + `prime-agent` stub → real.
  No Claude Code. Grok models via OpenCode Go, no Grok harness.
- **D6** ✅ Default model source: OpenCode Go subscription. `generic-loop` calls it directly;
  `opencode` uses the same key. Orchestrator runs on `opencode`.
- **D7** ✅ Name: bench_bot.
- **D8** ✅ Safety: folder limits + block list, refuse + note in chat, no confirmation pop-ups (§7a).
- **D9** ✅ macOS first. Real AI tested on the user's Mac; the cloud build uses a fake AI.
- **D10** ✅ Build follows `plan.md`; stop for the user's OK after each phase.
- **D2** ✅ Storage: Node's built-in `node:sqlite` (no native module to rebuild for Electron;
  both reference apps use it). Hono + Vite/React unchanged.

Still open:

- **D4** Direct relational state, no event-sourced projections.
- **D5** Repo is `notabanker/bench_bot`; license still unset.
