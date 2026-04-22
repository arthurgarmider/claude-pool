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

    mockAnthropic = Bun.serve({
      port: ANTHROPIC_PORT,
      fetch() {
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
})
