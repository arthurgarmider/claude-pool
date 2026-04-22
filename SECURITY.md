# Security Policy

## Scope

claude-pool handles sensitive material by design: Claude Code OAuth tokens
(or Anthropic API keys, in future deployment modes), a shared `AUTH_SECRET`,
and an `ENCRYPTION_KEY` used for AES-256-GCM at-rest encryption. Classes of
issue that matter most:

- Token disclosure or recovery (logs, error traces, audit output, API
  responses, backup files, network captures).
- Encryption weaknesses (key derivation, nonce handling, migration paths).
- Authentication or authorization bypass on the server's HTTP surface.
- Privilege escalation between pool members (one agent extracting another
  agent's token or lease when it shouldn't).
- Denial of service that is cheap to trigger and expensive to recover from
  (cooldown amplification, lease exhaustion, DB corruption).

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Instead, report privately via one of:

- GitHub's private security advisory feature on this repository (preferred),
  under the *Security* tab → *Report a vulnerability*.
- Email the maintainer directly if you have a working address.

Include:

- A description of the issue and its impact.
- Reproduction steps or a proof-of-concept (minimal is fine).
- The commit SHA or release tag you reproduced against.
- Whether you intend to disclose publicly and on what timeline.

## What to expect

- Acknowledgement within 3 business days.
- An initial assessment within 7 days.
- Coordinated disclosure: a fix will be developed privately, released, and
  then credited (if you'd like credit) in the release notes.

## Out of scope

- The upstream relationship between the pool operator and Anthropic. See
  the *Status & scope* section in the README — credential-sharing risk
  under Anthropic's usage terms is an operational concern, not a software
  vulnerability in this repo.
- Issues requiring physical access to an agent's machine or root access to
  the server host.
- Attacks requiring a malicious party to already hold `AUTH_SECRET` *and*
  `ENCRYPTION_KEY`. Those are the trust anchors; compromise of both is
  equivalent to compromise of the pool.
