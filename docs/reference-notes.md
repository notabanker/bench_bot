# Reference notes — non-OpenBot repos

Evidence gathered read-only from `/tmp/ref-openmausbot` (Apache-2.0, TS), `/tmp/ref-dsh`
(deepseek-ai/deepseek-harness, MIT, TS), `/tmp/ref-prime-agent` (PrimeIntellect, MIT, Rust).
`not found` marks anything not verifiable in the checked-out trees.

---

## 1. OpenMausBot — `/tmp/ref-openmausbot`

**(1) What it is + stack.** A local-first desktop chat app ("your own team of AI bots").
Each sidebar bot is a real agent — the `claude` / `codex` / `grok` CLIs running locally —
with its own model, cloud computer, and connected apps. Stack: TypeScript strict, React 19,
Electron (macOS/Windows/Ubuntu), one harness server on `127.0.0.1`, Node ≥24, pnpm. State in
`~/.openmausbot`. Not affiliated with xAI.

**(2) Service/abstraction boundaries.**
- Interfaces: `server/contracts.ts` — `ProviderDriver` (SPI, a plain record: `driverKind`,
  `metadata`, `decodeConfig`, `defaultConfig`, `models`, `create()`), `ProviderInstance`,
  `ProviderAdapter` (`sendTurn`/`interruptTurn`/`respondToRequest`/`steer`/`onEvent`/
  `stopAll`/`hasSession`), `ProviderSnapshot`, `EngineInstall`, `ModelCatalog`.
- Implementations: `server/drivers/*` — one file per engine (`claude.ts`, `codex.ts`,
  `grok.ts`, `cursor.ts`, `openai-compat.ts`, `openai-chat.ts`, `acp/core.ts`, …).
- Registry: `server/harness/registry.ts` — `ProviderRegistry` maps config → live instances;
  unknown driver or decode failure becomes an "unavailable shadow snapshot" instead of a
  startup failure (forward/backward-compatible settings). Event bus: `server/harness/bus.ts`,
  HTTP carrier `server/harness/http.ts`.
- Capability flags: `ProviderAdapter.capabilities` (`server/contracts.ts:264`) — `agentsMcp`,
  `computerMcp`, `images`, `queueing`, `strictResume`, `hooks`, etc. The harness gates every
  UI control/tool offer on these so a bot is never told it has a tool its engine can't mount.

**(3) Model/CLI invocation + streaming.**
- CLI drivers spawn a per-turn process via `server/procs.ts` (`spawnCli`/`execCli`/`killCliTree`,
  private POSIX group). `server/drivers/claude.ts` streams JSON both directions: prompt over
  stdin, completion from a `result` event, conversation continued across turns with
  `--resume <sessionId>` (the `resumeCursor`).
- API drivers (`server/drivers/openai-compat.ts` → `openai-chat.ts`) use SSE chat-completions
  with transcript replay; `openai-compat.ts` targets OpenRouter/Groq/Together/llama.cpp.
- Output is normalized to one event union: `shared/runtime-events.ts` (`content.delta`,
  `item.started/completed`, `turn.started/completed`, `request.opened/resolved`,
  `runtime.error`, …) delivered through `adapter.onEvent(listener)`. Raw provider messages are
  tee'd verbatim to a redacted ndjson file for drift diagnosis (`server/drivers/native.ts`).

**(4) Tools / sessions / multi-agent.**
- Tools = MCP servers handed to the engine as descriptors in `SendTurnInput.integrations`
  (`contracts.ts:180`): `composio`, `computer`, `localComputer`, `browser`, `phone`, `agents`,
  `custom` (stdio or HTTP). Registration/validation in `server/mcp-registry.ts`, gating in
  `server/mcp-gate*.ts`. Team tools in `server/drivers/agents-catalog.ts`
  (`coordinate_bots`/`ask_bot`/`delegate_bot`).
- Sessions: per-thread native session keyed by `resumeCursor` (`server/sessions.ts`,
  `server/resume-recovery.ts`, `thread-events.ts`); mid-turn input via `steer()` (tri-state
  `steered/refused/indeterminate`); `interruptTurn()` aborts.
- Multi-agent/delegation: `server/room-handoffs.ts`, `server/delegations.ts`,
  `server/peer-roster.ts`/`peer-delivery.ts`, room routing `server/decider/room-routing.ts`.

**(5) Three ideas worth adopting.**
1. Driver-as-record SPI + capability flags (`server/contracts.ts` `ProviderAdapter.capabilities`)
   — declare what a harness can do; gate every offer on it.
2. Shadow snapshots for unknown/broken drivers (`server/harness/registry.ts`) — never brick a
   config or crash on decode failure; surface "your CLI is broken, pick another".
3. One canonical event union + raw ndjson tee (`shared/runtime-events.ts`,
   `server/drivers/native.ts`) — normalized events for the UI, verbatim redacted raw for protocol drift.

---

## 2. DeepSeek Harness (dsh) — `/tmp/ref-dsh`

**(1) What it is + stack.** DeepSeek AI's open-source agent harness, "everything-is-a-plugin"
on the Cordis framework (spatiotemporal composability). MIT. Node (≥22.19/24) + pnpm workspaces,
`packages/*/*` + `native/system` + `apps/*` + `python/`. Ships `web`/`headless`/`sdk`/`acp`
profiles composed from bundles.

**(2) Service/abstraction boundaries.** A **seam** = Service Definition (interface) + Service
Provider (implementation) + Consumer, per `docs/architecture.md` ("Capability seams"). Core:
- `packages/core/session` — append-only `SessionEvent` log + in-memory store (`ctx.sessions`).
- `packages/core/tools` — scoped tool registry + guarded execution pipeline (`ctx.tools`).
- `packages/core/agent` — `Agent` interface + live registry (`ctx.agents`).
- `packages/core/agent-loop` — `ReactLoopAgent`, default driver of that interface.
- `packages/llm/llm` — message/stream vocabulary + adapter seam (`ctx.llm`).
Interface-vs-impl pairs are directories: `llm/llm` (abstract `LlmAdapter`) vs
`llm/llm-deepseek`/`llm-pi-ai`/`llm-retry`; `fs/fs` vs `fs/fs-local`/`fs-ssh`; `sandbox/sandbox`
vs `sandbox-local`/`sandbox-ssh`/`sandbox-windows-acl`; `shell/shell` vs `bash-local`/`bash-sandbox`;
`subagent/subagent` vs `subagent-claude-code`/`-codex`/`-acp`/`-fork-in-process`.

**(3) Model invocation + streaming.**
- Seam: `packages/llm/llm/src/index.ts` — abstract `LlmAdapter` with ONE required method
  `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`; everything else optional
  (`providerInfo`, `listModels`, `resolveModel`, `prepareCall`, retry policy).
- `LlmRuntime.registerAdapter(providers, adapter)` registry; `prepareCall` binds exact-model
  metadata + dispatch to one adapter generation (HMR-safe). `llm/stream` waterfall intercepts.
- Chunk protocol `packages/llm/llm/src/types.ts` `StreamChunk`: `block-start`, `text-delta`,
  `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, terminal `finish` with
  `FinishReason` (`stop|tool-calls|max-tokens|aborted|error`). `signal?: AbortSignal` on every
  request; adapter throws normalize to a terminal `error`/`aborted` finish chunk.
- Loop: `packages/core/agent-loop/src/agent.ts` `ReactLoopAgent` — turn → step →
  `prepareCall` → stream chunks → `executeToolCalls` (`tool-calls.ts`); turn flow diagram in
  `docs/architecture.md`.

**(4) Tools / sessions / delegation.**
- Tools: `packages/core/tools/src/types.ts` `ToolSchema` (name/description/JSON-schema,
  `deferLoading`), `ctx.tools` registry; guarded pipeline `tools/pre-execute → execute →
  post-execute → tool/result`. Tool set may change mid-conversation via `tool-addition`/
  `tool-removal` developer blocks (`types.ts` `ToolUpdate = 'in-history'|'addition-only'`).
- Sessions: `packages/core/session` append-only log; persistence `session-persistence-jsonl`;
  explicit format migrations `session-format-vN-to-vN+1` (v0→v1…v3→v4); `fork.ts`; invariant
  "model-visible means logged".
- Delegation: `packages/subagent/subagent` + `tool-subagent`/`tool-subagent-control`; providers
  per engine (claude-code, codex, acp, dsh-sdk, fork-in-process, spawn-in-process). Experimental
  `experimental/agent-team`.

**(5) Three ideas worth adopting.**
1. One-method adapter seam — `abstract stream(options): AsyncIterable<StreamChunk>`
   (`packages/llm/llm/src/index.ts`) keeps provider adapters tiny; registry + optional methods
   add catalog/retry/model-resolution without widening the core contract.
2. `prepareCall` binds capability resolution + dispatch to one immutable generation
   (`index.ts:936`) — prevents a config reload from mixing one adapter's metadata with another's endpoint.
3. Session as append-only event log with a versioned migration chain
   (`packages/session/session-format*`) — durable source of truth; replay/UI/telemetry all derive
   from the same log.

---

## 3. Prime Agent — `/tmp/ref-prime-agent`

**(1) What it is + stack.** A self-improving coding/research agent built around the Recursive
Language Model (RLM) — context as variables, tools (incl. recursive subagents) as function calls
inside a persistent Python REPL — plus a Continual Harness storing prompts/memories/skills as
durable state. Rust workspace (edition 2021, `unsafe_code = "forbid"`, MIT): `pa-telemetry`,
`pa-types`, `pa-ai`, `pa-models`, `pa-agent`, `pa-core`, `pa-daemon`, `pa-tui`, `pa-cli`.

**(2) Service/abstraction boundaries.**
- `pa-types` — shared types (`ai/*`, `session`, `daemon`, `goal`, `usage`).
- `pa-ai` — streaming provider layer: `crates/pa-ai/src/providers/*` (anthropic, bedrock, google,
  mistral, openai_completions, openai_responses, openai_codex_responses, faux) behind a registry
  (`crates/pa-ai/src/registry.rs`), plus `stream.rs`, `types.rs`.
- `pa-agent` — the loop: `agent.rs` (`Agent`), `agent_loop/*` (`entry`, `run`, `tools`,
  `tool_call`, `response`), `stream.rs` (`StreamFn`, `ModelStream`, `AssistantMessageEvent`).
- `pa-core` — the engine: `session_engine/*` (engine, messages, provider_adapter, tool_bridge,
  compaction, rlm_host, agent_messaging), `kernel/*` (Python REPL manager), `tools/*`, `mcp/*`,
  `models/*`, `skills/*`.
- Crate boundary crossed **by wire-shape**: `pa-core/src/session_engine/provider_adapter.rs`
  `json_round_trip()` converts pa-agent ↔ pa-ai types through serde JSON so the loop never depends
  on provider types.

**(3) Model invocation + streaming.**
- Loop calls a `StreamFn` (from `pa-agent/src/stream.rs`) yielding `AssistantMessageEvent`
  (`Start`, `Text*`, `Thinking*`, `ToolCall*`, terminal `Done`/`Error` with `StopReason`).
- `provider_adapter.rs` `stream_once()` builds a `pa_ai::Context` + `SimpleStreamOptions`, calls
  `pa_ai::stream_simple`, and pumps each provider event into the loop's `ModelStream` via an
  `event_stream()` forwarder. Abort = `CancellationToken` in stream options + `ModelStream::close()`
  cancelling the in-flight fetch; Drop also cancels.
- Live model/provider switch: `switchable_stream_fn` reads a shared `ProviderTarget` slot — the
  daemon's `set_model` and provider failover swap the slot without rebuilding the session.

**(4) Tools / sessions / delegation.**
- Tools: `pa-core/src/tools/*` (`bash`, `bash_guard`, `edit`, `edit_diff`, `ipython`,
  `tool_definition.rs`); model-facing contract `ToolDefinition` (name/schema/description +
  `ExecutionMode::Sequential`, `ToolContentBlock`, `ToolUpdate`). Registered as
  `Vec<Arc<dyn AgentTool>>` in `Agent` (`agent.rs`); batch execution in `agent_loop/tools.rs`
  (sequential/parallel, per-tool prepare/finalize, before/after hooks).
- Sessions: `pa-core/src/session/*` (`tree.rs`, `window.rs`, `manager/`), daemon-backed
  (`pa-daemon`), compaction, persistent goals, heartbeats; snapshot/restore in `kernel/*`.
- Delegation: RLM subagents — the kernel is a JSON-lines subprocess `python -m rlm.repl`
  (`kernel/manager/mod.rs`, `kernel/protocol.rs`); `rlm.spawn`/`create_session` run through
  `pa-daemon/src/rlm_children.rs` (implements the `RlmSubagentHost` seam) with **one supervised
  worker process per child**; roster via `rlm.list_subagents`/`collect`/`delete_subagent`;
  agent-to-agent messaging in `pa-core/src/session_engine/agent_messaging.rs`.

**(5) Three ideas worth adopting.**
1. Cross-layer decoupling by wire-shape JSON round-trip, not shared types
   (`pa-core/src/session_engine/provider_adapter.rs` `json_round_trip`) — model layer and loop
   evolve independently.
2. Provider/model as a swappable slot (`ProviderTarget` + `switchable_stream_fn`) — live model
   switch and provider failover with no session rebuild.
3. Subagents as first-class supervised children: `rlm.spawn` → one worker process per child +
   roster/collect/delete (`pa-daemon/src/rlm_children.rs`) — isolation and lifecycle per subagent.

---

## Harness contract — proposed single interface

Synthesized from the three repos; each requirement cites its evidence.

- **start / send.** A turn starts with an already-bound call. Evidence: OMB
  `ProviderAdapter.sendTurn(input: SendTurnInput) → TurnStartResult`
  (`server/contracts.ts:344`); dsh `Agent.send/followup/steer/inject` + `llm.prepareCall`
  (`packages/core/agent-loop/src/agent.ts:154`, `packages/llm/llm/src/index.ts:936`); PA
  `StreamFn` + `Agent::continue_run` (`pa-agent/src/agent.rs`, `stream.rs`). → `start(input)`
  must resolve model + tools + adapter BEFORE any model-visible input is committed (dsh
  `prepareRequest`, PA `switchable_stream_fn`).

- **streaming events.** A canonical chunk/event union with text delta, reasoning delta,
  tool-call delta, usage, and a terminal finish/stop-reason. Evidence: OMB `RuntimeEvent`
  (`shared/runtime-events.ts`); dsh `StreamChunk` + `FinishReasonMap`
  (`packages/llm/llm/src/types.ts:452`); PA `AssistantMessageEvent` + `StopReason`
  (`pa-agent/src/stream.rs:31`). → `send()` returns an async iterable of these chunks; provider
  throw must normalize to a terminal `error`/`aborted` chunk, never propagate raw (dsh
  `adapterFailureChunk`, PA stream contract comment).

- **tool calls.** Schema-in / call-out / result-in + an approval/question round-trip. Evidence:
  OMB `integrations` MCP descriptors + `respondToRequest(behavior: allow|deny|answer)`
  (`server/contracts.ts:180,351`); dsh `ToolSchema` + `tools/pre-execute→execute→post-execute`
  (`packages/core/tools`, `agent-loop/src/tool-calls.ts`); PA `ToolDefinition` +
  `ExecutionMode` + before/after hooks (`pa-core/src/tools/tool_definition.rs`,
  `pa-agent/src/agent_loop/tools.rs`). → harness needs `tools: ToolSchema[]` on request, emits
  `tool-call` chunks, accepts `tool-result` messages, and can suspend on a permission/question
  `request.opened` → `request.resolved`.

- **abort / cancel.** Idempotent, reaches the transport, settles the stream with an
  `aborted` reason. Evidence: OMB `interruptTurn(threadId, turnId?)` + `stopAll()`
  (`server/contracts.ts:345,377`); dsh `Agent.cancel(AgentCancelCause)` + `AbortController` on
  the phase (`agent-loop/src/agent.ts:175`); PA `CancellationToken` + `ModelStream::close()`
  cancelling the in-flight fetch now (`provider_adapter.rs:530`). → `abort(id)` must be
  signal-driven and safe to call twice; a settled abort records zero usage.

- **resume.** Either resume-by-cursor into a live native session or rebuild-from-durable-log;
  the two must be distinguishable. Evidence: OMB `resumeCursor` + `strictResume` +
  `recoveryText`/`recoveryIsReplay` + `sessionReset` (`server/contracts.ts:107-154`,
  `server/resume-recovery.ts`); dsh append-only session log with `open`/`fork` + format
  migrations (`packages/core/session`); PA session manager + kernel snapshot/restore + daemon
  `--resume`/`attach` (`pa-core/src/session/*`, `pa-core/src/kernel/state_snapshot.rs`). →
  `resume(id)` returns either an in-session cursor or a replay of prior turns; a provider that
  rejects the cursor must fall back to replay, never a blank session.

- **capability declaration.** The harness must declare what it can do so the caller never offers
  an unsupported control. Evidence: OMB `ProviderAdapter.capabilities` flags
  (`server/contracts.ts:266`); dsh `LlmResolvedModelInfo` (`systemPromptUpdate`, `toolUpdate`,
  `inputModalities`) (`packages/llm/llm/src/types.ts:410`); PA `ThinkingLevel` +
  `ToolExecutionMode` (`pa-types`, `tool_definition.rs`).

- **usage accounting.** Every terminal event reports token usage, never summed across drivers.
  Evidence: OMB `turn.completed.usage` + `thread.token-usage.updated` (`runtime-events.ts:71,157`);
  dsh `TokenUsage` disjoint cache fields (`types.ts:175`); PA `Usage` in `AssistantMessage`
  (`pa-agent/src/types.rs`, `provider_adapter.rs` tests).

- **mid-turn steer.** Optional; only harnesses that keep a live session expose it. Evidence: OMB
  `steer()` gated on `capabilities.queueing` with tri-state outcome (`server/contracts.ts:364`);
  dsh `agent.steer()` → `next-step` inbox target (`agent-loop/src/agent.ts:167`); PA kernel
  `steer`/follow-up queues (`pa-agent/src/agent.rs`). `not found` in dsh/PA: a formal tri-state
  "refused vs indeterminate" steer result equivalent to OMB's `SteerOutcome`.

**Not verified:** exact wire bytes of dsh's `native/system` flock/launcher binary (build artifact
machinery, out of scope); OMB's `grok.ts`/`cursor.ts` ACP message framing (ACP spec lives in
`server/drivers/acp/core.ts`, not re-derived here).
