# claude-pool server

Self-hosted server for [claude-pool](https://github.com/arthurgarmider/claude-pool) — transparent rate-limit failover for Claude Code teams.

## What it does

When a teammate hits a Claude Code 429, this server arbitrates leases so the agent can borrow an idle API key from another teammate and keep the session moving.

- Encrypted credential storage at rest (AES-256-GCM)
- Lease + cooldown arbitration
- Per-lease audit log
- SQLite-backed, no external database

## Quick start

```bash
curl -O https://raw.githubusercontent.com/arthurgarmider/claude-pool/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/arthurgarmider/claude-pool/main/.env.example
cp .env.example .env
# Edit .env — set AUTH_SECRET and ENCRYPTION_KEY (use `openssl rand -base64 32` for each)
docker compose up -d
```

## Tags

- `latest` — newest stable release
- `0.1.x` — pinned versions

Multi-arch: `linux/amd64`, `linux/arm64`.

## Documentation

Full architecture, agent setup, and security model: <https://github.com/arthurgarmider/claude-pool>

## License

MIT
