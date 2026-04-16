import { describe, it, expect, beforeEach } from "bun:test"
import { createApp } from "./routes"
import { createStore } from "./store"

describe("routes", () => {
  let app: ReturnType<typeof createApp>
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore(":memory:")
    app = createApp(store, "test-secret")
  })

  const req = (method: string, path: string, body?: unknown) =>
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

  describe("auth", () => {
    it("rejects requests without valid secret", async () => {
      const res = await app.fetch(new Request("http://localhost/health"))
      expect(res.status).toBe(401)
    })
  })

  describe("POST /agents/register", () => {
    it("registers an agent", async () => {
      const res = await app.fetch(req("POST", "/agents/register", {
        agentId: "a1", userId: "alice", token: "tok-alice",
      }))
      expect(res.status).toBe(200)
    })

    it("rejects invalid payload", async () => {
      const res = await app.fetch(req("POST", "/agents/register", { agentId: "" }))
      expect(res.status).toBe(400)
    })
  })

  describe("POST /agents/heartbeat", () => {
    it("accepts heartbeat from registered agent", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", token: "tok" }))
      const res = await app.fetch(req("POST", "/agents/heartbeat", {
        agentId: "a1", status: "active", lastActivityAt: Date.now(), credentialValid: true,
      }))
      expect(res.status).toBe(200)
    })
  })

  describe("GET /credentials/available", () => {
    it("returns idle credential with lease", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", token: "tok-alice" }))
      await app.fetch(req("POST", "/agents/register", { agentId: "a2", userId: "bob", token: "tok-bob" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a2", status: "active", lastActivityAt: Date.now(), credentialValid: true }))

      const res = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.token).toBe("tok-alice")
      expect(body.leaseId).toBeTruthy()
    })

    it("returns 404 when no credentials available", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", token: "tok" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "active", lastActivityAt: Date.now(), credentialValid: true }))
      const res = await app.fetch(req("GET", "/credentials/available?agentId=a1"))
      expect(res.status).toBe(404)
    })
  })

  describe("DELETE /credentials/lease/:id", () => {
    it("releases a lease", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", token: "tok-alice" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(req("POST", "/agents/register", { agentId: "a2", userId: "bob", token: "tok-bob" }))

      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      const { leaseId } = await acq.json()

      const res = await app.fetch(req("DELETE", `/credentials/lease/${leaseId}`))
      expect(res.status).toBe(200)
    })
  })

  describe("GET /agents", () => {
    it("lists all agents without exposing tokens", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", token: "tok" }))
      const res = await app.fetch(req("GET", "/agents"))
      const body = await res.json()
      expect(body.agents).toHaveLength(1)
      expect(body.agents[0].agentId).toBe("a1")
      expect(body.agents[0].token).toBeUndefined()
    })
  })

  describe("DELETE /agents/:id", () => {
    it("removes an agent", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", token: "tok" }))
      const res = await app.fetch(req("DELETE", "/agents/a1"))
      expect(res.status).toBe(200)
      const list = await app.fetch(req("GET", "/agents"))
      const body = await list.json()
      expect(body.agents).toHaveLength(0)
    })
  })

  describe("GET /health", () => {
    it("returns ok with auth", async () => {
      const res = await app.fetch(req("GET", "/health"))
      expect(res.status).toBe(200)
    })
  })
})
