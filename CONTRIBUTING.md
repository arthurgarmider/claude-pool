# Contributing to claude-pool

Thanks for your interest in claude-pool. This project moves fastest when
contributors and maintainers agree on scope before code gets written, so the
flow below is short and friendly:

## Before you open a PR

1. **Open an issue first.** Even a one-paragraph "I'm thinking of working on
   X — does this make sense?" is enough. It saves you from a "thanks but no"
   after writing the code.
2. **Match an existing issue** if one is already open. Comment to claim it.
3. **Good first issues** are labelled `good first issue`. Start there.

## Local development

```bash
# 1. Clone
git clone https://github.com/arthurgarmider/claude-pool.git
cd claude-pool

# 2. Install (requires Bun — https://bun.sh)
bun install

# 3. Run the tests
bun test
```

The repo is a workspace with two packages:

- `packages/server` — the central pool service (runs in Docker)
- `packages/agent`  — the per-developer daemon and CLI

## Commit & PR style

- One logical change per PR. Multi-feature PRs are hard to review.
- Commit messages: `area(scope): short imperative summary`
  - `feat(server): per-developer quotas`
  - `fix(agent): handle 429 with no retry-after header`
  - `docs(readme): clarify VPN deployment`
- Reference the issue in the PR description (`Closes #123`).
- Make sure `bun test` passes before pushing.

## Code style

- TypeScript, strict mode, no `any` without a comment explaining why.
- No new dependencies without justification in the PR.
- New endpoints get an entry in the README's Server API table.
- New CLI commands get an entry in the README's Commands table.

## Security

If you find a security issue, please **do not** open a public issue. Email
the maintainer (see `SECURITY.md`) instead.

## Scope

claude-pool is intentionally small. It does one thing — pool Anthropic API
credentials with transparent 429 failover — and aims to do it well. Features
that broaden the scope (other LLM providers, generic load balancing, hosted
SaaS) are not on the roadmap. A fork is the right answer for those.

## License

By contributing, you agree your contributions will be licensed under the
project's MIT License.
