# Session instruction — bench_bot (learning build)

> Save this as `CLAUDE.md` in the project folder (or paste it as the first Claude Code message).

Build a new project from scratch called **bench_bot**.
It is a learning clone of the *product shape* of OpenBot / OpenMausBot:
a chat app with a roster of named bots, each with a thread, tools, and
optionally a computer. Different bots can run different harnesses.

Do **not** set up licensing, hosting, billing, GDPR, Kubernetes, or a company
story. Local docker compose or even just `pnpm dev` is enough.

## What to build

A messaging UI + a small kernel where:

- Bots are contacts.
- A message goes to one bot.
- That bot runs inside a Harness.
- Harnesses are swappable Services.
- Bots can delegate to other bots.

Example binding (config, not hardcoded):

- Orchestrator → Claude Code harness
- Finance → Prime Agent harness, a different model than Orchestrator
- Grok bot → Grok CLI harness
- Fallback / simple bots → our own generic agent loop

Harness surface we want parity with (OpenBot runs these; ours must be swappable):
Codex · Claude Code · **Grok CLI** · OpenCode · Gemini · Cursor — plus any custom
OpenAI-compatible endpoint and local servers (Ollama, LM Studio). Each bot picks its own
harness **and its own model**; that pairing is config, never hardcoded.

Formula: **Bot = identity + instructions + model + harness + tools**

## Architecture (DeepSeek-style, keep it small)

Everything outside the model is a Service.

```
hoster/
  kernel/       # tiny DI: register service, get service
  services/     # interfaces only
  providers/    # implementations
  harnesses/    # claude-code, prime-agent, generic-loop
  bots/         # yaml or json bot defs
  apps/
    api/
    web/
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

If Claude Code or Prime Agent CLIs are missing, **stub the harness**: log the prompt, return a fake stream, keep the interface real. The generic-loop harness must actually call an LLM if an API key exists (`.env`: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`).

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
5. Web UI: sidebar roster + thread + composer
6. Bot yaml + `harness` field on each bot
7. Delegation tool so orchestrator can ask finance
8. Stub or real claude-code / prime-agent adapters
9. Only then: a dumb computer pane (screenshot placeholder is fine)

**Stack:** TypeScript, pnpm, Vite + React, a small HTTP server (Hono or Fastify). SQLite is fine. No extra infra.

## Working rules

- Small commits.
- Interfaces before implementations.
- No god-object `AgentService`.
- If a reference file helps, note the path in the map doc and rewrite.
- Prefer a working generic loop over a perfect Claude Code integration.
- Stop and ask only if the target stack should change.

Start with **Phase 0**.
