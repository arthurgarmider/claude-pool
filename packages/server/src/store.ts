import { Database } from "bun:sqlite"
import { trace } from "@claude-pool/shared/src/trace"
import type { AgentRecord, HeartbeatPayload, AvailableCredentialResponse } from "@claude-pool/shared/src/types"

export function createStore(dbPath: string) {
  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode=WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agentId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      registeredAt INTEGER NOT NULL,
      lastHeartbeatAt INTEGER NOT NULL,
      lastActivityAt INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY,
      credentialAgentId TEXT NOT NULL,
      leasedTo TEXT NOT NULL,
      leasedAt INTEGER NOT NULL,
      ttl INTEGER NOT NULL,
      FOREIGN KEY (credentialAgentId) REFERENCES agents(agentId) ON DELETE CASCADE
    )
  `)

  const registerAgent = trace("store.registerAgent", (payload: { agentId: string; userId: string; token: string }) => {
    const now = Date.now()
    db.run(
      `INSERT INTO agents (agentId, userId, token, status, registeredAt, lastHeartbeatAt, lastActivityAt)
       VALUES (?, ?, ?, 'idle', ?, ?, 0)
       ON CONFLICT(agentId) DO UPDATE SET
         userId = excluded.userId,
         token = excluded.token,
         registeredAt = excluded.registeredAt,
         lastHeartbeatAt = excluded.lastHeartbeatAt`,
      [payload.agentId, payload.userId, payload.token, now, now]
    )
  })

  const heartbeat = trace("store.heartbeat", (payload: HeartbeatPayload) => {
    const now = Date.now()
    db.run(
      `UPDATE agents SET status = ?, lastHeartbeatAt = ?, lastActivityAt = ? WHERE agentId = ?`,
      [payload.status, now, payload.lastActivityAt, payload.agentId]
    )
  })

  const listAgents = trace("store.listAgents", (): AgentRecord[] => {
    return db.query("SELECT * FROM agents").all() as AgentRecord[]
  })

  const removeAgent = trace("store.removeAgent", (agentId: string) => {
    db.run("DELETE FROM agents WHERE agentId = ?", [agentId])
  })

  const expireOfflineAgents = trace("store.expireOfflineAgents", (thresholdMs: number) => {
    const cutoff = Date.now() - thresholdMs
    db.run("UPDATE agents SET status = 'offline' WHERE lastHeartbeatAt < ? AND status != 'offline'", [cutoff])
  })

  const acquireCredential = trace("store.acquireCredential", (requestingAgentId: string): AvailableCredentialResponse | null => {
    const existingLease = db.query(
      `SELECT l.id, a.token FROM leases l
       JOIN agents a ON a.agentId = l.credentialAgentId
       WHERE l.leasedTo = ? AND (l.leasedAt + l.ttl) > ?`
    ).get(requestingAgentId, Date.now()) as { id: string; token: string } | null

    if (existingLease) {
      return { token: existingLease.token, leaseId: existingLease.id }
    }

    const candidate = db.query(
      `SELECT a.agentId, a.token FROM agents a
       LEFT JOIN leases l ON l.credentialAgentId = a.agentId AND (l.leasedAt + l.ttl) > ?
       WHERE a.status = 'idle' AND a.agentId != ? AND l.id IS NULL
       ORDER BY a.lastActivityAt ASC
       LIMIT 1`
    ).get(Date.now(), requestingAgentId) as { agentId: string; token: string } | null

    if (candidate) {
      const leaseId = crypto.randomUUID()
      db.run(
        "INSERT INTO leases (id, credentialAgentId, leasedTo, leasedAt, ttl) VALUES (?, ?, ?, ?, ?)",
        [leaseId, candidate.agentId, requestingAgentId, Date.now(), 30 * 60 * 1000]
      )
      return { token: candidate.token, leaseId }
    }

    const fallback = db.query(
      `SELECT a.agentId, a.token FROM agents a
       WHERE a.status = 'idle' AND a.agentId != ?
       ORDER BY a.lastActivityAt ASC
       LIMIT 1`
    ).get(requestingAgentId) as { agentId: string; token: string } | null

    if (fallback) {
      const leaseId = crypto.randomUUID()
      db.run(
        "INSERT INTO leases (id, credentialAgentId, leasedTo, leasedAt, ttl) VALUES (?, ?, ?, ?, ?)",
        [leaseId, fallback.agentId, requestingAgentId, Date.now(), 30 * 60 * 1000]
      )
      return { token: fallback.token, leaseId }
    }

    return null
  })

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
