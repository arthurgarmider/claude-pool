import { describe, it, expect, beforeEach } from "bun:test"
import { createStore } from "./store"

describe("store", () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore(":memory:")
  })

  describe("agents", () => {
    it("registers an agent with credentials", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      const agents = store.listAgents()
      expect(agents).toHaveLength(1)
      expect(agents[0].agentId).toBe("a1")
      expect(agents[0].userId).toBe("alice")
      expect(agents[0].token).toBe("tok-alice")
      expect(agents[0].status).toBe("idle")
    })

    it("overwrites credentials on re-register", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-old" })
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-new" })
      const agents = store.listAgents()
      expect(agents).toHaveLength(1)
      expect(agents[0].token).toBe("tok-new")
    })

    it("updates status via heartbeat", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      store.heartbeat({ agentId: "a1", status: "active", lastActivityAt: Date.now(), credentialValid: true })
      const agents = store.listAgents()
      expect(agents[0].status).toBe("active")
    })

    it("marks agents offline after timeout", () => {
      const old = Date.now() - 4 * 60 * 1000
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      store.heartbeat({ agentId: "a1", status: "active", lastActivityAt: old, credentialValid: true })
      store.db.run("UPDATE agents SET lastHeartbeatAt = ? WHERE agentId = ?", [old, "a1"])
      store.expireOfflineAgents(3 * 60 * 1000)
      const agents = store.listAgents()
      expect(agents[0].status).toBe("offline")
    })

    it("removes an agent", () => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      store.removeAgent("a1")
      expect(store.listAgents()).toHaveLength(0)
    })
  })

  describe("leases", () => {
    beforeEach(() => {
      store.registerAgent({ agentId: "a1", userId: "alice", token: "tok-alice" })
      store.registerAgent({ agentId: "a2", userId: "bob", token: "tok-bob" })
      store.heartbeat({ agentId: "a1", status: "idle", lastActivityAt: Date.now() - 20 * 60 * 1000, credentialValid: true })
      store.heartbeat({ agentId: "a2", status: "active", lastActivityAt: Date.now(), credentialValid: true })
    })

    it("returns idle credential with lease", () => {
      const result = store.acquireCredential("a2")
      expect(result).not.toBeNull()
      expect(result!.token).toBe("tok-alice")
      expect(result!.leaseId).toBeTruthy()
    })

    it("returns same credential for same requester (no double-allocate)", () => {
      const first = store.acquireCredential("a2")!
      const second = store.acquireCredential("a2")!
      expect(first.leaseId).toBe(second.leaseId)
      expect(first.token).toBe(second.token)
    })

    it("does not return requester's own credential", () => {
      store.heartbeat({ agentId: "a2", status: "idle", lastActivityAt: Date.now() - 30 * 60 * 1000, credentialValid: true })
      const result = store.acquireCredential("a2")
      expect(result).not.toBeNull()
      expect(result!.token).toBe("tok-alice")
    })

    it("returns null when no idle credentials available", () => {
      store.heartbeat({ agentId: "a1", status: "active", lastActivityAt: Date.now(), credentialValid: true })
      const result = store.acquireCredential("a2")
      expect(result).toBeNull()
    })

    it("releases a lease", () => {
      const result = store.acquireCredential("a2")!
      store.releaseLease(result.leaseId)
      const next = store.acquireCredential("a2")!
      expect(next.leaseId).not.toBe(result.leaseId)
    })

    it("expires old leases", () => {
      const result = store.acquireCredential("a2")!
      store.db.run("UPDATE leases SET leasedAt = ? WHERE id = ?", [Date.now() - 31 * 60 * 1000, result.leaseId])
      store.expireLeases(30 * 60 * 1000)
      const next = store.acquireCredential("a2")!
      expect(next.leaseId).not.toBe(result.leaseId)
    })

    it("prefers longest-idle agent", () => {
      store.registerAgent({ agentId: "a3", userId: "carol", token: "tok-carol" })
      store.heartbeat({ agentId: "a3", status: "idle", lastActivityAt: Date.now() - 60 * 60 * 1000, credentialValid: true })
      const result = store.acquireCredential("a2")
      expect(result!.token).toBe("tok-carol")
    })

    it("falls back to already-leased credential when all idle are leased", () => {
      store.acquireCredential("a2")
      store.registerAgent({ agentId: "a3", userId: "carol", token: "tok-carol" })
      store.heartbeat({ agentId: "a3", status: "active", lastActivityAt: Date.now(), credentialValid: true })
      const result = store.acquireCredential("a3")
      expect(result).not.toBeNull()
      expect(result!.token).toBe("tok-alice")
    })
  })
})
