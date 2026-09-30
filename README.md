# bench_bot

**EU-built, genuinely open-source alternative to OpenBot / OpenMausBot — same approach, our own code.**

A local-first workspace where named bots are contacts: each bot gets its own thread, its own
workspace, its own tools, and a **swappable harness** (Claude Code, Grok CLI, Prime Agent, or our
own generic agent loop). Bots can delegate to each other.

**Formula:** `Bot = identity + instructions + model + harness + tools`

## Status

Phase 0 — reference scan. No application code yet, by design.

- [x] `CLAUDE.md` — the build instruction (read this first)
- [ ] `docs/openbot-map.md` — architectural map of the reference project
- [ ] `docs/reference-notes.md` — OpenMausBot, deepseek-harness, prime-agent
- [ ] `docs/ARCHITECTURE.md` — our own design

## Why

- OpenBot and OpenMausBot are US-built. bench_bot is the EU one.
- OpenBot is **not** open source — it ships under PolyForm Noncommercial 1.0.0, which bars
  commercial use. bench_bot aims to be genuinely open source (MIT / Apache-2.0).
- Same product shape, different code, different UI. Read the references, never copy them.

## References (read-only, cloned to `/tmp` during Phase 0)

| Reference | License | Reuse code? |
|---|---|---|
| `nightly-labs/openbot` | PolyForm Noncommercial 1.0.0 | **No** |
| `milind-soni/OpenMausBot` | Apache-2.0 | with attribution |
| `deepseek-ai/deepseek-harness` | MIT | with attribution |
| `PrimeIntellect-ai/prime-agent` | check | check |

Clean-room rule: read the architecture, write our own. No source, CSS, assets or component trees.

## Intended layout

```
kernel/       tiny DI: register service, get service
services/     interfaces only
providers/    implementations
harnesses/    claude-code, prime-agent, generic-loop
bots/         yaml or json bot defs
apps/api/     HTTP + SSE
apps/web/     sidebar roster + thread + composer
```

## Working rules

Small commits · interfaces before implementations · no god-object `AgentService` ·
prefer a working generic loop over a perfect CLI integration. Full list in `CLAUDE.md`.
