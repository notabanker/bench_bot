# bots

One YAML file per bot. The file name is the bot's id (`finance.yaml` → `finance`).
`Bot = identity + instructions + model + harness + tools`.

```yaml
name: Finance                 # shown in the roster (required)
description: One line about what this bot is for. Other bots read it to decide whom to ask.
instructions: |               # the bot's system prompt (required)
  You are …
harness: prime-agent          # generic-loop | opencode | prime-agent (required)
model: opencode-go/deepseek-v4-pro   # optional; default: BENCH_DEFAULT_MODEL or glm-5.3-flash
tools: [fs_read, fs_write, fs_list, list_bots, ask_bot]   # optional
section: Team                 # optional sidebar group
workspace: finance            # optional; folder under <data>/workspaces, or an absolute path
```

Model ids:

- `generic-loop` talks to OpenCode Go directly: plain ids such as `glm-5.3-flash`,
  `deepseek-v4-flash`, `kimi-k3`. Only models on OpenCode Go's `/chat/completions` endpoint work
  here (not Grok or MiniMax).
- `opencode` and `prime-agent` use provider-qualified ids such as `opencode-go/kimi-k3`.

Edits take effect with the next message; no restart needed. A broken file is skipped and shown as
a warning in the app.

The starter bots below are **defaults — adjust them freely**.
