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
      apiKeyCiphertext BLOB,
      apiKeyNonce BLOB,
      oauthCiphertext BLOB,
      oauthNonce BLOB,
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
    (payload: {
      agentId: string
      userId: string
      apiKey?: string
      oauthToken?: string
    }) => {
      const now = Date.now()

      // Encode each field's intent into "(ciphertext, nonce, shouldWrite)".
      //   undefined  → no SET clause (preserve existing)
      //   ""         → SET to NULL (clear)
      //   "sk-…"     → SET to encrypted bytes (replace)
      const encodeCred = (v: string | undefined):
        | { write: false }
        | { write: true; ct: Buffer | null; nonce: Buffer | null } => {
        if (v === undefined) return { write: false }
        if (v === "") return { write: true, ct: null, nonce: null }
        const { ciphertext, nonce } = crypto.encryptToken(v)
        return { write: true, ct: ciphertext, nonce }
      }

      const apiCol = encodeCred(payload.apiKey)
      const oauthCol = encodeCred(payload.oauthToken)

      db.transaction(() => {
        // INSERT-or-UPDATE. For the INSERT branch we must populate NOT-NULL
        // housekeeping columns + whichever of the four credential columns the
        // payload touches; unset ones go in as NULL (enforced by the
        // post-update invariant check below).
        const insertApiCt = apiCol.write ? apiCol.ct : null
        const insertApiNonce = apiCol.write ? apiCol.nonce : null
        const insertOauthCt = oauthCol.write ? oauthCol.ct : null
        const insertOauthNonce = oauthCol.write ? oauthCol.nonce : null

        db.run(
          `INSERT INTO agents (
             agentId, userId,
             apiKeyCiphertext, apiKeyNonce,
             oauthCiphertext, oauthNonce,
             status, registeredAt, lastHeartbeatAt, lastActivityAt, cooldownUntil
           ) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, 0, NULL)
           ON CONFLICT(agentId) DO UPDATE SET
             userId = excluded.userId,
             registeredAt = excluded.registeredAt,
             lastHeartbeatAt = excluded.lastHeartbeatAt`,
          [
            payload.agentId,
            payload.userId,
            insertApiCt,
            insertApiNonce,
            insertOauthCt,
            insertOauthNonce,
            now,
            now,
          ]
        )

        // Conditional per-field UPDATE (the INSERT branch already populated
        // the right values; this pass only matters for the UPDATE branch).
        if (apiCol.write) {
          db.run(
            `UPDATE agents
                SET apiKeyCiphertext = ?, apiKeyNonce = ?
              WHERE agentId = ?`,
            [apiCol.ct, apiCol.nonce, payload.agentId]
          )
        }
        if (oauthCol.write) {
          db.run(
            `UPDATE agents
                SET oauthCiphertext = ?, oauthNonce = ?
              WHERE agentId = ?`,
            [oauthCol.ct, oauthCol.nonce, payload.agentId]
          )
        }

        // Invariant: at least one credential must be non-null post-update.
        const row = db
          .query(
            `SELECT apiKeyCiphertext IS NOT NULL AS hasApi,
                    oauthCiphertext  IS NOT NULL AS hasOauth
               FROM agents WHERE agentId = ?`
          )
          .get(payload.agentId) as { hasApi: number; hasOauth: number } | null
        if (!row || (row.hasApi === 0 && row.hasOauth === 0)) {
          throw new Error(
            "registerAgent: row must have at least one non-null credential"
          )
        }
      })()
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
      type CredCols = {
        apiKeyCiphertext: Uint8Array | null
        apiKeyNonce: Uint8Array | null
        oauthCiphertext: Uint8Array | null
        oauthNonce: Uint8Array | null
      }

      // Try apiKey first, then oauth. Returns decrypted plaintext or null
      // if both columns are NULL or both decrypt attempts fail.
      const pickToken = (row: CredCols): string | null => {
        if (row.apiKeyCiphertext && row.apiKeyNonce) {
          try {
            return crypto.decryptToken(
              Buffer.from(row.apiKeyCiphertext),
              Buffer.from(row.apiKeyNonce)
            )
          } catch {
            /* fall through to oauth */
          }
        }
        if (row.oauthCiphertext && row.oauthNonce) {
          try {
            return crypto.decryptToken(
              Buffer.from(row.oauthCiphertext),
              Buffer.from(row.oauthNonce)
            )
          } catch {
            /* fall through to skip */
          }
        }
        return null
      }

      return db.transaction((): AvailableCredentialResponse | null => {
        const now = Date.now()

        // 1. existing active lease wins
        const existing = db
          .query(
            `SELECT l.id,
                    a.apiKeyCiphertext, a.apiKeyNonce,
                    a.oauthCiphertext,  a.oauthNonce
               FROM leases l
               JOIN agents a ON a.agentId = l.credentialAgentId
              WHERE l.leasedTo = ?
                AND l.releasedAt IS NULL
                AND (l.leasedAt + l.ttl) > ?`
          )
          .get(requestingAgentId, now) as (CredCols & { id: string }) | null
        if (existing) {
          const token = pickToken(existing)
          if (token) return { token, leaseId: existing.id }
          // existing lease's lender has no usable creds; fall through
        }

        // 2. fresh idle, not-cooldowned, not-self, no active lease
        const primaries = db
          .query(
            `SELECT a.agentId,
                    a.apiKeyCiphertext, a.apiKeyNonce,
                    a.oauthCiphertext,  a.oauthNonce
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
          .all(now, requestingAgentId, now) as Array<CredCols & { agentId: string }>
        for (const c of primaries) {
          const token = pickToken(c)
          if (!token) continue
          const leaseId = globalThis.crypto.randomUUID()
          db.run(
            "INSERT INTO leases (id, credentialAgentId, leasedTo, leasedAt, ttl) VALUES (?, ?, ?, ?, ?)",
            [leaseId, c.agentId, requestingAgentId, now, DEFAULTS.LEASE_TTL_MS]
          )
          return { token, leaseId }
        }

        // 3. fallback: share an already-leased idle (cooldown still respected)
        const fallbacks = db
          .query(
            `SELECT a.agentId,
                    a.apiKeyCiphertext, a.apiKeyNonce,
                    a.oauthCiphertext,  a.oauthNonce
               FROM agents a
              WHERE a.status = 'idle'
                AND a.agentId != ?
                AND (a.cooldownUntil IS NULL OR a.cooldownUntil < ?)
              ORDER BY a.lastActivityAt ASC`
          )
          .all(requestingAgentId, now) as Array<CredCols & { agentId: string }>
        for (const c of fallbacks) {
          const token = pickToken(c)
          if (!token) continue
          const leaseId = globalThis.crypto.randomUUID()
          db.run(
            "INSERT INTO leases (id, credentialAgentId, leasedTo, leasedAt, ttl) VALUES (?, ?, ?, ?, ?)",
            [leaseId, c.agentId, requestingAgentId, now, DEFAULTS.LEASE_TTL_MS]
          )
          return { token, leaseId }
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

  const countOpenLeases = trace("store.countOpenLeases", (): number => {
    const row = db
      .query("SELECT COUNT(*) AS n FROM leases WHERE releasedAt IS NULL")
      .get() as { n: number }
    return row.n
  })

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
    countOpenLeases,
    listAudit,
  }
}

function migrate(db: Database, crypto: Crypto) {
  const agentCols = db
    .query("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>
  const agentColNames = new Set(agentCols.map((c) => c.name))

  // Pre-existing migration: the very first plaintext schema lacked
  // cooldownUntil; add it before any later steps assume it exists.
  if (!agentColNames.has("cooldownUntil")) {
    db.exec("ALTER TABLE agents ADD COLUMN cooldownUntil INTEGER")
    agentColNames.add("cooldownUntil")
  }

  // Pre-existing migration from the very first plaintext schema.
  // Only runs against ancient DBs that still have the `token TEXT` column.
  if (agentColNames.has("token")) {
    if (!agentColNames.has("tokenCiphertext")) {
      db.exec("ALTER TABLE agents ADD COLUMN tokenCiphertext BLOB")
    }
    if (!agentColNames.has("tokenNonce")) {
      db.exec("ALTER TABLE agents ADD COLUMN tokenNonce BLOB")
    }
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
    agentColNames.delete("token")
    agentColNames.add("tokenCiphertext")
    agentColNames.add("tokenNonce")
  }

  // New in 2026-04-22: split tokenCiphertext into apiKeyCiphertext +
  // oauthCiphertext based on the decrypted prefix.
  if (!agentColNames.has("apiKeyCiphertext")) {
    db.exec("ALTER TABLE agents ADD COLUMN apiKeyCiphertext BLOB")
    db.exec("ALTER TABLE agents ADD COLUMN apiKeyNonce BLOB")
    db.exec("ALTER TABLE agents ADD COLUMN oauthCiphertext BLOB")
    db.exec("ALTER TABLE agents ADD COLUMN oauthNonce BLOB")
    agentColNames.add("apiKeyCiphertext")
    agentColNames.add("apiKeyNonce")
    agentColNames.add("oauthCiphertext")
    agentColNames.add("oauthNonce")
  }

  if (agentColNames.has("tokenCiphertext")) {
    const rows = db
      .query(
        `SELECT agentId, tokenCiphertext, tokenNonce
           FROM agents
          WHERE tokenCiphertext IS NOT NULL`
      )
      .all() as Array<{
        agentId: string
        tokenCiphertext: Uint8Array
        tokenNonce: Uint8Array
      }>
    let migrated = 0
    let skipped = 0
    for (const r of rows) {
      try {
        const plaintext = crypto.decryptToken(
          Buffer.from(r.tokenCiphertext),
          Buffer.from(r.tokenNonce)
        )
        const isApiKey = plaintext.startsWith("sk-ant-api")
        if (isApiKey) {
          db.run(
            `UPDATE agents
                SET apiKeyCiphertext = ?, apiKeyNonce = ?
              WHERE agentId = ?`,
            [r.tokenCiphertext, r.tokenNonce, r.agentId]
          )
        } else {
          db.run(
            `UPDATE agents
                SET oauthCiphertext = ?, oauthNonce = ?
              WHERE agentId = ?`,
            [r.tokenCiphertext, r.tokenNonce, r.agentId]
          )
        }
        migrated += 1
      } catch {
        skipped += 1 // row encrypted under a different key; owner re-registers
      }
    }
    db.exec("ALTER TABLE agents DROP COLUMN tokenCiphertext")
    db.exec("ALTER TABLE agents DROP COLUMN tokenNonce")
    if (migrated > 0 || skipped > 0) {
      console.log(
        `migrated ${migrated} agent rows into (apiKey, oauth) columns ` +
          `(${skipped} skipped — undecryptable under current ENCRYPTION_KEY)`
      )
    }
  }

  // Unchanged — lease column migrations from the hardening PR.
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
