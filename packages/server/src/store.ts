import { Database } from "bun:sqlite"
import { trace } from "@claude-pool/shared/src/trace"
import type {
  AgentRecord,
  HeartbeatPayload,
  AvailableCredentialResponse,
} from "@claude-pool/shared/src/types"
import type { createCrypto } from "./crypto"

type Crypto = ReturnType<typeof createCrypto>

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

  const registerAgent = trace(
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

  // acquire/release/cooldown/audit are added in subsequent tasks; placeholder
  // implementations are kept here so the file compiles after Task 3. Each
  // following task replaces the relevant block.
  const acquireCredential = trace(
    "store.acquireCredential",
    (requestingAgentId: string): AvailableCredentialResponse | null => {
      const now = Date.now()
      const row = db
        .query(
          `SELECT a.agentId, a.tokenCiphertext, a.tokenNonce
             FROM agents a
            WHERE a.status = 'idle' AND a.agentId != ?
            ORDER BY a.lastActivityAt ASC
            LIMIT 1`
        )
        .get(requestingAgentId) as
        | { agentId: string; tokenCiphertext: Buffer; tokenNonce: Buffer }
        | null
      if (!row) return null
      const leaseId = crypto_randomUUID()
      db.run(
        "INSERT INTO leases (id, credentialAgentId, leasedTo, leasedAt, ttl) VALUES (?, ?, ?, ?, ?)",
        [leaseId, row.agentId, requestingAgentId, now, 30 * 60 * 1000]
      )
      const token = crypto.decryptToken(row.tokenCiphertext, row.tokenNonce)
      return { token, leaseId }
    }
  )

  const releaseLease = trace("store.releaseLease", (leaseId: string) => {
    db.run("DELETE FROM leases WHERE id = ?", [leaseId])
  })

  const expireLeases = trace("store.expireLeases", (ttlMs: number) => {
    const cutoff = Date.now() - ttlMs
    db.run("DELETE FROM leases WHERE leasedAt < ?", [cutoff])
  })

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
  }
}

function crypto_randomUUID(): string {
  // node:crypto is available in Bun; globalThis.crypto is also fine.
  return globalThis.crypto.randomUUID()
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
