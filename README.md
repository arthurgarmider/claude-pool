# claude-pool

Transparent rate-limit failover for Claude Code. When you hit a 429, claude-pool transparently routes your next request through another credential in the pool so your session keeps moving.

## Status & scope

This project is in **early development** and currently targets a single use case: **a small, trusted group sharing the load across credentials they all consent to share.** Read the section below before you deploy it.

### About credential sharing and Anthropic's terms

The current implementation pools **personal Claude Code OAuth tokens**. Anthropic's [Usage Policy](https://www.anthropic.com/legal/usage-policy) and the Claude Code terms generally treat personal credentials as non-transferable and prohibit sharing them across users to circumvent rate limits. **Using claude-pool with personal Claude Code tokens across multiple users may violate those terms and put the underlying Anthropic accounts at risk of suspension or termination.**

You should only run claude-pool today if at least one of these is true:

- **You are the sole human user** and you are pooling credentials across machines that all belong to you (multi-device personal use).
- **Every credential owner in the pool has read this section and explicitly consented** to their token being used by other pool members, understanding the account-risk implications.
- **You have written confirmation from Anthropic** that your specific use case is acceptable.

If none of those are true, do not use this software.

A README cannot grant permission Anthropic hasn't given. This section exists to make sure you go in with full information, not to transfer responsibility to you.

### Roadmap toward a non-risky deployment mode

The architecture (proxy, lease manager, cooldown handling, audit log) is independent of the credential type. The intended next milestone is **API key mode**, where the pool distributes load across Anthropic API keys that the operator owns (org/team keys, Workspaces, etc.). Load-balancing across keys you legitimately own is not credential sharing and should fit cleanly within the standard API terms. Track or contribute via the issues.

---

## How it works

1. Every pool member installs an **agent** on their Mac
2. The agent runs a local reverse proxy that Claude Code talks through
3. A lightweight **server** tracks who is active and who is idle, holds encrypted tokens at rest, and arbitrates leases
4. When the proxy sees a 429, it borrows an idle credential from the server, retries, and benches the rate-limited credential for the duration the upstream asked for

## Quick Start

### Server

```bash
docker run -d \
  -p 3847:3847 \
  -e AUTH_SECRET=your-shared-secret \
  -e ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -v claude-pool-data:/data \
  your-org/claude-pool-server
```

`ENCRYPTION_KEY` (32 raw bytes, base64) is required. It encrypts every agent's
Claude Code token at rest using AES-256-GCM. **Store this key separately from
the database file** — anyone with both can decrypt every teammate's token.

If you ever lose the key, teammates re-register via `claude-pool init`; old
ciphertext rows are skipped silently on acquire.

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

### Server endpoints (HTTP)

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness probe |
| `/agents/register` | POST | Agent registers (or rotates) its token |
| `/agents/heartbeat` | POST | Agent reports active/idle |
| `/agents` | GET | Pool view (no tokens) |
| `/agents/:id` | DELETE | Remove an agent |
| `/agents/:id/cooldown` | POST | Bench an agent for `retryAfterSeconds` |
| `/credentials/available` | GET | Borrow a teammate's idle token |
| `/credentials/lease/:id` | DELETE | Release a lease (`?count=N` records usage) |
| `/credentials/lease/:id/cooldown` | POST | Bench the lender (lease 429'd) |
| `/audit` | GET | Per-lease history (filter `?agentId=`, `?since=`, `?limit=`) |

All routes require `Authorization: Bearer $AUTH_SECRET`.

## Architecture

- **Agent** — Mac daemon: local reverse proxy + heartbeat + credential extraction
- **Server** — Hono + SQLite: credential registry + presence tracker + lease manager
- **Proxy** — intercepts via `ANTHROPIC_BASE_URL`, swaps auth headers on 429

## Requirements

- macOS (agent)
- [Bun](https://bun.sh) runtime
- Claude Code (current implementation extracts the OAuth token from the macOS Keychain entry Claude Code writes)
- Docker (recommended for the server)

## Security model

- Tokens are encrypted at rest in the server's SQLite DB using AES-256-GCM under the operator-supplied `ENCRYPTION_KEY`. The plaintext token only exists in memory on the borrowing agent for the duration of a request.
- Every HTTP route requires a shared `AUTH_SECRET` bearer token, including `/health`. This is intentional: the server is not meant to be exposed to the public internet.
- The server logs lease activity (who borrowed from whom, request count, close reason) and exposes it via `/audit`. Operators of a pool should be transparent with members about this visibility.

This addresses *server-side* security only. It does not change anything about the upstream relationship with Anthropic — see *Status & scope* above.

## License

MIT

