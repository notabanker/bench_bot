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
harnesses/   the harness implementations (the one place a model/CLI meeting happens)
bots/        bot definitions (yaml)
apps/api/    HTTP + SSE
apps/web/    sidebar roster + thread + composer
```

| Service | Interface (v0) | Provider(s) v0 |
|---|---|---|
| `llm` | `stream(messages, tools, signal) -> AsyncIterable<Chunk>` | OpenAI-compatible (one impl) |
| `session` | `append(threadId, event)` / `read(threadId)` / `resume(threadId)` | SQLite |
| `tool` | `schema()` / `run(call, ctx)` | host tools: `fs.*`, `ask_bot`, `list_bots` |
| `harness` | `start` / `send` / `abort` / `capabilities` | `generic-loop`, `claude-code*`, `grok*`, `prime-agent*` (\*stub first) |
| `delegation` | `list_bots()` / `ask_bot(botId, text)` | mailbox over SQLite |
| `fs` | `read` / `write` / `list` scoped to a bot workspace | local |
| `queue` | `enqueue(msg)` / `drain(botId)` / `pause` | per-bot FIFO, one live turn per bot |

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
harness: prime-agent      # generic-loop | claude-code | grok | prime-agent
tools: [fs.read, fs.write, ask_bot]
workspace: ./bots/finance/workspace
access: workspace-only     # or 'full'
```

The Orchestrator→Claude Code / Finance→prime-agent / Grok→Grok CLI pairing lives here,
in yaml. Swapping a bot's harness must be a one-line edit.

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

1. **No Electron in v1.** Headless backend + thin web client. A desktop wrapper (Tauri/Electron)
   around the same HTTP API is a later, optional shell.
2. **No event-sourced projections.** Direct relational writes + a plain append-only event log.
   Migrations are plain DDL, not replay-based text substitution.
3. **Small harness set, honest stubs.** Four harnesses, stub implementations that keep the
   real interface and log the prompt instead of pretending.
4. **One explicit approval channel.** No attention registry, no auto-approve "Turbo" policy.
5. **Tools are ours, not a namespace zoo.** v0 ships `fs.*`, `list_bots`, `ask_bot` only.
6. **Computer-use is not in v1.** Screenshot placeholder pane at most; desktop control is a plugin later.
7. **Mailbox semantics are in the API:** `expectsReply` and idempotency keys are explicit
   parameters, not derived from message shape.

## 8. Stack

TypeScript · pnpm workspaces · **Hono** (HTTP + SSE) · **better-sqlite3** ·
Vite + React (own UI: dense, mail-like, own type and colour — not their component tree).
Node ≥ 22. No Docker required for v0.

## 9. Build order (matches `CLAUDE.md` step 1–9)

1. ✅ `docs/openbot-map.md`, `docs/reference-notes.md`, this file
2. kernel + service registry (+ contract tests: register/get, missing-service error)
3. session log + generic-loop harness + one LLM provider (real API call if a key exists)
4. API: bots, threads, send message, SSE stream
5. web: sidebar roster + thread + composer
6. bot yaml + `harness` field
7. `ask_bot` delegation + mailbox fan-out
8. claude-code / grok / prime-agent harnesses (stub → real)
9. computer pane (placeholder screenshot)

## 10. Decisions a human should confirm

- **D1** No Electron; headless backend + web UI (a desktop shell can wrap it later).
- **D2** Hono + better-sqlite3 + Vite/React as the concrete stack.
- **D3** v0 harnesses: `generic-loop` real, `claude-code`/`grok`/`prime-agent` as honest stubs.
- **D4** Direct relational state, no event-sourced projections.
- **D5** Repo is public under `notabanker/hoster`, license still unset (all rights reserved until we pick).
