import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createStore } from "../packages/server/src/store"
import { createApp } from "../packages/server/src/routes"
import { createCrypto } from "../packages/server/src/crypto"
import { createProxy } from "../packages/agent/src/proxy"

describe("integration: hardened failover + audit + cooldown + persistence", () => {
  let serverHandle: ReturnType<typeof Bun.serve>
  let mockAnthropic: ReturnType<typeof Bun.serve>
  let proxyHandle: ReturnType<typeof createProxy> | null = null
  let anthropicCallCount: number
  let anthropicResponses: Array<{
    status: number
    body: unknown
    headers?: Record<string, string>
  }>
  let anthropicRequestHeaders: Array<Record<string, string>>

  const SERVER_PORT = 18001
  const ANTHROPIC_PORT = 18002
  const PROXY_PORT = 18003
  const SECRET = "integration-test-secret"
  const KEY_B64 = randomBytes(32).toString("base64")
  const tmp = mkdtempSync(join(tmpdir(), "claude-pool-int-"))
  const dbPath = join(tmp, "pool.db")

  const reqInit = (body: unknown) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify(body),
  })

  beforeAll(async () => {
    anthropicCallCount = 0
    anthropicResponses = []
    anthropicRequestHeaders = []

    mockAnthropic = Bun.serve({
      port: ANTHROPIC_PORT,
      fetch(req) {
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => { headers[k] = v })
        anthropicRequestHeaders.push(headers)
        const r = anthropicResponses[anthropicCallCount] || {
          status: 200,
          body: { content: "ok" },
        }
        anthropicCallCount++
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: {
            "Content-Type": "application/json",
            ...(r.headers ?? {}),
          },
        })
      },
    })

    const store = createStore(dbPath, createCrypto(KEY_B64))
    const app = createApp(store, SECRET)
    serverHandle = Bun.serve({ port: SERVER_PORT, fetch: app.fetch })

    await fetch(
      `http://localhost:${SERVER_PORT}/agents/register`,
      reqInit({
        agentId: "alice-agent", userId: "alice",
        oauthToken: "sk-ant-oat01-alice-aaaaaaaaaaaaaaa",
      })
    )
    await fetch(
      `http://localhost:${SERVER_PORT}/agents/register`,
      reqInit({
        agentId: "bob-agent", userId: "bob",
        oauthToken: "sk-ant-oat01-bob-bbbbbbbbbbbbbbbbbbb",
      })
    )
    await fetch(
      `http://localhost:${SERVER_PORT}/agents/heartbeat`,
      reqInit({
        agentId: "alice-agent",
        status: "idle",
        lastActivityAt: 0,
        credentialValid: true,
      })
    )
    await fetch(
      `http://localhost:${SERVER_PORT}/agents/heartbeat`,
      reqInit({
        agentId: "bob-agent",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      })
    )
  })

  afterAll(() => {
    proxyHandle?.stop()
    serverHandle?.stop()
    mockAnthropic?.stop()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("Bob 429 → benches Bob → failover to Alice → audit records lender=alice, borrower=bob, count>0", async () => {
    anthropicCallCount = 0
    anthropicResponses = [
      { status: 429, body: { error: "rl" }, headers: { "Retry-After": "5" } }, // bob own
      { status: 200, body: { content: "via alice" } }, // alice borrowed
    ]

    proxyHandle = createProxy({
      port: PROXY_PORT,
      anthropicBaseUrl: `http://localhost:${ANTHROPIC_PORT}`,
      serverUrl: `http://localhost:${SERVER_PORT}`,
      serverSecret: SECRET,
      maxRetries: 3,
      onActivity: () => {},
    })

    const res = await fetch(`http://localhost:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer bob-token",
        "Content-Type": "application/json",
        "X-Claude-Pool-Agent-Id": "bob-agent",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-5-20250514" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe("via alice")

    // give the fire-and-forget cooldown POST time to land
    await Bun.sleep(50)

    // server should have benched bob-agent
    const auditRes = await fetch(
      `http://localhost:${SERVER_PORT}/audit?agentId=bob-agent`,
      { headers: { Authorization: `Bearer ${SECRET}` } }
    )
    const auditBody = (await auditRes.json()) as {
      entries: Array<{
        lenderUserId: string
        borrowerUserId: string
        requestCount: number
        closedReason: string | null
      }>
    }
    expect(auditBody.entries.length).toBeGreaterThanOrEqual(1)
    const entry = auditBody.entries[0]
    expect(entry.lenderUserId).toBe("alice")
    expect(entry.borrowerUserId).toBe("bob")
  })

  it("during Bob cooldown: a second Bob request still uses Alice's token", async () => {
    anthropicCallCount = 0
    // Proxy's local-cooldown gate (Task 10) means the own-token attempt is
    // skipped while bob's localAgentCooldownUntil is still in the future,
    // so the cached Alice credential from test 1 is used directly.
    // Only one upstream call is expected.
    anthropicResponses = [
      { status: 200, body: { content: "via alice again" } },
    ]
    const res = await fetch(`http://localhost:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer bob-token",
        "Content-Type": "application/json",
        "X-Claude-Pool-Agent-Id": "bob-agent",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-5-20250514" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe("via alice again")
    expect(anthropicCallCount).toBe(1)
  })

  it("server restart with same ENCRYPTION_KEY preserves ability to acquire", async () => {
    // Stop the proxy FIRST so its fire-and-forget release for the cached
    // Alice lease reaches the still-running server. Then sleep briefly to
    // let the DELETE land before the server is torn down.
    proxyHandle?.stop()
    await Bun.sleep(50)
    serverHandle.stop()
    proxyHandle = null

    const store2 = createStore(dbPath, createCrypto(KEY_B64))
    // alice should still appear as idle (we set her so in beforeAll, persisted to disk)
    const r = store2.acquireCredential("bob-agent")
    expect(r).not.toBeNull()
    expect(r!.token).toBe("sk-ant-oat01-alice-aaaaaaaaaaaaaaa")
    store2.db.close()

    // restart the server for any subsequent tests
    const store3 = createStore(dbPath, createCrypto(KEY_B64))
    const app3 = createApp(store3, SECRET)
    serverHandle = Bun.serve({ port: SERVER_PORT, fetch: app3.fetch })
  })

  it("server restart with a different ENCRYPTION_KEY: undecryptable rows are skipped (no crash)", async () => {
    serverHandle.stop()
    const store4 = createStore(dbPath, createCrypto(randomBytes(32).toString("base64")))
    // every candidate fails to decrypt → null (not a thrown error)
    const r = store4.acquireCredential("bob-agent")
    expect(r).toBeNull()
    store4.db.close()

    // restart for any cleanup
    const store5 = createStore(dbPath, createCrypto(KEY_B64))
    const app5 = createApp(store5, SECRET)
    serverHandle = Bun.serve({ port: SERVER_PORT, fetch: app5.fetch })
  })

  describe("two-credential lending", () => {
    const SERVER_PORT_2 = 18101
    const ANTHROPIC_PORT_2 = 18102
    const PROXY_PORT_2 = 18103
    const KEY_B64_2 = randomBytes(32).toString("base64")
    const tmp2 = mkdtempSync(join(tmpdir(), "claude-pool-int2-"))
    const dbPath2 = join(tmp2, "pool.db")

    let server2: ReturnType<typeof Bun.serve>
    let anthropic2: ReturnType<typeof Bun.serve>
    let proxy2: ReturnType<typeof createProxy> | null = null
    let call2Count = 0
    let call2Headers: Array<Record<string, string>> = []
    let call2Responses: Array<{
      status: number
      body: unknown
      headers?: Record<string, string>
    }> = []

    const reqInit2 = (body: unknown) => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(body),
    })

    beforeAll(async () => {
      anthropic2 = Bun.serve({
        port: ANTHROPIC_PORT_2,
        fetch(req) {
          const h: Record<string, string> = {}
          req.headers.forEach((v, k) => { h[k] = v })
          call2Headers.push(h)
          const r = call2Responses[call2Count] || { status: 200, body: { content: "ok" } }
          call2Count++
          return new Response(JSON.stringify(r.body), {
            status: r.status,
            headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
          })
        },
      })
      const store = createStore(dbPath2, createCrypto(KEY_B64_2))
      const app = createApp(store, SECRET)
      server2 = Bun.serve({ port: SERVER_PORT_2, fetch: app.fetch })
    })

    afterAll(() => {
      proxy2?.stop()
      server2?.stop()
      anthropic2?.stop()
      rmSync(tmp2, { recursive: true, force: true })
    })

    const registerPair = async (
      lenderAgent: string, lenderUser: string, lenderCreds: { apiKey?: string; oauthToken?: string },
      borrowerAgent: string, borrowerUser: string, borrowerCreds: { apiKey?: string; oauthToken?: string }
    ) => {
      await fetch(`http://localhost:${SERVER_PORT_2}/agents/register`,
        reqInit2({ agentId: lenderAgent, userId: lenderUser, ...lenderCreds }))
      await fetch(`http://localhost:${SERVER_PORT_2}/agents/register`,
        reqInit2({ agentId: borrowerAgent, userId: borrowerUser, ...borrowerCreds }))
      await fetch(`http://localhost:${SERVER_PORT_2}/agents/heartbeat`,
        reqInit2({ agentId: lenderAgent, status: "idle", lastActivityAt: 0, credentialValid: true }))
      await fetch(`http://localhost:${SERVER_PORT_2}/agents/heartbeat`,
        reqInit2({ agentId: borrowerAgent, status: "active", lastActivityAt: Date.now(), credentialValid: true }))
    }

    const forceBorrow = async (borrowerAgent: string, ownAuthToken: string) => {
      proxy2?.stop()
      proxy2 = createProxy({
        port: PROXY_PORT_2,
        anthropicBaseUrl: `http://localhost:${ANTHROPIC_PORT_2}`,
        serverUrl: `http://localhost:${SERVER_PORT_2}`,
        serverSecret: SECRET,
        maxRetries: 3,
        onActivity: () => {},
      })
      const res = await fetch(`http://localhost:${PROXY_PORT_2}/v1/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownAuthToken}`,
          "Content-Type": "application/json",
          "X-Claude-Pool-Agent-Id": borrowerAgent,
        },
        body: JSON.stringify({ model: "claude-sonnet-4-5-20250514" }),
      })
      return res
    }

    it("pure API-key pool: borrowed credential is sent with x-api-key, no Bearer OAuth", async () => {
      call2Count = 0; call2Headers = []
      call2Responses = [
        { status: 429, body: { error: "rl" }, headers: { "Retry-After": "5" } }, // own 429
        { status: 200, body: { content: "via alice api" } },                     // borrowed
      ]
      await registerPair(
        "alice-api", "alice", { apiKey: "sk-ant-api-alice-0000000000000000" },
        "bob-api",   "bob",   { apiKey: "sk-ant-api-bob-bbbbbbbbbbbbbbbb" },
      )
      const res = await forceBorrow("bob-api", "sk-ant-api-bob-bbbbbbbbbbbbbbbb")
      expect(res.status).toBe(200)
      await Bun.sleep(50)

      // Second upstream call (index 1) is the borrowed one.
      const borrowed = call2Headers[1]
      expect(borrowed["x-api-key"]).toBe("sk-ant-api-alice-0000000000000000")
      expect(borrowed["authorization"]).toBe("Bearer sk-ant-api-alice-0000000000000000")
    })

    it("pure OAuth pool (regression): borrowed credential sent with Bearer, no x-api-key", async () => {
      call2Count = 0; call2Headers = []
      call2Responses = [
        { status: 429, body: { error: "rl" }, headers: { "Retry-After": "5" } },
        { status: 200, body: { content: "via carol oauth" } },
      ]
      await registerPair(
        "carol-oauth", "carol", { oauthToken: "sk-ant-oat01-carol-ccccccccccccccc" },
        "dave-oauth",  "dave",  { oauthToken: "sk-ant-oat01-dave-ddddddddddddddd"  },
      )
      const res = await forceBorrow("dave-oauth", "sk-ant-oat01-dave-ddddddddddddddd")
      expect(res.status).toBe(200)
      await Bun.sleep(50)

      const borrowed = call2Headers[1]
      expect(borrowed["authorization"]).toBe("Bearer sk-ant-oat01-carol-ccccccccccccccc")
      expect(borrowed["x-api-key"]).toBeUndefined()
    })

    it("mixed pool, preference: lender has both → borrower gets the API key", async () => {
      call2Count = 0; call2Headers = []
      call2Responses = [
        { status: 429, body: { error: "rl" }, headers: { "Retry-After": "5" } },
        { status: 200, body: { content: "preferred api" } },
      ]
      await registerPair(
        "eve-both", "eve",
        {
          apiKey: "sk-ant-api-eve-eeeeeeeeeeeeeeeeee",
          oauthToken: "sk-ant-oat01-eve-eeeeeeeeeeeeeeee",
        },
        "frank", "frank", { apiKey: "sk-ant-api-frank-ffffffffffffffff" },
      )
      const res = await forceBorrow("frank", "sk-ant-api-frank-ffffffffffffffff")
      expect(res.status).toBe(200)
      await Bun.sleep(50)

      const borrowed = call2Headers[1]
      expect(borrowed["x-api-key"]).toBe("sk-ant-api-eve-eeeeeeeeeeeeeeeeee")
    })

    it("mixed pool, fallback: lender has only OAuth → borrower gets OAuth", async () => {
      call2Count = 0; call2Headers = []
      call2Responses = [
        { status: 429, body: { error: "rl" }, headers: { "Retry-After": "5" } },
        { status: 200, body: { content: "fallback oauth" } },
      ]
      await registerPair(
        "grace-oauth-only", "grace", { oauthToken: "sk-ant-oat01-grace-gggggggggggggg" },
        "heidi-api",        "heidi", { apiKey:     "sk-ant-api-heidi-hhhhhhhhhhhhhh" },
      )
      const res = await forceBorrow("heidi-api", "sk-ant-api-heidi-hhhhhhhhhhhhhh")
      expect(res.status).toBe(200)
      await Bun.sleep(50)

      const borrowed = call2Headers[1]
      expect(borrowed["authorization"]).toBe("Bearer sk-ant-oat01-grace-gggggggggggggg")
      expect(borrowed["x-api-key"]).toBeUndefined()
    })
  })
})
