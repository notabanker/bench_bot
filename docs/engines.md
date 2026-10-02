# Engines (harnesses)

A bot's `harness:` line in `bots/<id>.yaml` picks the program that runs it. bench_bot only uses
open-source engines. All three can use your **OpenCode Go** key (`OPENCODE_API_KEY` in `.env`).

| `harness:` | What runs | Install | Model ids |
|---|---|---|---|
| `generic-loop` | Our own loop inside bench_bot; calls OpenCode Go directly | nothing | `glm-5.3-flash`, `deepseek-v4-flash`, `kimi-k3`, … (only models on Go's `/chat/completions`) |
| `opencode` | The OpenCode program (MIT), started as `opencode acp` | see below | `opencode-go/kimi-k3`, `opencode-go/grok-4.7`, … |
| `prime-agent` | Prime Agent (MIT), started as `prime-agent --mode acp` | see below | `opencode-go/deepseek-v4-pro`, … |

The full list of OpenCode Go model ids: `curl https://opencode.ai/zen/go/v1/models`.

## Install on macOS

**OpenCode** — one of:

```bash
curl -fsSL https://opencode.ai/install | bash
npm i -g opencode-ai
```

**Prime Agent:**

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

bench_bot finds the programs on your `PATH` and in the usual install folders
(`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.opencode/bin`, …). If yours is
somewhere else, set `OPENCODE_PATH` or `PRIME_AGENT_PATH` in `.env` to the full path.

If a program is missing, its bots still answer — with a short stand-in reply that says how to
install it. Nothing crashes.

## How bench_bot runs them

- **One run = one fresh program start**, in the bot's own workspace folder. The recent chat
  history (last 20 messages) is sent along, so the bot remembers the conversation.
- **Model:** bench_bot picks the bot's `model` from the program's model menu (an exact id, or the
  same id after a `provider/` prefix). If it is not offered — usually because no key is set — the
  chat shows a warning and the program's default model is used.
- **Safety:** on macOS the program runs inside the macOS sandbox with bench_bot's folder limits
  (`docs/ARCHITECTURE.md` §7a). When the program asks "may I run this command / edit this file?",
  bench_bot answers with the safety rules: allowed things run without asking you; blocked things
  are refused and shown as a "Blocked" note in the chat.
- **OpenCode asks first:** bench_bot starts OpenCode with `permission: {bash: "ask", edit: "ask"}`
  (via `OPENCODE_CONFIG_CONTENT`), so every command and file edit goes through the safety rules.
  Without this, OpenCode runs commands without asking (found in testing: it ran `sudo whoami`).
- **Prime Agent never asks:** it runs its tools as Python code inside its own process, so the
  command block list cannot see them. Only the macOS sandbox (folder limits) protects there.
- **Teammates:** if the bot's `tools` include `list_bots` / `ask_bot`, the program gets a small
  bench_bot tool server (`apps/api/bin/mcp-bridge.mjs`, MCP over stdio) so it can ask other bots.
  It is authenticated with a one-time token that expires when the run ends.
- **Stop** sends the program a cancel request and ends it after 5 seconds if needed. When a run
  ends, bench_bot asks the engine to close the session first, then stops the program.
- **Prime Agent keeps a background service** (its own design: sessions survive a closed terminal).
  After bench_bot runs, `prime-agent status` shows it; `prime-agent shutdown` stops it. bench_bot
  does not stop it for you, because you may be using Prime Agent yourself at the same time.
- **Model ids:** OpenCode writes `opencode-go/kimi-k3`, Prime Agent `["opencode-go","kimi-k3"]`;
  bench_bot understands both, so bot files always use `opencode-go/<model>`. Without
  `OPENCODE_API_KEY`, Prime Agent does not offer the OpenCode Go models at all.

## Tested

- `generic-loop`: unit tests with a scripted model; real endpoint reached (401 with a wrong key).
- `opencode`: tested end to end against the real OpenCode 1.18.34 on Linux (cloud) with its free
  model; not yet on macOS, not yet with an OpenCode Go key.
- `prime-agent`: real Prime Agent 0.9.8 (Linux, cloud) installed with the official script: start,
  ACP handshake, model menu and Stop verified through bench_bot. No answer was tested, because the
  cloud has no OpenCode Go key. Not yet on macOS.
- Orchestrator (real OpenCode) → `list_bots` + `ask_bot` → Finance → answer back: verified end to
  end in the cloud (Finance gave its stand-in reply there).
