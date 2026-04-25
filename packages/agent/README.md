# @claude-pool/agent

> Your team hits a Claude Code rate limit. claude-pool silently
> borrows an idle API key from a teammate and keeps going.

See the [full documentation](https://github.com/YOUR_ORG/claude-pool) for architecture, server setup, and all commands.

## Install

```bash
bun install -g @claude-pool/agent
```

Requires [Bun](https://bun.sh) ≥ 1.0.

## Quick start

```bash
# 1. Have a claude-pool server running (see repo README for server setup)

# 2. Register and start
export ANTHROPIC_API_KEY=sk-ant-api-…
claude-pool init   # enter server URL and AUTH_SECRET when prompted
claude-pool start  # Claude Code now routes through the pool
```

## Commands

| Command | Purpose |
|---|---|
| `claude-pool init` | First-time setup |
| `claude-pool start` | Start the agent daemon |
| `claude-pool stop` | Stop the agent daemon |
| `claude-pool status` | Your status + pool stats |
| `claude-pool pool` | All team members and their status |
| `claude-pool logs` | Tail agent logs |
| `claude-pool uninstall` | Full cleanup |

## License

MIT
