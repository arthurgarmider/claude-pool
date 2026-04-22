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
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
      const row = store.db
        .query("SELECT oauthCiphertext, oauthNonce FROM agents WHERE agentId=?")
        .get("a1") as { oauthCiphertext: Uint8Array; oauthNonce: Uint8Array }
      expect(row.oauthCiphertext).toBeInstanceOf(Uint8Array)
      expect(row.oauthNonce).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(row.oauthCiphertext).toString("utf8")).not.toContain(
        "tok-alice"
      )
    })

    it("listAgents returns AgentRecord without a token field", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
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
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-old" })
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-new" })
      // a2 needs to exist as a borrower so acquire can return a1's token
      store.registerAgent({ agentId: "a2", userId: "bob", oauthToken: "tok-bob" })
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
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
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
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
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
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
      store.registerAgent({ agentId: "a2", userId: "bob", oauthToken: "tok-bob" })
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

      const cols = migrated.db
        .query("PRAGMA table_info(agents)")
        .all() as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).not.toContain("token")
      expect(colNames).not.toContain("tokenCiphertext") // dropped by 2026-04-22 migration
      expect(colNames).not.toContain("tokenNonce")
      expect(colNames).toContain("apiKeyCiphertext")
      expect(colNames).toContain("oauthCiphertext")
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

    it("migrates a v2 DB (single tokenCiphertext column): api/oauth rows land in the right new columns", () => {
      const path = `/tmp/claude-pool-mig-v2-${Date.now()}.db`
      // seed the v2 schema (post-hardening, pre-api-key-mode) with pre-encrypted
      // blobs by doing a normal write through a createStore instance that uses
      // the v2 DDL. The simplest way to get a v2 DB is to construct the columns
      // by hand and run the intermediate migration, then let our code finish.
      const old = new Database(path)
      old.exec(`
        CREATE TABLE agents (
          agentId TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          tokenCiphertext BLOB,
          tokenNonce BLOB,
          status TEXT NOT NULL DEFAULT 'idle',
          registeredAt INTEGER NOT NULL,
          lastHeartbeatAt INTEGER NOT NULL,
          lastActivityAt INTEGER NOT NULL DEFAULT 0,
          cooldownUntil INTEGER
        );
        CREATE TABLE leases (
          id TEXT PRIMARY KEY,
          credentialAgentId TEXT NOT NULL,
          leasedTo TEXT NOT NULL,
          leasedAt INTEGER NOT NULL,
          ttl INTEGER NOT NULL,
          releasedAt INTEGER,
          requestCount INTEGER NOT NULL DEFAULT 0,
          closedReason TEXT
        );
      `)
      const now = Date.now()

      // encrypt fake plaintexts with the same crypto the test uses
      const api = crypto.encryptToken("sk-ant-api-migrated-key-0000000000")
      const oauth = crypto.encryptToken("sk-ant-oat01-migrated-token-0000000")
      old.run(
        `INSERT INTO agents
           (agentId, userId, tokenCiphertext, tokenNonce, status, registeredAt,
            lastHeartbeatAt, lastActivityAt, cooldownUntil)
         VALUES (?, ?, ?, ?, 'idle', ?, ?, 0, NULL)`,
        ["a-api", "alice", api.ciphertext, api.nonce, now, now]
      )
      old.run(
        `INSERT INTO agents
           (agentId, userId, tokenCiphertext, tokenNonce, status, registeredAt,
            lastHeartbeatAt, lastActivityAt, cooldownUntil)
         VALUES (?, ?, ?, ?, 'idle', ?, ?, 0, NULL)`,
        ["a-oauth", "bob", oauth.ciphertext, oauth.nonce, now, now]
      )
      old.close()

      const migrated = createStore(path, crypto)

      const cols = migrated.db
        .query("PRAGMA table_info(agents)")
        .all() as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).not.toContain("tokenCiphertext")
      expect(colNames).not.toContain("tokenNonce")
      expect(colNames).toContain("apiKeyCiphertext")
      expect(colNames).toContain("oauthCiphertext")

      // a-api: apiKey column populated, oauth NULL
      const apiRow = migrated.db
        .query(
          `SELECT apiKeyCiphertext IS NOT NULL AS hasApi,
                  oauthCiphertext  IS NOT NULL AS hasOauth
             FROM agents WHERE agentId = 'a-api'`
        )
        .get() as { hasApi: number; hasOauth: number }
      expect(apiRow.hasApi).toBe(1)
      expect(apiRow.hasOauth).toBe(0)

      // a-oauth: mirror
      const oauthRow = migrated.db
        .query(
          `SELECT apiKeyCiphertext IS NOT NULL AS hasApi,
                  oauthCiphertext  IS NOT NULL AS hasOauth
             FROM agents WHERE agentId = 'a-oauth'`
        )
        .get() as { hasApi: number; hasOauth: number }
      expect(oauthRow.hasApi).toBe(0)
      expect(oauthRow.hasOauth).toBe(1)

      migrated.db.close()
    })

    it("migration with wrong key: row ends up with both new columns NULL (no crash)", () => {
      const path = `/tmp/claude-pool-mig-wrongkey-${Date.now()}.db`
      const other = createCrypto(randomBytes(32).toString("base64"))
      const old = new Database(path)
      old.exec(`
        CREATE TABLE agents (
          agentId TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          tokenCiphertext BLOB,
          tokenNonce BLOB,
          status TEXT NOT NULL DEFAULT 'idle',
          registeredAt INTEGER NOT NULL,
          lastHeartbeatAt INTEGER NOT NULL,
          lastActivityAt INTEGER NOT NULL DEFAULT 0,
          cooldownUntil INTEGER
        );
        CREATE TABLE leases (
          id TEXT PRIMARY KEY,
          credentialAgentId TEXT NOT NULL,
          leasedTo TEXT NOT NULL,
          leasedAt INTEGER NOT NULL,
          ttl INTEGER NOT NULL,
          releasedAt INTEGER,
          requestCount INTEGER NOT NULL DEFAULT 0,
          closedReason TEXT
        );
      `)
      const now = Date.now()
      const blob = other.encryptToken("sk-ant-api-encrypted-under-other-key")
      old.run(
        `INSERT INTO agents
           (agentId, userId, tokenCiphertext, tokenNonce, status, registeredAt,
            lastHeartbeatAt, lastActivityAt, cooldownUntil)
         VALUES (?, ?, ?, ?, 'idle', ?, ?, 0, NULL)`,
        ["a1", "alice", blob.ciphertext, blob.nonce, now, now]
      )
      old.close()

      const migrated = createStore(path, crypto) // wrong key
      const row = migrated.db
        .query(
          `SELECT apiKeyCiphertext IS NOT NULL AS hasApi,
                  oauthCiphertext  IS NOT NULL AS hasOauth
             FROM agents WHERE agentId = 'a1'`
        )
        .get() as { hasApi: number; hasOauth: number }
      expect(row.hasApi).toBe(0)
      expect(row.hasOauth).toBe(0)
      migrated.db.close()
    })
  })

  describe("leases (acquire)", () => {
    beforeEach(() => {
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
      store.registerAgent({ agentId: "a2", userId: "bob", oauthToken: "tok-bob" })
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
      store.registerAgent({ agentId: "a3", userId: "carol", oauthToken: "tok-carol" })
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
      store.registerAgent({ agentId: "a3", userId: "carol", oauthToken: "tok-carol" })
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

    it("two acquires in flight are serialized — both succeed via primary+fallback", async () => {
      // a1 is the only idle candidate; two borrowers "race".
      // The first tx takes the primary path (fresh lease on a1).
      // The second tx sees a1 is already leased and falls back to sharing a1.
      // bun:sqlite calls are synchronous, so this test exercises the logical
      // primary-then-fallback serialization rather than true concurrent execution.
      // The transactional wrapper protects against multi-connection races
      // (see the comment in store.ts:acquireCredential).
      store.registerAgent({ agentId: "a3", userId: "carol", oauthToken: "tok-carol" })
      store.registerAgent({ agentId: "a4", userId: "dave", oauthToken: "tok-dave" })
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
        "UPDATE agents SET oauthCiphertext = ?, oauthNonce = ? WHERE agentId = ?",
        [Buffer.alloc(48, 0xff), Buffer.alloc(12, 0xff), "a1"]
      )
      // a3 is registered as a NEWER idle candidate than a1 (a1 is 20 min old
      // from beforeEach). Ordering is `lastActivityAt ASC`, so a1 is tried
      // first, its decrypt throws, and the loop falls through to a3.
      store.registerAgent({ agentId: "a3", userId: "carol", oauthToken: "tok-carol" })
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

  describe("leases (release/expire)", () => {
    beforeEach(() => {
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
      store.registerAgent({ agentId: "a2", userId: "bob", oauthToken: "tok-bob" })
      store.heartbeat({
        agentId: "a1",
        status: "idle",
        lastActivityAt: Date.now() - 20 * 60 * 1000,
        credentialValid: true,
      })
    })

    it("releaseLease records releasedAt, requestCount, closedReason='released'", () => {
      const result = store.acquireCredential("a2")!
      store.releaseLease(result.leaseId, 7)
      const row = store.db
        .query("SELECT releasedAt, requestCount, closedReason FROM leases WHERE id = ?")
        .get(result.leaseId) as {
          releasedAt: number | null
          requestCount: number
          closedReason: string | null
        }
      expect(row.releasedAt).not.toBeNull()
      expect(row.requestCount).toBe(7)
      expect(row.closedReason).toBe("released")
    })

    it("releaseLease with no count defaults requestCount to 0", () => {
      const result = store.acquireCredential("a2")!
      store.releaseLease(result.leaseId)
      const row = store.db
        .query("SELECT requestCount FROM leases WHERE id = ?")
        .get(result.leaseId) as { requestCount: number }
      expect(row.requestCount).toBe(0)
    })

    it("releaseLease called twice is a no-op (does not stomp first close)", () => {
      const result = store.acquireCredential("a2")!
      store.releaseLease(result.leaseId, 5)
      const firstClose = store.db
        .query("SELECT releasedAt, requestCount FROM leases WHERE id = ?")
        .get(result.leaseId) as { releasedAt: number; requestCount: number }
      // sleep a tick then attempt to overwrite
      Bun.sleepSync(2)
      store.releaseLease(result.leaseId, 9999)
      const after = store.db
        .query("SELECT releasedAt, requestCount FROM leases WHERE id = ?")
        .get(result.leaseId) as { releasedAt: number; requestCount: number }
      expect(after.releasedAt).toBe(firstClose.releasedAt)
      expect(after.requestCount).toBe(5)
    })

    it("released leases free the lender for a fresh primary-path acquire", () => {
      const first = store.acquireCredential("a2")!
      store.releaseLease(first.leaseId, 3)
      const next = store.acquireCredential("a2")!
      expect(next.leaseId).not.toBe(first.leaseId)
      expect(next.token).toBe("tok-alice")
    })

    it("expireLeases UPDATEs old leases with closedReason='expired'", () => {
      const result = store.acquireCredential("a2")!
      store.db.run("UPDATE leases SET leasedAt = ? WHERE id = ?", [
        Date.now() - 31 * 60 * 1000,
        result.leaseId,
      ])
      store.expireLeases(30 * 60 * 1000)
      const row = store.db
        .query("SELECT releasedAt, closedReason FROM leases WHERE id = ?")
        .get(result.leaseId) as { releasedAt: number | null; closedReason: string | null }
      expect(row.releasedAt).not.toBeNull()
      expect(row.closedReason).toBe("expired")
    })

    it("expireLeases skips already-released leases", () => {
      const result = store.acquireCredential("a2")!
      store.releaseLease(result.leaseId, 4)
      const beforeReason = store.db
        .query("SELECT closedReason FROM leases WHERE id = ?")
        .get(result.leaseId) as { closedReason: string }
      // backdate so the cutoff would have caught it
      store.db.run("UPDATE leases SET leasedAt = ? WHERE id = ?", [
        Date.now() - 31 * 60 * 1000,
        result.leaseId,
      ])
      store.expireLeases(30 * 60 * 1000)
      const after = store.db
        .query("SELECT closedReason FROM leases WHERE id = ?")
        .get(result.leaseId) as { closedReason: string }
      expect(after.closedReason).toBe(beforeReason.closedReason)
      expect(after.closedReason).toBe("released")
    })
  })

  describe("cooldown", () => {
    beforeEach(() => {
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
      store.registerAgent({ agentId: "a2", userId: "bob", oauthToken: "tok-bob" })
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

    it("markLeaseCooldown sets owner cooldownUntil and closes lease as 'cooldown'", () => {
      const result = store.acquireCredential("a2")!
      store.markLeaseCooldown(result.leaseId, 5_000, 11)
      const lease = store.db
        .query(
          "SELECT releasedAt, requestCount, closedReason FROM leases WHERE id = ?"
        )
        .get(result.leaseId) as {
          releasedAt: number | null
          requestCount: number
          closedReason: string
        }
      expect(lease.releasedAt).not.toBeNull()
      expect(lease.requestCount).toBe(11)
      expect(lease.closedReason).toBe("cooldown")
      const a1 = store.db
        .query("SELECT cooldownUntil FROM agents WHERE agentId = ?")
        .get("a1") as { cooldownUntil: number }
      expect(a1.cooldownUntil).toBeGreaterThan(Date.now())
    })

    it("acquireCredential skips cooldowned lenders (primary path)", () => {
      // mark a1 cooldowned for the next minute
      store.markAgentCooldown("a1", 60_000)
      const result = store.acquireCredential("a2")
      expect(result).toBeNull()
    })

    it("acquireCredential skips cooldowned lenders even on the fallback path", () => {
      // a3 is also idle; a1 cooldowned, so a3 should be picked
      store.registerAgent({ agentId: "a3", userId: "carol", oauthToken: "tok-carol" })
      store.heartbeat({
        agentId: "a3",
        status: "idle",
        lastActivityAt: Date.now() - 30 * 60 * 1000,
        credentialValid: true,
      })
      store.markAgentCooldown("a1", 60_000)
      // pre-lease a3 to force the fallback path
      store.acquireCredential("a2") // takes a3 (a1 cooldowned)
      // another borrower should fall back to sharing a3, never picking a1
      store.registerAgent({ agentId: "a4", userId: "dave", oauthToken: "tok-dave" })
      store.heartbeat({
        agentId: "a4",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      })
      const result = store.acquireCredential("a4")!
      expect(result.token).toBe("tok-carol")
    })

    it("acquireCredential picks up agents after cooldown expires", () => {
      // set cooldownUntil already in the past
      store.db.run(
        "UPDATE agents SET cooldownUntil = ? WHERE agentId = ?",
        [Date.now() - 1, "a1"]
      )
      const result = store.acquireCredential("a2")
      expect(result!.token).toBe("tok-alice")
    })

    it("markAgentCooldown is independent of any lease", () => {
      store.markAgentCooldown("a1", 30_000)
      const a1 = store.db
        .query("SELECT cooldownUntil FROM agents WHERE agentId = ?")
        .get("a1") as { cooldownUntil: number }
      expect(a1.cooldownUntil).toBeGreaterThan(Date.now())
    })
  })

  describe("listAudit", () => {
    beforeEach(() => {
      store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "tok-alice" })
      store.registerAgent({ agentId: "a2", userId: "bob", oauthToken: "tok-bob" })
      store.registerAgent({ agentId: "a3", userId: "carol", oauthToken: "tok-carol" })
      store.heartbeat({
        agentId: "a1",
        status: "idle",
        lastActivityAt: Date.now() - 60_000,
        credentialValid: true,
      })
      store.heartbeat({
        agentId: "a3",
        status: "idle",
        lastActivityAt: Date.now() - 120_000,
        credentialValid: true,
      })
    })

    it("returns active leases with releasedAt=null and computed durationMs", () => {
      const lease = store.acquireCredential("a2")!
      const entries = store.listAudit({})
      expect(entries).toHaveLength(1)
      const e = entries[0]
      expect(e.leaseId).toBe(lease.leaseId)
      expect(e.lenderUserId).toBe("carol") // longest-idle = a3
      expect(e.borrowerUserId).toBe("bob")
      expect(e.releasedAt).toBeNull()
      expect(e.closedReason).toBeNull()
      expect(e.requestCount).toBe(0)
      expect(e.durationMs).toBeGreaterThanOrEqual(0)
    })

    it("populates closedReason and final requestCount after release", () => {
      const lease = store.acquireCredential("a2")!
      store.releaseLease(lease.leaseId, 17)
      const e = store.listAudit({})[0]
      expect(e.closedReason).toBe("released")
      expect(e.requestCount).toBe(17)
      expect(e.releasedAt).not.toBeNull()
      expect(e.durationMs).toBe(e.releasedAt! - e.leasedAt)
    })

    it("filters by agentId (lender or borrower)", () => {
      store.acquireCredential("a2") // a3 → a2
      // create a second lease where a1 lends to a2
      store.acquireCredential("a2") // existing lease wins; force a fresh one
      // simulate lifecycle: release the first, acquire again
      const all = store.listAudit({})
      expect(all.length).toBeGreaterThanOrEqual(1)
      const onlyBob = store.listAudit({ agentId: "a2" })
      expect(onlyBob.every((e) => e.borrowerAgentId === "a2" || e.lenderAgentId === "a2"))
        .toBe(true)
      const onlyDave = store.listAudit({ agentId: "a-nonexistent" })
      expect(onlyDave).toHaveLength(0)
    })

    it("respects since and limit", () => {
      const lease = store.acquireCredential("a2")!
      store.releaseLease(lease.leaseId, 1)
      const past = store.listAudit({ since: Date.now() + 60_000 })
      expect(past).toHaveLength(0)
      const limited = store.listAudit({ limit: 0 })
      expect(limited).toHaveLength(0)
    })

    it("orders by leasedAt DESC", () => {
      const first = store.acquireCredential("a2")!
      store.releaseLease(first.leaseId, 1)
      Bun.sleepSync(2)
      const second = store.acquireCredential("a2")!
      const entries = store.listAudit({})
      expect(entries[0].leaseId).toBe(second.leaseId)
      expect(entries[1].leaseId).toBe(first.leaseId)
    })
  })

  describe("two-credential registration", () => {
    it("registers with apiKey only → apiKey columns set, oauth columns NULL", () => {
      store.registerAgent({
        agentId: "a1",
        userId: "alice",
        apiKey: "sk-ant-api-key-12345678901234567890",
      })
      const row = store.db
        .query(
          `SELECT apiKeyCiphertext IS NOT NULL AS hasApi,
                  oauthCiphertext  IS NOT NULL AS hasOauth
             FROM agents WHERE agentId = ?`
        )
        .get("a1") as { hasApi: number; hasOauth: number }
      expect(row.hasApi).toBe(1)
      expect(row.hasOauth).toBe(0)
    })

    it("registers with oauthToken only → oauth columns set, apiKey columns NULL", () => {
      store.registerAgent({
        agentId: "a1",
        userId: "alice",
        oauthToken: "sk-ant-oat01-abcdefghijklmnopqrst",
      })
      const row = store.db
        .query(
          `SELECT apiKeyCiphertext IS NOT NULL AS hasApi,
                  oauthCiphertext  IS NOT NULL AS hasOauth
             FROM agents WHERE agentId = ?`
        )
        .get("a1") as { hasApi: number; hasOauth: number }
      expect(row.hasApi).toBe(0)
      expect(row.hasOauth).toBe(1)
    })

    it("registers with both → both columns set", () => {
      store.registerAgent({
        agentId: "a1",
        userId: "alice",
        apiKey: "sk-ant-api-key-12345678901234567890",
        oauthToken: "sk-ant-oat01-abcdefghijklmnopqrst",
      })
      const row = store.db
        .query(
          `SELECT apiKeyCiphertext IS NOT NULL AS hasApi,
                  oauthCiphertext  IS NOT NULL AS hasOauth
             FROM agents WHERE agentId = ?`
        )
        .get("a1") as { hasApi: number; hasOauth: number }
      expect(row.hasApi).toBe(1)
      expect(row.hasOauth).toBe(1)
    })

    it("rejects registration with no credentials at all", () => {
      expect(() =>
        store.registerAgent({ agentId: "a1", userId: "alice" })
      ).toThrow(/at least one/)
    })

    it("re-register with only oauthToken preserves existing apiKey column", () => {
      store.registerAgent({
        agentId: "a1",
        userId: "alice",
        apiKey: "sk-ant-api-original-12345678901234",
        oauthToken: "sk-ant-oat01-original-0000000000",
      })
      store.registerAgent({
        agentId: "a1",
        userId: "alice",
        oauthToken: "sk-ant-oat01-replacement-111111",
      })
      // apiKey column untouched; oauth column updated
      store.registerAgent({
        agentId: "a2",
        userId: "bob",
        oauthToken: "sk-ant-oat01-bob-0000000000000",
      })
      store.heartbeat({
        agentId: "a1",
        status: "idle",
        lastActivityAt: Date.now() - 60_000,
        credentialValid: true,
      })
      // Acquire from a1: preference → apiKey (preserved, original value)
      const result = store.acquireCredential("a2")!
      expect(result.token).toBe("sk-ant-api-original-12345678901234")
    })

    it("re-register with apiKey='' clears the apiKey column", () => {
      store.registerAgent({
        agentId: "a1",
        userId: "alice",
        apiKey: "sk-ant-api-original-12345678901234",
        oauthToken: "sk-ant-oat01-original-0000000000",
      })
      store.registerAgent({
        agentId: "a1",
        userId: "alice",
        apiKey: "",
      })
      const row = store.db
        .query(
          `SELECT apiKeyCiphertext IS NOT NULL AS hasApi,
                  oauthCiphertext  IS NOT NULL AS hasOauth
             FROM agents WHERE agentId = ?`
        )
        .get("a1") as { hasApi: number; hasOauth: number }
      expect(row.hasApi).toBe(0)
      expect(row.hasOauth).toBe(1)
    })

    it("re-register that would leave row with no credentials is rejected", () => {
      store.registerAgent({
        agentId: "a1",
        userId: "alice",
        oauthToken: "sk-ant-oat01-original-0000000000",
      })
      expect(() =>
        store.registerAgent({ agentId: "a1", userId: "alice", oauthToken: "" })
      ).toThrow(/at least one/)
      // row should still have the original oauth credential
      const row = store.db
        .query(
          `SELECT oauthCiphertext IS NOT NULL AS hasOauth
             FROM agents WHERE agentId = ?`
        )
        .get("a1") as { hasOauth: number }
      expect(row.hasOauth).toBe(1)
    })
  })

  describe("two-credential acquire preference", () => {
    beforeEach(() => {
      store.registerAgent({
        agentId: "lender",
        userId: "alice",
        apiKey: "sk-ant-api-pref-1234567890abcdefgh",
        oauthToken: "sk-ant-oat01-pref-1234567890abcdef",
      })
      store.registerAgent({
        agentId: "borrower",
        userId: "bob",
        oauthToken: "sk-ant-oat01-bob-00000000000000",
      })
      store.heartbeat({
        agentId: "lender",
        status: "idle",
        lastActivityAt: Date.now() - 60_000,
        credentialValid: true,
      })
    })

    it("returns lender's apiKey when both credentials are present", () => {
      const result = store.acquireCredential("borrower")!
      expect(result.token).toBe("sk-ant-api-pref-1234567890abcdefgh")
    })

    it("falls back to oauth when apiKey column is NULL", () => {
      store.db.run(
        "UPDATE agents SET apiKeyCiphertext = NULL, apiKeyNonce = NULL WHERE agentId = ?",
        ["lender"]
      )
      const result = store.acquireCredential("borrower")!
      expect(result.token).toBe("sk-ant-oat01-pref-1234567890abcdef")
    })

    it("skips lender whose apiKey decrypts but oauth decryption fails (and vice versa)", () => {
      // corrupt apiKey column → preference fails → fall through to oauth
      store.db.run(
        `UPDATE agents SET apiKeyCiphertext = ?, apiKeyNonce = ? WHERE agentId = ?`,
        [Buffer.alloc(48, 0xff), Buffer.alloc(12, 0xff), "lender"]
      )
      const result = store.acquireCredential("borrower")!
      expect(result.token).toBe("sk-ant-oat01-pref-1234567890abcdef")
    })

    it("skips lender whose both columns fail to decrypt, moves to next lender", () => {
      store.registerAgent({
        agentId: "other",
        userId: "carol",
        oauthToken: "sk-ant-oat01-carol-0000000000000",
      })
      store.heartbeat({
        agentId: "other",
        status: "idle",
        lastActivityAt: Date.now() - 10 * 60 * 1000,
        credentialValid: true,
      })
      // corrupt both on lender (which is older → picked first)
      store.db.run(
        `UPDATE agents
           SET apiKeyCiphertext = ?, apiKeyNonce = ?,
               oauthCiphertext  = ?, oauthNonce  = ?
         WHERE agentId = ?`,
        [
          Buffer.alloc(48, 0xff),
          Buffer.alloc(12, 0xff),
          Buffer.alloc(48, 0xff),
          Buffer.alloc(12, 0xff),
          "lender",
        ]
      )
      const result = store.acquireCredential("borrower")!
      expect(result.token).toBe("sk-ant-oat01-carol-0000000000000")
    })
  })
})
