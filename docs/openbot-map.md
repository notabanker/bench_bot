# OpenBot — Architectural Map

Clean-room map of `/tmp/ref-openbot` (OpenBot v0.26.0, "local-first multi-agent desktop workspace"). Bun + Electron + SolidJS, monorepo (workspaces `apps/*`, `packages/*`, `remote/api`). All paths relative to repo root. Read-only source; ideas below, never code.

> Correction to a prior assumption: agents do **not** run `approvalPolicy: "never"` / `danger-full-access` unconditionally. Current code sends `approvalPolicy: "on-request"` on every `turn/start` (`src/backend/agent/drain-scheduler.ts:414`, `thread-lifecycle.ts:335,564`) and a sandbox policy from `src/backend/agent/workspace-sandbox.ts` — `workspace-write` when workspace access is enforced, `danger-full-access` otherwise. `approvalPolicy: "never"` survives only in `profile-generation.ts:114` (a profile prompt, not a turn). Approvals surface through `AttentionRegistry`/`OpenBotToolRouter` and may be auto-approved by an `ApprovalAutomationPolicy` (`approval-automation.ts`, the "Turbo" feature).

---

## 1. Folder map

| Dir | Owns | Main entry points |
|---|---|---|
| `src/backend/` | Core domain, framework-free, fully unit-testable (245 files). Agent orchestration, providers, mailbox, browser, SQLite | `agent-service.ts` (facade), `agent/` (subsystem classes), `openbot-database.ts` |
| `src/main/` | Electron main process (355 files): IPC, Team API server, computer-use driver, windows, app wiring | `index.ts`, `application-services.ts`, `ipc/agent-handlers.ts`, `team-api-server.ts` |
| `src/preload/` | Context bridge (24 files) | preload scripts |
| `src/renderer/` | SolidJS UI (526 files) | `src/renderer/src/features/conversation/*` |
| `packages/contracts/` | Shared types, Zod validators, IPC endpoint defs, Team protocol v1–v5 | `src/ipc.ts`, `src/ipc-endpoints.ts`, `src/team-protocol/*` |
| `packages/ui/` | SolidJS component library | |
| `packages/i18n/`, `logging/`, `brand/`, `team-client/`, `user-errors/` | Localization, logger, branding, remote-team client, error helpers | |
| `apps/` | `auth-api` (OAuth worker), `mobile` (companion app), `site-router` (Cloudflare) | |
| `remote/` | Deployment: `api` (Cloudflare Worker = remote control plane), `acme`, `coturn` (WebRTC), `nginx`, `bin`, `scripts` | |
| `resources/` | `agent-import`, `managed-skills`, `plugin-catalog` (bundled content) | |
| `vendor/` | `remote-desktop` — patched Sunshine/Moonlight for remote desktop streaming | |
| `marketplace/` | `plugin-catalog`, `production-catalog` | |
| `scripts/` | 146 dev/build/hosting/github-app scripts | |
| `tools/` | `biome`, `typescript`, `ui-foundation`, `vitest` (tooling configs) | |
| `docs/`, `plans/`, `changelog.d/`, `patches/` | Docs, planning markdown, changelog fragments, pnpm patches | |
| `.agents/skills`, `.claude`, `.codex` | Bundled agent skills + configs the app injects into agents | |
| `resources/agent-import` + `.codex/environments` | Agent import format + Codex environment defs | |

Frontend feature dirs map 1:1 to domains: `features/{agents,conversation,browser,computer-use,channels,connectors,custom-agents,custom-providers,files,servers,team,usage,remote-desktop}`.

---

## 2. How a user message becomes a provider turn

```
UI        src/renderer/src/features/conversation/ConversationComposer.tsx  (submitComposer)
          → conversation-scope.ts  actions.submitMessage
IPC       preload contextBridge → channel "agent:send-message"
          (defined packages/contracts/src/ipc-endpoints.ts:705)
Main      src/main/ipc/agent-handlers.ts → parseSendMessage → scopedHandler
          → local AgentService.sendMessage, or remote server (remote-server-manager)
Domain    src/backend/agent-service.ts:1667  sendMessage()
          → mailbox.enqueue()            creates 1 message + N deliveries (one per recipient)
          → drain.scheduleDrain(agentId)
Drain     src/backend/agent/drain-scheduler.ts
          drainAgent() → startDelivery()   (guards = composed mayDrain clauses, see §5)
          → providers.ensureAgentClient(agent)
          → threads.ensureThread(agent, client)  → "thread/start" | "thread/resume"
          → client.request("turn/start", { threadId, model, effort, input, cwd,
               runtimeWorkspaceRoots, approvalPolicy:"on-request", sandboxPolicy })
Client    AgentClient (src/backend/agent-client.ts) — JSON-lines RPC over stdio
          (jsonl.ts, protocol.ts). Impls spawn the provider's own CLI:
          - CodexAppServerClient    app-server-client.ts   `codex app-server --listen stdio://`
          - ClaudeAgentClient       claude-client.ts
          - GrokAgentClient         grok-client.ts
          - AcpAgentClient          acp-client.ts          (custom ACP agents)
          - CustomAcpAgentsClient   custom-acp-agents-client.ts
```

Provider → app (async, same connection):
```
provider CLI ──notification──▶ TurnLifecycle.handleNotification (agent/turn-lifecycle.ts)
  turn/started · item/started · item/completed · item/reasoning/textDelta ·
  item/agentMessage/delta · turn/completed · thread/tokenUsage/updated · plan/updated
  → DeltaBuffer (agent/delta-buffer.ts) buffers deltas
  → ConversationRuntime.ensureSnapshot + emitConversation (agent/conversation-runtime.ts)
  → OpenBotDatabase.persistConversation (openbot-database.ts)   [event-sourced, §3]
  → AgentService event → main → renderer (streaming)
```

Provider → app (server requests, mid-turn tool calls):
```
provider CLI ──request──▶ OpenBotToolRouter.handle (agent/openbot-tool-router.ts)
  item/tool/call  (namespaces "openbot", "openbot_browser") → host-side tools / browser
  item/commandExecution|fileChange|permissions/requestApproval → AttentionRegistry surface
  item/tool/requestUserInput → prompt; mcpServer/elicitation/request → MCP elicitation
  currentTime/read → host clock
```

Completion path: `TurnLifecycle.#completeTurn` → `mailbox.markTerminal` → `#relayAgentResult` (agent-to-agent answer, §4) → `compaction.reserve/request` (§5) → `scheduleDrain` (next queued message).

---

## 3. Data model & storage

**Two-tier persistence:**
- **Event store** `orchestration_events` (append-only, per-aggregate `sequence`) + `orchestration_command_receipts`. Projections (`projection_*`) are rebuilt by replaying events. Schema + migrations in `src/backend/openbot-database-schema.ts` (v8 baseline → v24). SQLite via `node:sqlite` `DatabaseSync` (`openbot-database.ts`).
- **Mailbox** (`src/backend/mailbox-store.ts`): in-memory `StoredState` (messages + deliveries + drafts + reactions + idempotency + paused) persisted as `mailbox.json` through `database.replaceMailboxState`. Fan-out model: one `message` → N `deliveries`, one per recipient agent, each with its own `queueOrder` + `status`.

**Core tables** (`projection_`): `threads`, `agents`, `agent_memories`, `agent_routines` (+ `routine_triggers`, `routine_runs`), `provider_sessions` (one per provider session, holds `external_session_id` = the CLI's own thread id, `resume_cursor`, `state`), `turns`, `thread_messages`, `thread_reads`, `thread_activities`, `thread_summaries`, `mailbox_messages`, `deliveries`, `queue_state` (paused), `reactions`, `attachments`, `direct_threads`, `direct_messages`, `direct_reads`, `mcp_servers`, channel tables, `file_deletion_outbox`, usage tables (`agent_usage_records/checkpoints/activity`).

**Agents** — `AgentStore` (`src/backend/agent-store.ts`); identity `agent-<uuid>`; workspace `~/OpenBot/Agents/<id>`. `provider` (codex | claude | grok | opencode | antigravity | acp | cursor) + `model` + `reasoningEffort` + `access` (workspace-only vs full). Workspace-only agents get sandboxing by provider type (`workspace-sandbox.ts` + `process-confinement.ts`).

**Threads/sessions** — two ids: public `threadId` (stable, user-visible) ↔ external provider session id. `ConversationRuntime` (`agent/conversation-runtime.ts`) maps external↔public (`bindThread`, `publicThreadId`, `agentForThread`) and holds in-memory `ConversationSnapshot`s. Provider session resumability = `projection_provider_sessions.resume_cursor`; a changed MCP tool set bumps a fingerprint (`thread-lifecycle.ts` `CODEX_MCP_ADAPTER_VERSION`) to force a fresh session.

**Tools** — two dynamic-tool namespaces injected as the host's own MCP-like tools:
- `openbot` (`src/backend/openbot-tools.ts`, router `agent/openbot-tool-router.ts`): `list_agents`, `read_agent`, `create_agent`, `send_message`, `interrupt_agent`, `remember`, `list/create/update/delete_routine`, `test_routine`, `update_profile`, hosted-site tools, sidebar tools, data tools.
- `openbot_browser` (`src/backend/browser-tools.ts`): `open`, `list_tabs`, `snapshot`, `navigate`, `click`, `type`, `press`, `scroll`, `select_option`, `set_checked`, `drag`, `upload_files`, `evaluate`, `act`, `screenshot`, `submit_secret`, `request_takeover`, recordings. Host-side execution in `browser-host.ts` + `browser-tool-actions.ts` over CDP (`browser-cdp*.ts`).

**Computer use (desktop control)** — not a provider feature; a separate daemon the main process owns: `src/main/cua-driver-runtime.ts` spawns a Rust driver (`cua-driver`), exposes it as MCP server `computer_use` (`COMPUTER_USE_MCP_SERVER_NAME`). Unix socket `driver.sock`; macOS runs daemon in "embedded" mode so Accessibility/Screen-Recording grants attribute to OpenBot. UI overlay/rim in `src/main/computer-use-highlight-window.ts`. Remote desktop is separate: `vendor/remote-desktop` (Sunshine/Moonlight) + `src/main/sunshine-moonlight-runtime.ts`.

---

## 4. Agent ↔ agent messaging

Everything flows through the **mailbox**; there is no direct agent→agent channel.

- **Send:** an agent (via `openbot.send_message` tool) → `openbot-tool-router.ts:678-727` → `mailbox.enqueue({ sender:{kind:"agent",agentId}, recipientAgentIds, text, replyToMessageId, expectsReply, idempotencyKey })`. Fan-out: one message, N deliveries.
- **Wake:** each recipient gets `mailboxSync.emitQueue` + `drain.scheduleDrain`.
- **Reply:** a turn that finishes while running deliveries from agent senders calls `TurnLifecycle.#relayAgentResult` (`turn-lifecycle.ts:565`) → auto-`enqueue` an answer back to the original requester with `idempotencyKey: auto-result:<turnId>:<messageId>` and `expectsReply:false`.
- **Fan-in:** `MailboxStore.repliesToStartWith` + `#isHeldReply` (`mailbox-store.ts`) hold an answer until all teammates answering the same request are done, so the requester reads all answers in **one turn** (`drain-scheduler.ts` `companions` batching).
- **Chain origin / echo suppression:** `chainOriginAgentId`, `expectsReply`, `hasReplyFrom`, `hasAgentMessageFromTurnTo` (`mailbox-store.ts`) stop reply loops.
- **Cancel/interrupt:** `openbot.interrupt_agent` (`agent/agent-interrupt-tool.ts`) — a delegating agent can stop only a turn it fully owns (`ownedBy`: every delivery of the turn is from the caller), and only if not self, not channel work; then notifies the target with an `expectsReply:false` message.
- **Delivery gate:** `mailbox-delivery-gate.ts` serializes prepare/validate per agent to avoid races.

---

## 5. Queue / compaction / context monitoring

**Queue drain (`agent/drain-scheduler.ts`).** Per-agent, one turn at a time. `mayDrain(agentId)` is a *composition* — each controller owns one `mayDrain` clause: no active turn, channel, profile-save, duplication, compaction, routines. `#heldByMachine` adds machine-level holds: `MemoryHold.mayDrain` (turn/memory budget) and `TurnSlots` (concurrency slots, `agent/turn-slots.ts`). A full slot parks the agent in `#slotWaiters` and retries when any drain ends. `startDelivery` claims deliveries *before the first await* and counts `#startingDeliveries` per provider so a CLI swap can't cut a delivery mid-start. `turn/start` timeouts are treated as "may have run" (no retry, wait for lifecycle events) — explicit anti-duplication.

**Compaction (`agent/context-compaction.ts`).** Watches `thread/tokenUsage/updated`; when `usedTokens/contextWindow ≥ 0.8` it marks pending. On next drain it `reserve()`s the thread, then calls provider `thread/compact/start` — compaction is a **real provider turn**, distinguished from the agent's own work via `claimTurn` (swallows its `turn/started`) / `isCompactionTurn` / `markCompacted`. Hysteresis: re-compact only after ≥ max(1024, 5% of window) token growth; 120 s timeout.

**Memory (`agent/memory-hold.ts`).** `reserveTurn()` synchronously before the first await so the next drain counts the turn's memory; released when no turn starts. Idle provider processes are released (`provider-runtime.ts` `PROVIDER_IDLE_RELEASE_MS = 10 min`, unassigned 60 s) and threads unloaded.

**Context reset** (separate mechanism): `CONTEXT_RESET_ITEM_TYPE` markers (`team-protocol/context-reset-v1.ts`).

---

## 6. Ten files worth stealing *ideas* from

1. `src/backend/openbot-database-schema.ts` — event-sourced append-only log + rebuilt projections; migrations assert contiguity and guard on the *stored SQL text* (not version) so replays are idempotent.
2. `src/backend/mailbox-store.ts` — one message → N deliveries fan-out with per-recipient queue order; `finishedEditOutcomes` hashing makes lost queue-edit responses idempotently confirmable.
3. `src/backend/agent/drain-scheduler.ts` — the drain guard as *composed per-controller clauses* (`mayDrain`), so each subsystem owns one reason to hold a queue; "claim before await" delivery accounting; timeout = don't-retry.
4. `src/backend/agent/turn-lifecycle.ts` — one notification router that turns a noisy provider stream into a settled conversation; refused-turn retry only when nothing was produced; drops empty placeholder answers.
5. `src/backend/agent/context-compaction.ts` — compaction as a *first-class provider turn* claimed from the same stream, with token-growth hysteresis.
6. `src/backend/agent/queue-controls.ts` — steer a queued message into the *running* turn via `turn/steer` (uses the turn's own model, not the agent's current one).
7. `src/backend/provider-drivers.ts` — a provider as a *driver* with a sign-in discriminant union (browser / cli-command / external / acp-authenticate) so each login type is a compile error at every call site if mishandled.
8. `src/backend/agent/provider-runtime.ts` — idle provider process release + per-agent "confined process" for workspace-only agents; restart with exponential backoff and a 3-strike stop.
9. `src/backend/agent/thread-lifecycle.ts` — versioned MCP "tool fingerprint" that forces a provider session replacement whenever the tool set changes (because providers ignore MCP changes on resume).
10. `src/backend/agent/openbot-tool-router.ts` — server-request routing for *host-side* tool namespaces (`openbot`, `openbot_browser`), with approval surfacing as a first-class request method, not a tool.

---

## 7. What we deliberately do differently (bench_bot)

- **No event-sourcing for the mailbox.** OpenBot's append-only `orchestration_events` + projection replay is powerful but heavy (whole-database text-substitution migrations, parity tests). bench_bot writes direct relational state; migrations are plain, non-replaying DDL.
- **One provider, not a seven-provider matrix.** We target a single CLI/RPC adapter shape; no per-provider `*CliInfo`/driver union, no managed-vs-system binary resolution, no provider-idle-process juggling.
- **Plain approval model.** No `AttentionRegistry` request-method zoo, no "Turbo" auto-approval policy; we keep a single explicit approval channel.
- **No Electron.** Backend stays a headless process; UI is a thin client. No `src/main`/`src/preload`/`src/renderer` split, no CDP-via-WebContents browser host.
- **Computer-use out of scope for v1.** Desktop control is a later plugin, not a bundled daemon with macOS grant attribution.
- **Threads/sessions:** keep the public↔external id split (it's the single most reusable idea here) but drop the in-memory snapshot/delta-buffer dual-write in favor of one source of truth.
- **Agent↔agent:** keep the mailbox fan-out + held-reply fan-in, but make `expectsReply`/idempotency keys first-class in the API rather than derived from message shape.
