import { Database } from "bun:sqlite"
import { trace, traceQuiet } from "@claude-pool/shared/src/trace"
import {
  DEFAULTS,
  type AgentRecord,
  type HeartbeatPayload,
  type AvailableCredentialResponse,
  type AuditEntry,
} from "@claude-pool/shared/src/types"
import type { Crypto } from "./crypto"

export function createStore(dbPath: string, crypto: Crypto) {
  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agentId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenCiphertext BLOB,
      tokenNonce BLOB,
      status TEXT NOT NULL DEFAULT 'idle',
      registeredAt INTEGER NOT NULL,
      lastHeartbeatAt INTEGER NOT NULL,
      lastActivityAt INTEGER NOT NULL DEFAULT 0,
      cooldownUntil INTEGER
    )
  `)
  db.exec(`
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
    )
  `)
  // Migrate BEFORE creating indexes — old DBs need their schema upgraded
  // (e.g. `releasedAt` added to leases) before the index that references those
  // columns can be created.
  migrate(db, crypto)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_leases_active
      ON leases(credentialAgentId) WHERE releasedAt IS NULL
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_leases_audit
      ON leases(leasedTo, leasedAt DESC)
  `)

  const registerAgent = traceQuiet(
    "store.registerAgent",
    (payload: { agentId: string; userId: string; token: string }) => {
      const now = Date.now()
      const { ciphertext, nonce } = crypto.encryptToken(payload.token)
      db.run(
        `INSERT INTO agents (agentId, userId, tokenCiphertext, tokenNonce, status,
                             registeredAt, lastHeartbeatAt, lastActivityAt, cooldownUntil)
         VALUES (?, ?, ?, ?, 'idle', ?, ?, 0, NULL)
         ON CONFLICT(agentId) DO UPDATE SET
           userId = excluded.userId,
           tokenCiphertext = excluded.tokenCiphertext,
           tokenNonce = excluded.tokenNonce,
           registeredAt = excluded.registeredAt,
           lastHeartbeatAt = excluded.lastHeartbeatAt`,
        [payload.agentId, payload.userId, ciphertext, nonce, now, now]
      )
    }
  )

  const heartbeat = trace("store.heartbeat", (payload: HeartbeatPayload) => {
    const now = Date.now()
    db.run(
      `UPDATE agents SET status = ?, lastHeartbeatAt = ?, lastActivityAt = ? WHERE agentId = ?`,
      [payload.status, now, payload.lastActivityAt, payload.agentId]
    )
  })

  const listAgents = trace("store.listAgents", (): AgentRecord[] => {
    return db
      .query(
        `SELECT agentId, userId, status, registeredAt, lastHeartbeatAt,
                lastActivityAt, cooldownUntil
           FROM agents`
      )
      .all() as AgentRecord[]
  })

  const removeAgent = trace("store.removeAgent", (agentId: string) => {
    db.run("DELETE FROM agents WHERE agentId = ?", [agentId])
  })

  const expireOfflineAgents = trace(
    "store.expireOfflineAgents",
    (thresholdMs: number) => {
      const cutoff = Date.now() - thresholdMs
      db.run(
        "UPDATE agents SET status = 'offline' WHERE lastHeartbeatAt < ? AND status != 'offline'",
        [cutoff]
      )
    }
  )

  const acquireCredential = trace(
    "store.acquireCredential",
    (requestingAgentId: string): AvailableCredentialResponse | null => {
      // bun:sqlite's db.transaction() opens BEGIN DEFERRED. With a single
      // in-process SQLite connection and synchronous bun:sqlite calls, the JS
      // event loop serializes every transaction body, so DEFERRED is sufficient
      // to guarantee race-free read-modify-write here. If we ever move to a
      // multi-process / multi-connection model, switch to BEGIN IMMEDIATE.
      return db.transaction((): AvailableCredentialResponse | null => {
        const now = Date.now()

        // 1. existing active lease wins
        const existing = db
          .query(
            `SELECT l.id, a.tokenCiphertext, a.tokenNonce
               FROM leases l
               JOIN agents a ON a.agentId = l.credentialAgentId
              WHERE l.leasedTo = ?
                AND l.releasedAt IS NULL
                AND (l.leasedAt + l.ttl) > ?`
          )
          .get(requestingAgentId, now) as
          | { id: string; tokenCiphertext: Buffer; tokenNonce: Buffer }
          | null
        if (existing) {
          try {
            const token = crypto.decryptToken(
              existing.tokenCiphertext,
              existing.tokenNonce
            )
            return { token, leaseId: existing.id }
          } catch {
            // existing lease's lender row is undecryptable; fall through
          }
        }

        // 2. fresh idle, not-cooldowned, not-self, no active lease — try each
        const primaries = db
          .query(
            `SELECT a.agentId, a.tokenCiphertext, a.tokenNonce
               FROM agents a
               LEFT JOIN leases l
                 ON l.credentialAgentId = a.agentId
                AND l.releasedAt IS NULL
                AND (l.leasedAt + l.ttl) > ?
              WHERE a.status = 'idle'
                AND a.agentId != ?
                AND (a.cooldownUntil IS NULL OR a.cooldownUntil < ?)
                AND l.id IS NULL
              ORDER BY a.lastActivityAt ASC`
          )
          .all(now, requestingAgentId, now) as Array<{
            agentId: string
            tokenCiphertext: Buffer
            tokenNonce: Buffer
          }>
        for (const c of primaries) {
          try {
            const token = crypto.decryptToken(c.tokenCiphertext, c.tokenNonce)
            const leaseId = globalThis.crypto.randomUUID()
            db.run(
              "INSERT INTO leases (id, credentialAgentId, leasedTo, leasedAt, ttl) VALUES (?, ?, ?, ?, ?)",
              [leaseId, c.agentId, requestingAgentId, now, DEFAULTS.LEASE_TTL_MS]
            )
            return { token, leaseId }
          } catch {
            continue // skip undecryptable candidate
          }
        }

        // 3. fallback: share an already-leased idle (cooldown still respected)
        const fallbacks = db
          .query(
            `SELECT a.agentId, a.tokenCiphertext, a.tokenNonce
               FROM agents a
              WHERE a.status = 'idle'
                AND a.agentId != ?
                AND (a.cooldownUntil IS NULL OR a.cooldownUntil < ?)
              ORDER BY a.lastActivityAt ASC`
          )
          .all(requestingAgentId, now) as Array<{
            agentId: string
            tokenCiphertext: Buffer
            tokenNonce: Buffer
          }>
        for (const c of fallbacks) {
          try {
            const token = crypto.decryptToken(c.tokenCiphertext, c.tokenNonce)
            const leaseId = globalThis.crypto.randomUUID()
            db.run(
              "INSERT INTO leases (id, credentialAgentId, leasedTo, leasedAt, ttl) VALUES (?, ?, ?, ?, ?)",
              [leaseId, c.agentId, requestingAgentId, now, DEFAULTS.LEASE_TTL_MS]
            )
            return { token, leaseId }
          } catch {
            continue
          }
        }

        return null
      })()
    }
  )

  const releaseLease = trace(
    "store.releaseLease",
    (leaseId: string, requestCount: number = 0) => {
      db.run(
        `UPDATE leases
            SET releasedAt = ?,
                requestCount = ?,
                closedReason = 'released'
          WHERE id = ? AND releasedAt IS NULL`,
        [Date.now(), requestCount, leaseId]
      )
    }
  )

  const expireLeases = trace("store.expireLeases", (ttlMs: number) => {
    const now = Date.now()
    db.run(
      `UPDATE leases
          SET releasedAt = ?,
              closedReason = 'expired'
        WHERE releasedAt IS NULL AND (leasedAt + ttl) < ?`,
      [now, now]
    )
  })

  const markLeaseCooldown = trace(
    "store.markLeaseCooldown",
    (leaseId: string, retryAfterMs: number, requestCount: number) => {
      const now = Date.now()
      const effective = retryAfterMs > 0 ? retryAfterMs : DEFAULTS.DEFAULT_COOLDOWN_MS
      db.transaction(() => {
        db.run(
          `UPDATE agents
              SET cooldownUntil = ?
            WHERE agentId = (SELECT credentialAgentId FROM leases WHERE id = ?)`,
          [now + effective, leaseId]
        )
        db.run(
          `UPDATE leases
              SET releasedAt = ?,
                  requestCount = ?,
                  closedReason = 'cooldown'
            WHERE id = ? AND releasedAt IS NULL`,
          [now, requestCount, leaseId]
        )
      })()
    }
  )

  const markAgentCooldown = trace(
    "store.markAgentCooldown",
    (agentId: string, retryAfterMs: number) => {
      const effective = retryAfterMs > 0 ? retryAfterMs : DEFAULTS.DEFAULT_COOLDOWN_MS
      db.run(
        "UPDATE agents SET cooldownUntil = ? WHERE agentId = ?",
        [Date.now() + effective, agentId]
      )
    }
  )

  const listAudit = trace(
    "store.listAudit",
    (opts: { agentId?: string; since?: number; limit?: number }): AuditEntry[] => {
      const since = opts.since ?? 0
      const limitRaw = opts.limit ?? DEFAULTS.AUDIT_DEFAULT_LIMIT
      const limit = Math.max(0, Math.min(limitRaw, DEFAULTS.AUDIT_MAX_LIMIT))
      const agentId = opts.agentId ?? null

      const rows = db
        .query(
          `SELECT l.id           AS leaseId,
                  l.credentialAgentId AS lenderAgentId,
                  lender.userId   AS lenderUserId,
                  l.leasedTo      AS borrowerAgentId,
                  borrower.userId AS borrowerUserId,
                  l.leasedAt      AS leasedAt,
                  l.releasedAt    AS releasedAt,
                  l.requestCount  AS requestCount,
                  l.closedReason  AS closedReason
             FROM leases l
             JOIN agents lender   ON lender.agentId   = l.credentialAgentId
             JOIN agents borrower ON borrower.agentId = l.leasedTo
            WHERE (? IS NULL OR l.leasedTo = ? OR l.credentialAgentId = ?)
              AND l.leasedAt >= ?
            ORDER BY l.leasedAt DESC
            LIMIT ?`
        )
        .all(agentId, agentId, agentId, since, limit) as Array<{
          leaseId: string
          lenderAgentId: string
          lenderUserId: string
          borrowerAgentId: string
          borrowerUserId: string
          leasedAt: number
          releasedAt: number | null
          requestCount: number
          closedReason: AuditEntry["closedReason"]
        }>

      const now = Date.now()
      return rows.map((r) => ({
        ...r,
        durationMs: (r.releasedAt ?? now) - r.leasedAt,
      }))
    }
  )

  return {
    db,
    registerAgent,
    heartbeat,
    listAgents,
    removeAgent,
    expireOfflineAgents,
    acquireCredential,
    releaseLease,
    expireLeases,
    markLeaseCooldown,
    markAgentCooldown,
    listAudit,
  }
}

function migrate(db: Database, crypto: Crypto) {
  const agentCols = db
    .query("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>
  const agentColNames = agentCols.map((c) => c.name)

  // CREATE TABLE IF NOT EXISTS is a no-op when the table already exists with
  // an old shape, so we have to add the new columns explicitly here.
  if (!agentColNames.includes("tokenCiphertext")) {
    db.exec("ALTER TABLE agents ADD COLUMN tokenCiphertext BLOB")
  }
  if (!agentColNames.includes("tokenNonce")) {
    db.exec("ALTER TABLE agents ADD COLUMN tokenNonce BLOB")
  }
  if (!agentColNames.includes("cooldownUntil")) {
    db.exec("ALTER TABLE agents ADD COLUMN cooldownUntil INTEGER")
  }

  if (agentColNames.includes("token")) {
    const rows = db
      .query("SELECT agentId, token FROM agents")
      .all() as Array<{ agentId: string; token: string }>
    for (const r of rows) {
      const { ciphertext, nonce } = crypto.encryptToken(r.token)
      db.run(
        "UPDATE agents SET tokenCiphertext = ?, tokenNonce = ? WHERE agentId = ?",
        [ciphertext, nonce, r.agentId]
      )
    }
    db.exec("ALTER TABLE agents DROP COLUMN token")
  }

  const leaseCols = db
    .query("PRAGMA table_info(leases)")
    .all() as Array<{ name: string }>
  const leaseColNames = leaseCols.map((c) => c.name)
  if (!leaseColNames.includes("releasedAt")) {
    db.exec("ALTER TABLE leases ADD COLUMN releasedAt INTEGER")
  }
  if (!leaseColNames.includes("requestCount")) {
    db.exec(
      "ALTER TABLE leases ADD COLUMN requestCount INTEGER NOT NULL DEFAULT 0"
    )
  }
  if (!leaseColNames.includes("closedReason")) {
    db.exec("ALTER TABLE leases ADD COLUMN closedReason TEXT")
  }
}
