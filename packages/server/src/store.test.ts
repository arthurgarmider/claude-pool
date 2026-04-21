import { describe, it, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { createStore } from "./store"
import { createCrypto } from "./crypto"

const KEY_B64 = randomBytes(32).toString("base64")
const crypto = createCrypto(KEY_B64)

describe("store", () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore(":memory:", crypto)
  })

  describe("agents", () => {
    it("registers an agent and stores ciphertext (not plaintext)", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      const row = store.db
        .query("SELECT tokenCiphertext, tokenNonce FROM agents WHERE agentId=?")
        .get("a1") as { tokenCiphertext: Uint8Array; tokenNonce: Uint8Array }
      // bun:sqlite returns BLOBs as Uint8Array (Buffer is a Node-only subclass)
      expect(row.tokenCiphertext).toBeInstanceOf(Uint8Array)
      expect(row.tokenNonce).toBeInstanceOf(Uint8Array)
      // raw bytes must not contain the plaintext substring
      expect(Buffer.from(row.tokenCiphertext).toString("utf8")).not.toContain(
        "tok-alice"
      )
    })

    it("listAgents returns AgentRecord without a token field", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      const agents = store.listAgents()
      expect(agents).toHaveLength(1)
      expect(agents[0].agentId).toBe("a1")
      expect(agents[0].userId).toBe("alice")
      expect(agents[0].status).toBe("idle")
      expect(agents[0].cooldownUntil).toBeNull()
      // @ts-expect-error - token must not be present on AgentRecord
      expect(agents[0].token).toBeUndefined()
    })

    it("overwrites credentials on re-register (decryption returns new token)", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-old" })
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-new" })
      // a2 needs to exist as a borrower so acquire can return a1's token
      store.registerAgent({ agentId: "a2", userId: "bob", token: "tok-bob" })
      store.heartbeat({
        agentId: "a1",
        status: "idle",
        lastActivityAt: Date.now() - 60_000,
        credentialValid: true,
      })
      const result = store.acquireCredential("a2")
      expect(result!.token).toBe("tok-new")
    })

    it("updates status via heartbeat", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      store.heartbeat({
        agentId: "a1",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      })
      expect(store.listAgents()[0].status).toBe("active")
    })

    it("marks agents offline after timeout", () => {
      const old = Date.now() - 4 * 60 * 1000
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      store.heartbeat({
        agentId: "a1",
        status: "active",
        lastActivityAt: old,
        credentialValid: true,
      })
      store.db.run("UPDATE agents SET lastHeartbeatAt = ? WHERE agentId = ?", [
        old,
        "a1",
      ])
      store.expireOfflineAgents(3 * 60 * 1000)
      expect(store.listAgents()[0].status).toBe("offline")
    })

    it("removes an agent (cascades leases)", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      store.registerAgent({ agentId: "a2", userId: "bob", token: "tok-bob" })
      store.heartbeat({
        agentId: "a1",
        status: "idle",
        lastActivityAt: Date.now() - 60_000,
        credentialValid: true,
      })
      // a2 borrows a1's credential, creating a lease that references a1
      const lease = store.acquireCredential("a2")
      expect(lease).not.toBeNull()
      const leasesBefore = store.db
        .query("SELECT id FROM leases WHERE credentialAgentId = ?")
        .all("a1") as Array<{ id: string }>
      expect(leasesBefore).toHaveLength(1)

      store.removeAgent("a1")
      expect(store.listAgents()).toHaveLength(1) // only a2 remains
      const leasesAfter = store.db
        .query("SELECT id FROM leases WHERE credentialAgentId = ?")
        .all("a1") as Array<{ id: string }>
      expect(leasesAfter).toHaveLength(0)
    })
  })

  describe("migration from old plaintext schema", () => {
    it("migrates a pre-hardening DB: encrypts tokens, drops plaintext column, adds lease columns", () => {
      const path = `/tmp/claude-pool-mig-${Date.now()}.db`
      // seed old schema by hand
      const old = new Database(path)
      old.exec(`
        CREATE TABLE agents (
          agentId TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          token TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle',
          registeredAt INTEGER NOT NULL,
          lastHeartbeatAt INTEGER NOT NULL,
          lastActivityAt INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE leases (
          id TEXT PRIMARY KEY,
          credentialAgentId TEXT NOT NULL,
          leasedTo TEXT NOT NULL,
          leasedAt INTEGER NOT NULL,
          ttl INTEGER NOT NULL
        );
      `)
      const now = Date.now()
      old.run(
        "INSERT INTO agents VALUES (?, ?, ?, 'idle', ?, ?, ?)",
        ["a1", "alice", "plaintext-token-1", now, now, 0]
      )
      old.run(
        "INSERT INTO agents VALUES (?, ?, ?, 'idle', ?, ?, ?)",
        ["a2", "bob", "plaintext-token-2", now, now, 0]
      )
      old.run("INSERT INTO leases VALUES (?, ?, ?, ?, ?)", [
        "l1",
        "a1",
        "a2",
        now,
        30 * 60 * 1000,
      ])
      old.close()

      // open via createStore — should migrate
      const migrated = createStore(path, crypto)

      // plaintext token column is gone
      const cols = migrated.db
        .query("PRAGMA table_info(agents)")
        .all() as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).not.toContain("token")
      expect(colNames).toContain("tokenCiphertext")
      expect(colNames).toContain("tokenNonce")
      expect(colNames).toContain("cooldownUntil")

      // new lease columns exist
      const leaseCols = migrated.db
        .query("PRAGMA table_info(leases)")
        .all() as Array<{ name: string }>
      const leaseColNames = leaseCols.map((c) => c.name)
      expect(leaseColNames).toContain("releasedAt")
      expect(leaseColNames).toContain("requestCount")
      expect(leaseColNames).toContain("closedReason")

      // tokens are now decryptable round-trip
      // a1 idle, a2 borrower → acquire returns plaintext-token-1
      // (drop the existing l1 lease so acquire takes the primary path)
      migrated.db.run("DELETE FROM leases")
      migrated.heartbeat({
        agentId: "a1",
        status: "idle",
        lastActivityAt: now - 60_000,
        credentialValid: true,
      })
      const result = migrated.acquireCredential("a2")
      expect(result!.token).toBe("plaintext-token-1")

      migrated.db.close()
    })
  })

  describe("leases (acquire)", () => {
    beforeEach(() => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      store.registerAgent({ agentId: "a2", userId: "bob", token: "tok-bob" })
      store.heartbeat({
        agentId: "a1",
        status: "idle",
        lastActivityAt: Date.now() - 20 * 60 * 1000,
        credentialValid: true,
      })
      store.heartbeat({
        agentId: "a2",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      })
    })

    it("returns idle credential with lease (decrypted token)", () => {
      const result = store.acquireCredential("a2")
      expect(result).not.toBeNull()
      expect(result!.token).toBe("tok-alice")
      expect(result!.leaseId).toBeTruthy()
    })

    it("returns same lease for same requester (no double-allocate)", () => {
      const first = store.acquireCredential("a2")!
      const second = store.acquireCredential("a2")!
      expect(first.leaseId).toBe(second.leaseId)
      expect(first.token).toBe(second.token)
    })

    it("does not return requester's own credential", () => {
      store.heartbeat({
        agentId: "a2",
        status: "idle",
        lastActivityAt: Date.now() - 30 * 60 * 1000,
        credentialValid: true,
      })
      const result = store.acquireCredential("a2")
      expect(result!.token).toBe("tok-alice")
    })

    it("returns null when no idle credentials available", () => {
      store.heartbeat({
        agentId: "a1",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      })
      const result = store.acquireCredential("a2")
      expect(result).toBeNull()
    })

    it("prefers longest-idle agent", () => {
      store.registerAgent({ agentId: "a3", userId: "carol", token: "tok-carol" })
      store.heartbeat({
        agentId: "a3",
        status: "idle",
        lastActivityAt: Date.now() - 60 * 60 * 1000,
        credentialValid: true,
      })
      const result = store.acquireCredential("a2")
      expect(result!.token).toBe("tok-carol")
    })

    it("falls back to already-leased credential when all idle are leased", () => {
      store.acquireCredential("a2") // takes a1
      store.registerAgent({ agentId: "a3", userId: "carol", token: "tok-carol" })
      store.heartbeat({
        agentId: "a3",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      })
      const result = store.acquireCredential("a3")
      expect(result).not.toBeNull()
      expect(result!.token).toBe("tok-alice")
    })

    it("concurrent acquire serializes via BEGIN IMMEDIATE — both succeed", async () => {
      // a1 is the only idle candidate; two borrowers race.
      // The first tx takes the primary path (fresh lease on a1).
      // The second tx sees a1 is leased and falls back to sharing a1.
      // Without BEGIN IMMEDIATE this could occasionally yield two
      // "primary path" leases on a1 — the regression we are preventing.
      store.registerAgent({ agentId: "a3", userId: "carol", token: "tok-carol" })
      store.registerAgent({ agentId: "a4", userId: "dave", token: "tok-dave" })
      store.heartbeat({
        agentId: "a3",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      })
      store.heartbeat({
        agentId: "a4",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      })
      const [r1, r2] = await Promise.all([
        Promise.resolve(store.acquireCredential("a3")),
        Promise.resolve(store.acquireCredential("a4")),
      ])
      expect(r1).not.toBeNull()
      expect(r2).not.toBeNull()
      expect(r1!.token).toBe("tok-alice")
      expect(r2!.token).toBe("tok-alice")
      expect(r1!.leaseId).not.toBe(r2!.leaseId)
    })

    it("skips candidates whose decryption fails (key mismatch)", () => {
      // simulate a row encrypted under a different key by overwriting
      // a1's ciphertext bytes with garbage that will fail GCM auth.
      store.db.run(
        "UPDATE agents SET tokenCiphertext = ?, tokenNonce = ? WHERE agentId = ?",
        [Buffer.alloc(48, 0xff), Buffer.alloc(12, 0xff), "a1"]
      )
      // a3 is registered as a NEWER idle candidate than a1 (a1 is 20 min old
      // from beforeEach). Ordering is `lastActivityAt ASC`, so a1 is tried
      // first, its decrypt throws, and the loop falls through to a3.
      store.registerAgent({ agentId: "a3", userId: "carol", token: "tok-carol" })
      store.heartbeat({
        agentId: "a3",
        status: "idle",
        lastActivityAt: Date.now() - 10 * 60 * 1000,
        credentialValid: true,
      })
      const result = store.acquireCredential("a2")
      expect(result!.token).toBe("tok-carol")
    })
  })
})
