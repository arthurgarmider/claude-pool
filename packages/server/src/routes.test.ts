import { describe, it, expect, beforeEach } from "bun:test"
import { randomBytes } from "node:crypto"
import { createApp } from "./routes"
import { createStore } from "./store"
import { createCrypto } from "./crypto"

const KEY_B64 = randomBytes(32).toString("base64")

describe("routes", () => {
  let app: ReturnType<typeof createApp>
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore(":memory:", createCrypto(KEY_B64))
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
        agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa",
      }))
      expect(res.status).toBe(200)
    })

    it("accepts apiKey only", async () => {
      const res = await app.fetch(req("POST", "/agents/register", {
        agentId: "a1", userId: "alice",
        apiKey: "sk-ant-api-key-12345678901234567890",
      }))
      expect(res.status).toBe(200)
    })

    it("accepts oauthToken only", async () => {
      const res = await app.fetch(req("POST", "/agents/register", {
        agentId: "a1", userId: "alice",
        oauthToken: "sk-ant-oat01-abcdefghijklmnopqrst",
      }))
      expect(res.status).toBe(200)
    })

    it("rejects payload with neither apiKey nor oauthToken", async () => {
      const res = await app.fetch(req("POST", "/agents/register", {
        agentId: "a1", userId: "alice",
      }))
      expect(res.status).toBe(400)
    })

    it("rejects invalid payload (missing userId)", async () => {
      const res = await app.fetch(req("POST", "/agents/register", { agentId: "a1" }))
      expect(res.status).toBe(400)
    })
  })

  describe("POST /agents/heartbeat", () => {
    it("accepts heartbeat from registered agent", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-xxxxxxxxxxxxxxxxx" }))
      const res = await app.fetch(req("POST", "/agents/heartbeat", {
        agentId: "a1", status: "active", lastActivityAt: Date.now(), credentialValid: true,
      }))
      expect(res.status).toBe(200)
    })
  })

  describe("GET /credentials/available", () => {
    it("returns idle credential with lease", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa" }))
      await app.fetch(req("POST", "/agents/register", { agentId: "a2", userId: "bob", oauthToken: "tok-bob-bbbbbbbbbbbbbbb" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a2", status: "active", lastActivityAt: Date.now(), credentialValid: true }))

      const res = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.token).toBe("tok-alice-aaaaaaaaaaaa")
      expect(body.leaseId).toBeTruthy()
    })

    it("returns 404 when no credentials available", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-xxxxxxxxxxxxxxxxx" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "active", lastActivityAt: Date.now(), credentialValid: true }))
      const res = await app.fetch(req("GET", "/credentials/available?agentId=a1"))
      expect(res.status).toBe(404)
    })
  })

  describe("DELETE /credentials/lease/:id", () => {
    beforeEach(async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(req("POST", "/agents/register", { agentId: "a2", userId: "bob", oauthToken: "tok-bob-bbbbbbbbbbbbbbb" }))
    })

    it("releases a lease with no count → requestCount=0", async () => {
      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      const { leaseId } = await acq.json()
      const res = await app.fetch(req("DELETE", `/credentials/lease/${leaseId}`))
      expect(res.status).toBe(200)
      const row = store.db
        .query("SELECT requestCount FROM leases WHERE id = ?")
        .get(leaseId) as { requestCount: number }
      expect(row.requestCount).toBe(0)
    })

    it("releases a lease with ?count=12 → requestCount=12", async () => {
      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      const { leaseId } = await acq.json()
      const res = await app.fetch(
        req("DELETE", `/credentials/lease/${leaseId}?count=12`)
      )
      expect(res.status).toBe(200)
      const row = store.db
        .query("SELECT requestCount FROM leases WHERE id = ?")
        .get(leaseId) as { requestCount: number }
      expect(row.requestCount).toBe(12)
    })

    it("ignores invalid count values → requestCount=0", async () => {
      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      const { leaseId } = await acq.json()
      const res = await app.fetch(
        req("DELETE", `/credentials/lease/${leaseId}?count=not-a-number`)
      )
      expect(res.status).toBe(200)
      const row = store.db
        .query("SELECT requestCount FROM leases WHERE id = ?")
        .get(leaseId) as { requestCount: number }
      expect(row.requestCount).toBe(0)
    })

    it("clamps negative count to 0", async () => {
      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      const { leaseId } = await acq.json()
      const res = await app.fetch(
        req("DELETE", `/credentials/lease/${leaseId}?count=-5`)
      )
      expect(res.status).toBe(200)
      const row = store.db
        .query("SELECT requestCount FROM leases WHERE id = ?")
        .get(leaseId) as { requestCount: number }
      expect(row.requestCount).toBe(0)
    })
  })

  describe("POST /credentials/lease/:id/cooldown", () => {
    beforeEach(async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(req("POST", "/agents/register", { agentId: "a2", userId: "bob", oauthToken: "tok-bob-bbbbbbbbbbbbbbb" }))
    })

    it("benches the lender so subsequent acquire from same borrower returns 404", async () => {
      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      const { leaseId } = await acq.json()
      const res = await app.fetch(
        req("POST", `/credentials/lease/${leaseId}/cooldown`, {
          retryAfterSeconds: 60,
          count: 3,
        })
      )
      expect(res.status).toBe(200)

      const acq2 = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      expect(acq2.status).toBe(404)
    })

    it("rejects negative retryAfterSeconds with 400", async () => {
      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      const { leaseId } = await acq.json()
      const res = await app.fetch(
        req("POST", `/credentials/lease/${leaseId}/cooldown`, {
          retryAfterSeconds: -1,
        })
      )
      expect(res.status).toBe(400)
    })

    it("rejects retryAfterSeconds > 86400 with 400", async () => {
      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      const { leaseId } = await acq.json()
      const res = await app.fetch(
        req("POST", `/credentials/lease/${leaseId}/cooldown`, {
          retryAfterSeconds: 100_000,
        })
      )
      expect(res.status).toBe(400)
    })
  })

  describe("POST /agents/:id/cooldown", () => {
    beforeEach(async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(req("POST", "/agents/register", { agentId: "a2", userId: "bob", oauthToken: "tok-bob-bbbbbbbbbbbbbbb" }))
    })

    it("benches an agent independently of any lease", async () => {
      const res = await app.fetch(
        req("POST", "/agents/a1/cooldown", { retryAfterSeconds: 60 })
      )
      expect(res.status).toBe(200)
      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      expect(acq.status).toBe(404)
    })

    it("rejects invalid payload with 400", async () => {
      const res = await app.fetch(
        req("POST", "/agents/a1/cooldown", { retryAfterSeconds: 1.5 })
      )
      expect(res.status).toBe(400)
    })
  })

  describe("GET /audit", () => {
    beforeEach(async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(req("POST", "/agents/register", { agentId: "a2", userId: "bob", oauthToken: "tok-bob-bbbbbbbbbbbbbbb" }))
      await app.fetch(req("GET", "/credentials/available?agentId=a2"))
    })

    it("admin view (no agentId) returns all entries", async () => {
      const res = await app.fetch(req("GET", "/audit"))
      expect(res.status).toBe(200)
      const body = await res.json() as { entries: Array<{ borrowerUserId: string }> }
      expect(body.entries).toHaveLength(1)
      expect(body.entries[0].borrowerUserId).toBe("bob")
    })

    it("scopes by agentId (lender or borrower)", async () => {
      const res = await app.fetch(req("GET", "/audit?agentId=a1"))
      const body = await res.json() as { entries: unknown[] }
      expect(body.entries).toHaveLength(1)
      const empty = await app.fetch(req("GET", "/audit?agentId=does-not-exist"))
      const emptyBody = await empty.json() as { entries: unknown[] }
      expect(emptyBody.entries).toHaveLength(0)
    })

    it("respects since and limit", async () => {
      const future = await app.fetch(
        req("GET", `/audit?since=${Date.now() + 60_000}`)
      )
      const futureBody = await future.json() as { entries: unknown[] }
      expect(futureBody.entries).toHaveLength(0)
    })

    it("clamps limit to AUDIT_MAX_LIMIT", async () => {
      const res = await app.fetch(req("GET", "/audit?limit=999999"))
      expect(res.status).toBe(200)
      // we can't easily verify clamping at the response shape; use a separate
      // test in store.test.ts. Here we just confirm the route doesn't 500.
    })

    it("non-numeric since/limit fall back to defaults (no rows missed, cap respected)", async () => {
      const res = await app.fetch(
        req("GET", "/audit?since=not-a-number&limit=also-junk")
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { entries: unknown[] }
      // Without the NaN guard, since=NaN would yield 0 rows and limit=NaN
      // would silently bypass the AUDIT_MAX_LIMIT cap. With the guard,
      // since defaults to 0 and limit to AUDIT_DEFAULT_LIMIT, so the one
      // active lease created in beforeEach is returned normally.
      expect(body.entries).toHaveLength(1)
    })
  })

  describe("GET /agents", () => {
    it("lists all agents without exposing tokens", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-xxxxxxxxxxxxxxxxx" }))
      const res = await app.fetch(req("GET", "/agents"))
      const body = await res.json()
      expect(body.agents).toHaveLength(1)
      expect(body.agents[0].agentId).toBe("a1")
      expect(body.agents[0].token).toBeUndefined()
    })
  })

  describe("DELETE /agents/:id", () => {
    it("removes an agent", async () => {
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-xxxxxxxxxxxxxxxxx" }))
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

  describe("GET /dashboard", () => {
    const unauth = (path: string) =>
      new Request(`http://localhost${path}`, { method: "GET" })

    it("serves HTML without auth", async () => {
      const res = await app.fetch(unauth("/dashboard"))
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type") ?? "").toContain("text/html")
      const body = await res.text()
      expect(body).toContain("<!doctype html>")
      expect(body).toContain("claude-pool")
    })

    it("does not leak the AUTH_SECRET into the HTML", async () => {
      const res = await app.fetch(unauth("/dashboard"))
      const body = await res.text()
      expect(body).not.toContain("test-secret")
    })

    it("does not weaken auth on /agents", async () => {
      const res = await app.fetch(unauth("/agents"))
      expect(res.status).toBe(401)
    })

    it("does not weaken auth on /audit", async () => {
      const res = await app.fetch(unauth("/audit"))
      expect(res.status).toBe(401)
    })
  })

  describe("GET /metrics", () => {
    const unauth = (path: string) =>
      new Request(`http://localhost${path}`, { method: "GET" })

    it("requires auth when METRICS_PUBLIC is unset", async () => {
      delete process.env.METRICS_PUBLIC
      const res = await app.fetch(unauth("/metrics"))
      expect(res.status).toBe(401)
    })

    it("returns Prometheus text with auth", async () => {
      delete process.env.METRICS_PUBLIC
      const res = await app.fetch(req("GET", "/metrics"))
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type") ?? "").toContain("text/plain")
      const body = await res.text()
      expect(body).toContain("claudepool_agents_total")
      expect(body).toContain("claudepool_leases_open")
      expect(body).toContain("claudepool_leases_total")
      expect(body).toContain("claudepool_429s_total")
      expect(body).toContain("claudepool_request_duration_seconds")
    })

    it("serves unauthenticated when METRICS_PUBLIC=true", async () => {
      process.env.METRICS_PUBLIC = "true"
      try {
        const res = await app.fetch(unauth("/metrics"))
        expect(res.status).toBe(200)
        const body = await res.text()
        expect(body).toContain("claudepool_agents_total")
      } finally {
        delete process.env.METRICS_PUBLIC
      }
    })

    it("increments claudepool_leases_total after acquire", async () => {
      delete process.env.METRICS_PUBLIC
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(req("POST", "/agents/register", { agentId: "a2", userId: "bob", oauthToken: "tok-bob-bbbbbbbbbbbbbbb" }))

      const acq = await app.fetch(req("GET", "/credentials/available?agentId=a2"))
      expect(acq.status).toBe(200)

      const res = await app.fetch(req("GET", "/metrics"))
      const body = await res.text()
      expect(body).toMatch(/^claudepool_leases_total 1$/m)
    })

    it("increments claudepool_429s_total on cooldown", async () => {
      delete process.env.METRICS_PUBLIC
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(
        req("POST", "/agents/a1/cooldown", { retryAfterSeconds: 60 }),
      )

      const res = await app.fetch(req("GET", "/metrics"))
      const body = await res.text()
      expect(body).toMatch(/^claudepool_429s_total\{scope="agent"\} 1$/m)
    })

    it("reports cooling agents in claudepool_agents_total", async () => {
      delete process.env.METRICS_PUBLIC
      await app.fetch(req("POST", "/agents/register", { agentId: "a1", userId: "alice", oauthToken: "tok-alice-aaaaaaaaaaaa" }))
      await app.fetch(req("POST", "/agents/heartbeat", { agentId: "a1", status: "idle", lastActivityAt: 0, credentialValid: true }))
      await app.fetch(
        req("POST", "/agents/a1/cooldown", { retryAfterSeconds: 60 }),
      )

      const res = await app.fetch(req("GET", "/metrics"))
      const body = await res.text()
      expect(body).toMatch(/^claudepool_agents_total\{state="cooling"\} 1$/m)
      expect(body).toMatch(/^claudepool_agents_total\{state="idle"\} 0$/m)
    })
  })
})
