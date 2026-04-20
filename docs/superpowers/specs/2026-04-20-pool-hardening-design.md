# claude-pool Hardening: Audit, Encryption, Lease Safety

**Date:** 2026-04-20
**Status:** Approved (design)
**Repo:** `~/git/startup/claude-pool`
**Supersedes:** none — extends `docs/...2026-04-14-claude-pool-design.md` (imported from the `claudctopus` brainstorming repo)

## Problem

The server today is good enough to prove the failover idea but is not yet trustworthy enough to put in front of a paying team:

1. **No audit.** Alice has no way to see that Bob's token saved her a rate limit, and Bob has no way to see how much his spare capacity contributed. The value the product delivers is invisible to the customer.
2. **Plaintext credentials at rest.** `agents.token` is stored as `TEXT` in SQLite. A single DB file leak exposes every teammate's Claude Code token.
3. **Race between acquirers.** `acquireCredential` does a SELECT then an INSERT without a transaction; two concurrent requests can both pick the same idle candidate. The LEFT JOIN filter is only effective against already-committed leases.
4. **No cooldown signal for 429'd credentials.** When the proxy borrows a credential and that credential *also* 429s, the lease is released — but nothing stops the next acquirer from getting the same exhausted credential 10 seconds later.

## Goals

Deliver one cohesive server-side hardening change that:

- **G1** — Records per-lease audit data (who used whose token, how many requests, how long) and exposes a `/audit` endpoint for both admin and self-service views.
- **G2** — Encrypts agent tokens at rest in the server's SQLite database with AES-256-GCM, using an operator-provided master key.
- **G3** — Eliminates the acquire race via a `BEGIN IMMEDIATE` transaction wrapping read-then-write in `acquireCredential`.
- **G4** — Introduces a pool-wide cooldown concept: when Anthropic returns 429 on a credential, the credential is benched for the duration Anthropic indicated (via `Retry-After`), and `acquireCredential` skips benched credentials.

All four goals share the same code paths (`store.ts`, `routes.ts`, `proxy.ts`) and the same migration step. They are delivered as one spec, one plan, one migration.

## Non-Goals (explicit)

- **Per-request event log** — audit is stored as one row per lease (per-lease aggregate). If forensic-level detail is ever needed, an `auditEvents` table can be added additively.
- **Per-agent API keys / stronger auth for `/audit`** — the server continues to use the single shared `AUTH_SECRET`. The `agentId` query param on `/audit` is trusted, matching the current posture of `POST /agents/heartbeat`. Auth hardening is a separate spec.
- **Tokens-consumed / cost estimation in audit** — only request count and lease duration are tracked.
- **Key rotation tooling** — rotating `ENCRYPTION_KEY` requires owners to re-register. A `rotate-key` command can be added later.
- **SQLCipher / whole-DB encryption** — rejected because Bun's bundled `bun:sqlite` does not ship SQLCipher and swapping the driver is a larger change than we need.
- **CLI surface for audit** — `/audit` endpoint only for v1; a `claude-pool audit` CLI command is deferred.
- **Client-side skip of own cooldowned token** — the owner's own proxy does not consult `agents.cooldownUntil` when deciding whether to try its own token. If the token is cooldowned, Anthropic will return 429 again and the proxy will mark-cooldown a second time. An optimization, not a correctness issue.

## Architecture

The four goals are a single coherent story because they all touch the same two tables and the same acquire/release flow:

```
┌──────────────────────────────────────────────────────────┐
│                   Server (Hono + SQLite)                 │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  store.ts                                          │ │
│  │                                                    │ │
│  │   registerAgent(payload)                           │ │
│  │     └─ encryptToken() → INSERT agents              │ │
│  │                                                    │ │
│  │   acquireCredential(requesterId)                   │ │
│  │     BEGIN IMMEDIATE                                │ │
│  │       existing lease? return it                    │ │
│  │       candidate = SELECT agent WHERE status=idle   │ │
│  │                     AND cooldownUntil < now        │ │
│  │                     AND no active lease            │ │
│  │                     AND agentId != requester       │ │
│  │       INSERT lease                                 │ │
│  │     COMMIT                                         │ │
│  │     └─ decryptToken() → return {token, leaseId}    │ │
│  │                                                    │ │
│  │   releaseLease(id, count)                          │ │
│  │     └─ UPDATE lease SET releasedAt, requestCount,  │ │
│  │                         closedReason='released'    │ │
│  │                                                    │ │
│  │   markLeaseCooldown(id, retryAfterMs, count)       │ │
│  │     └─ UPDATE agent SET cooldownUntil              │ │
│  │     └─ UPDATE lease SET closedReason='cooldown'    │ │
│  │                                                    │ │
│  │   markAgentCooldown(agentId, retryAfterMs)         │ │
│  │     └─ UPDATE agent SET cooldownUntil              │ │
│  │                                                    │ │
│  │   listAudit({agentId?, since?, limit})             │ │
│  │     └─ SELECT from leases JOIN agents              │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  crypto.ts                                         │ │
│  │   createCrypto(keyB64)                             │ │
│  │     ├─ encryptToken(plaintext) → {ct, nonce}       │ │
│  │     └─ decryptToken(ct, nonce) → plaintext         │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────┐
│                       Agent proxy                        │
│                                                          │
│   forward(req) → 429                                     │
│     │                                                    │
│     ├─ was borrowed credential?                          │
│     │    POST /credentials/lease/:id/cooldown            │
│     │       body: {retryAfterSeconds, count}             │
│     │                                                    │
│     ├─ was owner's own token?                            │
│     │    POST /agents/:id/cooldown                       │
│     │       body: {retryAfterSeconds}                    │
│     │    then fall through to failover                   │
│     │                                                    │
│     └─ on clean release: DELETE /credentials/lease/:id   │
│         ?count=N                                         │
└──────────────────────────────────────────────────────────┘
```

### Design principle continuity

Thin server, smart agent — unchanged from the original spec. The proxy owns Retry-After parsing, accumulating request counts, and deciding which cooldown endpoint to hit; the server owns storage, encryption, and enforcement.

## Data Model

### `agents` table — modified

```sql
CREATE TABLE IF NOT EXISTS agents (
  agentId TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  tokenCiphertext BLOB NOT NULL,
  tokenNonce BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  registeredAt INTEGER NOT NULL,
  lastHeartbeatAt INTEGER NOT NULL,
  lastActivityAt INTEGER NOT NULL DEFAULT 0,
  cooldownUntil INTEGER
);
```

- `tokenCiphertext` / `tokenNonce` replace the old plaintext `token TEXT` column. 12-byte nonce per encryption, random.
- `cooldownUntil`: `NULL` = not benched; else unix-ms timestamp at which cooldown ends. Compared to `Date.now()` inside the acquire transaction.

### `leases` table — modified

```sql
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  credentialAgentId TEXT NOT NULL,
  leasedTo TEXT NOT NULL,
  leasedAt INTEGER NOT NULL,
  ttl INTEGER NOT NULL,
  releasedAt INTEGER,
  requestCount INTEGER NOT NULL DEFAULT 0,
  closedReason TEXT,
  FOREIGN KEY (credentialAgentId) REFERENCES agents(agentId) ON DELETE CASCADE
);
```

- `releasedAt`: `NULL` = active; set when released, expired, or cooldowned.
- `requestCount`: final request count reported by the proxy; `0` if unknown.
- `closedReason`: `NULL` while active; `'released' | 'expired' | 'cooldown'` otherwise.

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_leases_active
  ON leases(credentialAgentId) WHERE releasedAt IS NULL;

CREATE INDEX IF NOT EXISTS idx_leases_audit
  ON leases(leasedTo, leasedAt DESC);
```

The partial `idx_leases_active` keeps the "is this agent currently lending?" check cheap even as the table grows into an append-mostly audit log. `idx_leases_audit` serves the self-scoped `/audit?agentId=X` query.

### Migration

On `createStore(dbPath, crypto)`:

1. Create the new tables (idempotent).
2. If the old-schema `agents` row has a `token` column (detected via `PRAGMA table_info`): for each row, read `token`, compute `encryptToken(token)`, write `tokenCiphertext` + `tokenNonce`, then `ALTER TABLE agents DROP COLUMN token`.
3. For the old `leases` table without the new columns: `ALTER TABLE leases ADD COLUMN releasedAt INTEGER`; same for `requestCount`, `closedReason`.

Bun's SQLite supports `ALTER TABLE ... DROP COLUMN` since SQLite 3.35; no rebuild needed.

## Encryption

### File: `packages/server/src/crypto.ts` — new

```ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto"
import { trace } from "@claude-pool/shared/src/trace"

export function createCrypto(keyB64: string) {
  const key = Buffer.from(keyB64, "base64")
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes after base64 decode")
  }

  const encryptToken = trace("crypto.encrypt", (plaintext: string) => {
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, nonce)
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return { ciphertext: Buffer.concat([ciphertext, tag]), nonce }
  })

  const decryptToken = trace("crypto.decrypt", (ciphertext: Buffer, nonce: Buffer) => {
    const tag = ciphertext.slice(ciphertext.length - 16)
    const ct = ciphertext.slice(0, ciphertext.length - 16)
    const decipher = createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
  })

  return { encryptToken, decryptToken }
}
```

### Wiring

`createStore(dbPath: string, crypto: ReturnType<typeof createCrypto>)` takes crypto as a second arg. No interface — it's the one implementation, the concrete return type travels.

Encryption happens inside `registerAgent`; decryption happens inside `acquireCredential`. The store's return type keeps `token: string` — callers never see ciphertext.

### Decrypt failure handling

If `decryptToken` throws during `acquireCredential`, the candidate is skipped and the transaction selects the next eligible agent. This covers:
- `ENCRYPTION_KEY` rotated without re-encryption
- Row corruption

The error is logged (via the `trace` wrapper) and surfaces as "no credentials available" only if every candidate fails to decrypt.

### Key lifecycle

- Provided via env var `ENCRYPTION_KEY` — 32 raw bytes, base64 encoded.
- Validated at server start; fail fast on wrong length.
- Generation documented in README: `openssl rand -base64 32`.
- Rotation is out of scope for v1. Workaround: teammates re-register via `claude-pool init`.

## Lease Lifecycle + Race Fix

### `acquireCredential` becomes transactional

Wrap the entire read-candidate-then-insert-lease sequence in `db.transaction(() => ...)`, which begins an `IMMEDIATE` transaction. SQLite serializes writers, so two concurrent `acquireCredential` calls cannot both pick the same idle candidate.

All three SELECTs (existing lease, fresh candidate, fallback) now filter on `cooldownUntil IS NULL OR cooldownUntil < :now` in addition to the existing conditions.

### Release changes from DELETE to UPDATE

`releaseLease(leaseId, requestCount)`:
```sql
UPDATE leases
   SET releasedAt = :now,
       requestCount = :count,
       closedReason = 'released'
 WHERE id = :leaseId AND releasedAt IS NULL;
```

The `WHERE releasedAt IS NULL` guard makes repeated release calls no-ops instead of stomping a prior close.

### `expireLeases` changes analogously

```sql
UPDATE leases
   SET releasedAt = :now,
       closedReason = 'expired'
 WHERE releasedAt IS NULL AND (leasedAt + ttl) < :now;
```

### Request-count propagation

The proxy tracks `requestCount` in memory per cached credential (incremented on every successful forward). On release it sends `DELETE /credentials/lease/:id?count=N`. The server parses `count` as an int ≥ 0; absent or invalid → treat as 0.

## 429 Cooldown

### Proxy changes

When a forwarded request returns 429:

- Parse `Retry-After` response header: integer seconds per RFC 7231. Absent/malformed → 0.
- If the 429 came from a **borrowed** credential (failover path):
  ```
  POST /credentials/lease/:id/cooldown
  body: { retryAfterSeconds, count }
  ```
  instead of `DELETE /credentials/lease/:id`.
- If the 429 came from the **owner's own** token (original request, pre-failover):
  ```
  POST /agents/:id/cooldown
  body: { retryAfterSeconds }
  ```
  Then proceed into the failover loop as today.

### Server enforcement

`markLeaseCooldown(leaseId, retryAfterMs, count)`:
- `UPDATE agents SET cooldownUntil = :now + :retryAfterMs WHERE agentId = (SELECT credentialAgentId FROM leases WHERE id = :leaseId)`
- `UPDATE leases SET releasedAt = :now, requestCount = :count, closedReason = 'cooldown' WHERE id = :leaseId AND releasedAt IS NULL`

`markAgentCooldown(agentId, retryAfterMs)`:
- `UPDATE agents SET cooldownUntil = :now + :retryAfterMs WHERE agentId = :agentId`

Default cooldown if `retryAfterSeconds === 0`: `DEFAULTS.DEFAULT_COOLDOWN_MS = 60_000`. Overridable via `DEFAULT_COOLDOWN_MS` env.

### Expiry

No cleanup job. `acquireCredential` filters `cooldownUntil < now` inline — expired cooldowns are automatically invisible. `cooldownUntil` stays in the row as a cheap historical trace.

## Audit

### `GET /audit`

Query params:
- `agentId?: string` — if present, scope to rows where `leasedTo = agentId` or `credentialAgentId = agentId`. If absent, return all (admin view).
- `since?: number` — unix ms; return rows with `leasedAt >= since`. Default: 0.
- `limit?: number` — default 100, clamped to `AUDIT_MAX_LIMIT = 1000`.

Response:

```ts
type AuditEntry = {
  leaseId: string
  lenderAgentId: string
  lenderUserId: string
  borrowerAgentId: string
  borrowerUserId: string
  leasedAt: number
  releasedAt: number | null
  durationMs: number          // releasedAt ?? now, minus leasedAt
  requestCount: number
  closedReason: "released" | "expired" | "cooldown" | null
}
type AuditResponse = { entries: AuditEntry[] }
```

Active leases are included, with `releasedAt = null`, `durationMs` computed against `now`, `closedReason = null`, `requestCount = 0`.

### Auth

Shared `AUTH_SECRET` as today. The `agentId` query param is trusted — same posture as `POST /agents/heartbeat`. Tightening is a separate spec.

### SQL

```sql
SELECT l.id AS leaseId,
       l.credentialAgentId AS lenderAgentId,
       lender.userId AS lenderUserId,
       l.leasedTo AS borrowerAgentId,
       borrower.userId AS borrowerUserId,
       l.leasedAt,
       l.releasedAt,
       l.requestCount,
       l.closedReason
  FROM leases l
  JOIN agents lender ON lender.agentId = l.credentialAgentId
  JOIN agents borrower ON borrower.agentId = l.leasedTo
 WHERE (:agentId IS NULL
        OR l.leasedTo = :agentId
        OR l.credentialAgentId = :agentId)
   AND l.leasedAt >= :since
 ORDER BY l.leasedAt DESC
 LIMIT :limit
```

`durationMs` is computed in TypeScript after the query, not in SQL — keeps the query portable.

### Retention

No purge in v1. At ~30-min leases and a 10-person team, volume is ~20 rows/day. Documented as a future concern.

## API Surface

| Endpoint | Method | Change |
|---|---|---|
| `POST /agents/register` | POST | unchanged externally; server encrypts token on write |
| `POST /agents/heartbeat` | POST | unchanged |
| `GET /credentials/available` | GET | unchanged externally; server skips cooldowned lenders |
| `DELETE /credentials/lease/:id` | DELETE | new `?count=N` query param; server UPDATEs (no longer DELETEs) |
| `POST /credentials/lease/:id/cooldown` | POST | **new**; body `{ retryAfterSeconds, count? }` |
| `POST /agents/:id/cooldown` | POST | **new**; body `{ retryAfterSeconds }` |
| `GET /audit` | GET | **new**; query `agentId?`, `since?`, `limit?` |
| `GET /agents` | GET | unchanged; token already stripped |
| `DELETE /agents/:id` | DELETE | unchanged |
| `GET /health` | GET | unchanged |

## Shared Types (`packages/shared/src/types.ts`)

Additive changes. No breaking changes to existing shapes consumed by the agent today, except that `AgentRecord` gains a `cooldownUntil: number | null` field (safe — agents don't inspect agent-records sent by the server beyond what's in the `/agents` response, which already strips fields).

```ts
export const CooldownPayloadSchema = z.object({
  retryAfterSeconds: z.number().int().min(0).max(86400),
  count: z.number().int().min(0).optional(),
})
export type CooldownPayload = z.infer<typeof CooldownPayloadSchema>

export const AgentCooldownPayloadSchema = z.object({
  retryAfterSeconds: z.number().int().min(0).max(86400),
})
export type AgentCooldownPayload = z.infer<typeof AgentCooldownPayloadSchema>

export type AuditEntry = {
  leaseId: string
  lenderAgentId: string
  lenderUserId: string
  borrowerAgentId: string
  borrowerUserId: string
  leasedAt: number
  releasedAt: number | null
  durationMs: number
  requestCount: number
  closedReason: "released" | "expired" | "cooldown" | null
}
export type AuditResponse = { entries: AuditEntry[] }

// AgentRecord changes:
//   - `token: string` is REMOVED (ciphertext/nonce are store-internal; no caller of
//     `listAgents()` consumes the token today — the `/agents` route already strips it)
//   - gains `cooldownUntil: number | null`
// `acquireCredential` returns `AvailableCredentialResponse` (unchanged shape) with the
// plaintext token decrypted inline — that path is the only place plaintext tokens leave
// the store.

// LeaseRecord gains:
//   releasedAt: number | null
//   requestCount: number
//   closedReason: "released" | "expired" | "cooldown" | null

export const DEFAULTS = {
  // ... existing fields ...
  DEFAULT_COOLDOWN_MS: 60 * 1000,
  AUDIT_DEFAULT_LIMIT: 100,
  AUDIT_MAX_LIMIT: 1000,
} as const
```

## New Server Environment Variables

- `ENCRYPTION_KEY` — required; 32 raw bytes, base64-encoded. Server fails fast on startup if missing or malformed.
- `DEFAULT_COOLDOWN_MS` — optional; default `DEFAULTS.DEFAULT_COOLDOWN_MS` (60_000).

## New Files

- `packages/server/src/crypto.ts`
- `packages/server/src/crypto.test.ts`

Routes and store extensions live in the existing `routes.ts` / `store.ts` files, which stay under 400 lines.

## Code Philosophy

Pulled forward verbatim from the prior spec (`2026-04-14-claude-pool-design.md`). All new code conforms to these principles.

### Principles

- **Direct over abstract** — export functions, not classes wrapping functions. One implementation means no interface. Import directly, no DI containers.
- **Observability via `trace`** — a single wrapper handles method entry/exit logging with arguments and timing. Zero log lines inside method bodies. Business logic stays clean.
- **Minimal surface** — Bun built-ins, zod, yaml, Hono. Every added dependency must justify itself. This spec adds zero new dependencies; `node:crypto` is Bun built-in.
- **Flat structure** — one file per concern, 200-400 lines. If a file grows past 400, it's doing too much — split by domain, not by pattern.
- **Errors are strings** — `throw new Error("clear message")`. No custom hierarchies. Catch at boundaries, not everywhere.
- **Types travel** — one type definition used across layers. No DTO/model/entity splits, no mapping functions between identical shapes.

### What to avoid

- Interfaces for single implementations (`IStore`, `IProxy`, `ICrypto`)
- Event emitters or pub/sub when a function call is sufficient
- Repository/DAO patterns over direct `db.query()` calls
- Result monads or Either types — use try/catch
- Builder patterns — use object literals
- Retry strategies with backoff, jitter, circuit breakers — simple loop, max 3, done
- Middleware chains — Hono routes calling functions directly
- Graceful shutdown orchestrators — `process.on("SIGTERM", cleanup)` is enough
- Separate validation layers — zod at the boundary, trust internal data

## Testing

TDD throughout, following the prior plan's rhythm: write tests, verify fail, implement, verify pass, commit per logical task with `feat:` / `test:` prefixes. Target 80%+ coverage, as before.

### Unit tests

**`packages/server/src/crypto.test.ts` (new)**
- Round-trip: `decryptToken(encryptToken(x)) === x`
- Same plaintext → different ciphertexts (unique nonces)
- Decrypt with wrong key throws
- Decrypt with tampered ciphertext or wrong auth tag throws
- `createCrypto` rejects key that isn't 32 bytes after base64 decode

**`packages/server/src/store.test.ts` (additions)**
- `registerAgent` stores ciphertext only — raw SELECT of `tokenCiphertext` is not the plaintext token substring
- `acquireCredential` returns plaintext token (decryption transparent to caller)
- `acquireCredential` skips agents with `cooldownUntil > now`; includes agents with `cooldownUntil < now`
- `acquireCredential` skips cooldowned agents even on the fallback path
- Concurrent acquire: `Promise.all([acquire(a3), acquire(a4)])` with exactly one idle candidate (a1). Both calls complete without error and both return the same lender token. Because `BEGIN IMMEDIATE` serializes, the sequence is deterministic: the first tx takes the primary path (fresh lease on a1), the second tx sees a1 is now leased and takes the fallback path (a second lease on a1 — the original spec's intentional sharing behavior). Assert: two distinct `leaseId`s, same token, no exceptions. Without the transaction, this test could occasionally see both calls take the primary path, producing two "unshared" leases on the same candidate — the regression we are preventing.
- `releaseLease(id, count)` UPDATEs: row survives, `releasedAt` set, `closedReason='released'`, `requestCount=count`
- `releaseLease` called twice is a no-op (guarded by `WHERE releasedAt IS NULL`)
- `expireLeases` UPDATEs with `closedReason='expired'`
- `markLeaseCooldown(id, ms, count)` sets owner's `cooldownUntil` and closes lease as `'cooldown'`
- `markAgentCooldown(agentId, ms)` sets `cooldownUntil` independently
- `listAudit({})` returns all rows ordered `leasedAt DESC`
- `listAudit({agentId: X})` filters by lender-or-borrower = X
- `listAudit({since, limit})` respects both bounds

**`packages/server/src/routes.test.ts` (additions)**
- `POST /credentials/lease/:id/cooldown` with valid payload → 200, subsequent `GET /credentials/available` does not pick that lender until `cooldownUntil` passes
- `POST /agents/:id/cooldown` same behavior
- `DELETE /credentials/lease/:id?count=12` records `requestCount=12`
- `DELETE /credentials/lease/:id` (no count) records `requestCount=0`
- `GET /audit` admin view returns all rows
- `GET /audit?agentId=X` scopes correctly
- `GET /audit?since=TS&limit=N` filters and limits
- `GET /audit?limit=9999` is clamped to 1000
- Invalid `retryAfterSeconds` (negative, float, > 86400) → 400

**`packages/agent/src/proxy.test.ts` (additions)**
- 429 with `Retry-After: 42` on a borrowed credential → proxy POSTs cooldown with `retryAfterSeconds=42`
- 429 without `Retry-After` on a borrowed credential → proxy POSTs cooldown with `retryAfterSeconds=0`
- 429 on the owner's original request → proxy POSTs `/agents/:id/cooldown` before entering failover
- Successful release sends accumulated `count` via `?count=N`
- Request counter resets between distinct leases

### Integration test (`tests/integration.test.ts` additions)

- Full flow: Bob's token 429s → proxy marks Bob cooldowned → failover acquires Alice's token → success → release records `requestCount > 0`
- Second Bob request during cooldown → still served Alice (not Bob's own benched token)
- After advancing `cooldownUntil` past `now`, Bob's token becomes eligible again
- `GET /audit?agentId=bob-agent` shows entry with `lenderUserId=alice`, `borrowerUserId=bob`, `requestCount > 0`
- Server restart with same `ENCRYPTION_KEY` preserves ability to acquire
- Server start with a *different* `ENCRYPTION_KEY` causes `acquireCredential` to skip undecryptable candidates rather than crash

### Migration test

- Seed a DB file with the old schema (plaintext `token` column, leases without new columns)
- Run `createStore(path, crypto)`
- Assert: `tokenCiphertext` / `tokenNonce` populated, plaintext `token` column dropped, leases table has `releasedAt`/`requestCount`/`closedReason`
- Decrypting migrated rows returns the original tokens

## Security Considerations

- Tokens at rest are now encrypted with AES-256-GCM. A dump of `claude-pool.db` without `ENCRYPTION_KEY` does not expose credentials.
- The master key lives in `ENCRYPTION_KEY` env on the server; operators manage it the same way they manage `AUTH_SECRET`.
- Transport is TLS on a trusted network (unchanged).
- `/audit` exposes borrower/lender identities and usage volumes. This is the intended value — the shared secret gates who can see it. Teams should treat `AUTH_SECRET` as confidential.
- The `agentId` query param on `/audit` is trusted; any agent with the shared secret can impersonate any other. Consistent with current posture; tightening is a separate spec.
- ToS risk (token sharing) is unchanged from the original spec.

## Self-Review Check (pre-plan)

- No TBDs, no placeholders in the design
- All three feature areas (audit, encryption, race+cooldown) have concrete schema, endpoints, and tests
- No contradictions between sections (the "release becomes UPDATE" change is stated consistently in Architecture, Lease Lifecycle, and API Surface)
- Scope is focused: every item directly serves one of G1-G4; nothing unrelated snuck in
- Code Philosophy is embedded verbatim so the writing-plans pass inherits it

## Open Questions / Future Work

- `ENCRYPTION_KEY` rotation tooling
- Per-agent API keys for stronger `/audit` scoping
- Tokens-consumed / cost-estimation audit (requires parsing Anthropic response bodies)
- CLI: `claude-pool audit` command
- Retention policy on the leases table
- Heartbeat-piggyback usage reporting (durability upgrade over release-based counting)
