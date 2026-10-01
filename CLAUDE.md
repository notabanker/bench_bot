# Session instruction — bench_bot (learning build)

> Save this as `CLAUDE.md` in the project folder (or paste it as the first Claude Code message).

Build a new project from scratch called **bench_bot**.
It is a learning clone of the *product shape* of OpenBot / OpenMausBot:
a chat app with a roster of named bots, each with a thread, tools, and
optionally a computer. Different bots can run different harnesses.

Do **not** set up licensing, hosting, billing, GDPR, Kubernetes, or a company
story. `pnpm dev` is enough to run it; the app ships as an **Electron desktop app** from the
start (a thin shell around the same local server + React UI).

## What to build

A messaging UI + a small kernel where:

- Bots are contacts.
- A message goes to one bot.
- That bot runs inside a Harness.
- Harnesses are swappable Services.
- Bots can delegate to other bots.

Example binding (config, not hardcoded):

- Orchestrator → OpenCode harness
- Finance → Prime Agent harness, a different model than Orchestrator
- Grok bot → generic loop or OpenCode, with a Grok model from OpenCode Go (no separate Grok harness)
- Fallback / simple bots → our own generic agent loop

**Open-source harnesses only.** A harness is the program that runs a bot's turn. We only
integrate harnesses whose code is open source, so integration is easier and nothing
proprietary sits in the loop. The *models* behind them may still be closed (GPT, Grok, …).

| Harness | License | v1? |
|---|---|---|
| generic-loop (ours) | ours | **yes** — calls an OpenAI-compatible HTTP endpoint directly |
| OpenCode | MIT | **yes** — runs the `opencode` program |
| Prime Agent | MIT | **yes** — runs the `prime-agent` program |
| Codex CLI | Apache-2.0 | later |
| Gemini CLI | Apache-2.0 | later |
| Claude Code | proprietary ("All rights reserved") | **no** |
| Cursor CLI | not checked | not planned |

Default model source is **OpenCode Go** (subscription, `https://opencode.ai/zen/go/v1`).
The generic loop calls it directly with the Go key; the OpenCode harness uses the same key.
The same generic-loop code must also work with local servers (Ollama, LM Studio) later.
Each bot picks its own harness **and its own model**; that pairing is config, never hardcoded.

Formula: **Bot = identity + instructions + model + harness + tools**

## Architecture (DeepSeek-style, keep it small)

Everything outside the model is a Service.

```
bench_bot/
  kernel/       # tiny DI: register service, get service
  services/     # interfaces only
  providers/    # implementations
  harnesses/    # generic-loop, opencode, prime-agent
  bots/         # yaml or json bot defs
  apps/
    api/
    web/
    desktop/    # Electron shell around api + web
```

Minimum seams:

| Service | Does |
|---|---|
| llm | stream chat + tool calls |
| session | append-only event log for a thread |
| tool | register + run tools |
| harness | start/send/abort a bot run |
| delegation | list_bots + ask_bot |
| fs | read/write a per-bot workspace |

Add a scheduler only after chat + two harnesses work.

A harness implements:

```ts
interface Harness {
  id: string
  start(ctx: BotRunContext): Promise<void>
  send(msg: string): AsyncIterable<Event>
  abort(): Promise<void>
}
```

`BotRunContext` has bot id, workspace path, tool policy, model id, session log.

If the OpenCode or Prime Agent programs are missing, **stub the harness**: log the prompt, return a fake stream, keep the interface real. The generic-loop harness must actually call an LLM if a key exists (`.env`: `OPENCODE_API_KEY`, the OpenCode Go key; `LLM_BASE_URL` defaults to `https://opencode.ai/zen/go/v1` and can point at Ollama / LM Studio instead).

Caveat (per opencode.ai/docs/go, read 2026-09-30): Go serves most models on the OpenAI-style
`/chat/completions` endpoint, some on an Anthropic-style `/messages` endpoint, and Grok on a
`/responses` endpoint. The v1 generic loop speaks `/chat/completions` only; models on the other
endpoints go through the OpenCode harness until the loop learns them.

## Phase 0 — scan OpenBot, then stop and write a map

Clone read-only references outside this repo:

```bash
git clone --depth 1 https://github.com/nightly-labs/openbot.git /tmp/ref-openbot
git clone --depth 1 https://github.com/milind-soni/OpenMausBot.git /tmp/ref-openmausbot
# Optional if you want harness ideas:
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git /tmp/ref-dsh
# Required: this is the second harness we want to bind (Finance bot)
git clone --depth 1 https://github.com/PrimeIntellect-ai/prime-agent.git /tmp/ref-prime-agent
```

Read those trees. Write `docs/openbot-map.md`:

- folder map
- how a user message becomes a provider/CLI turn
- how agents, threads, tools, computer-use are represented
- how one bot talks to another
- 10 files worth stealing ideas from (path + one-line why)

Then write `docs/ARCHITECTURE.md` for bench_bot (our design, not a copy of theirs).

**Do not start app code before those two files exist.**

Do not copy their source, CSS, assets, or component trees. UI should feel like a chat roster (that part is the idea we like) but look different: denser, a bit like mail, our own colors and type.

## Implementation order

1. `docs/openbot-map.md` + `docs/ARCHITECTURE.md`
2. Kernel + service registry
3. Session log + generic-loop harness + one LLM provider
4. API: bots, threads, send message, SSE/stream events
5. Web UI: sidebar roster + thread + composer, opened inside the Electron shell (`apps/desktop`)
6. Bot yaml + `harness` field on each bot
7. Delegation tool so orchestrator can ask finance
8. Stub or real opencode / prime-agent adapters
9. Only then: a dumb computer pane (screenshot placeholder is fine)

**Stack:** TypeScript, pnpm, Vite + React, a small HTTP server (Hono or Fastify), Electron for the desktop shell. SQLite via Node's built-in `node:sqlite`. No extra infra.

## Working rules

- Small commits.
- Interfaces before implementations.
- No god-object `AgentService`.
- If a reference file helps, note the path in the map doc and rewrite.
- Prefer a working generic loop over a perfect OpenCode integration.
- Stop and ask only if the target stack should change.
- Safety: bots may do almost everything without asking, but never break the Mac or the app
  (folder limits + block list, refuse and note in chat). See `docs/ARCHITECTURE.md` §7a.

Phase 0 is done (see `docs/`), and Phases 1–12 of **`plan.md`** are built. The build follows `plan.md`,
phase by phase: finish a
phase, tick it off, commit, report in plain words, then **wait for the user's OK** before the next
phase. The user is partly technical: explain choices in plain language.
