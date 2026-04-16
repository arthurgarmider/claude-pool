# claude-pool

Transparent Claude Code quota pooling for teams. When you hit your rate limit, claude-pool automatically borrows an idle teammate's credentials and retries — your session continues seamlessly.

## How it works

1. Every team member installs an **agent** on their Mac
2. The agent runs a local proxy that Claude Code talks through
3. A lightweight **server** tracks who's active and who's idle
4. When you hit a 429, the proxy fetches idle credentials from the server and retries

## Quick Start

### Server

```bash
docker run -d \
  -p 3847:3847 \
  -e AUTH_SECRET=your-shared-secret \
  -v claude-pool-data:/data \
  your-org/claude-pool-server
```

### Agent (each developer)

```bash
bun install -g @claude-pool/agent
claude-pool init     # enter server URL + secret
claude-pool start    # starts the agent daemon
```

### Commands

| Command | Purpose |
|---|---|
| `claude-pool init` | First-time setup |
| `claude-pool start` | Start the agent daemon |
| `claude-pool stop` | Stop the agent daemon |
| `claude-pool status` | Your status + pool stats |
| `claude-pool pool` | All team members and their status |
| `claude-pool logs` | Tail agent logs |
| `claude-pool uninstall` | Full cleanup |

## Architecture

- **Agent** — Mac daemon: local reverse proxy + heartbeat + credential extraction
- **Server** — Hono + SQLite: credential registry + presence tracker + lease manager
- **Proxy** — intercepts via `ANTHROPIC_BASE_URL`, swaps auth headers on 429

## Requirements

- macOS
- [Bun](https://bun.sh) runtime
- Claude Code
- Docker (for server)

## License

MIT
