import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { createStore } from "../packages/server/src/store"
import { createApp } from "../packages/server/src/routes"
import { createProxy } from "../packages/agent/src/proxy"

describe("integration: full failover flow", () => {
  let serverHandle: ReturnType<typeof Bun.serve>
  let mockAnthropic: ReturnType<typeof Bun.serve>
  let proxyHandle: ReturnType<typeof createProxy>
  let anthropicCallCount: number
  let anthropicResponses: Array<{ status: number; body: unknown }>

  const SERVER_PORT = 18001
  const ANTHROPIC_PORT = 18002
  const PROXY_PORT = 18003
  const SECRET = "integration-test-secret"

  beforeAll(async () => {
    anthropicCallCount = 0
    anthropicResponses = []

    // start mock Anthropic
    mockAnthropic = Bun.serve({
      port: ANTHROPIC_PORT,
      fetch() {
        const response = anthropicResponses[anthropicCallCount] || {
          status: 200,
          body: { content: "ok" },
        }
        anthropicCallCount++
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        })
      },
    })

    // start real server with in-memory DB
    const store = createStore(":memory:")
    const app = createApp(store, SECRET)
    serverHandle = Bun.serve({ port: SERVER_PORT, fetch: app.fetch })

    // register two agents: alice (will be idle), bob (will be active)
    await fetch(`http://localhost:${SERVER_PORT}/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        agentId: "alice-agent",
        userId: "alice",
        token: "alice-token",
      }),
    })
    await fetch(`http://localhost:${SERVER_PORT}/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        agentId: "bob-agent",
        userId: "bob",
        token: "bob-token",
      }),
    })

    // alice is idle
    await fetch(`http://localhost:${SERVER_PORT}/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        agentId: "alice-agent",
        status: "idle",
        lastActivityAt: 0,
        credentialValid: true,
      }),
    })
    // bob is active
    await fetch(`http://localhost:${SERVER_PORT}/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        agentId: "bob-agent",
        status: "active",
        lastActivityAt: Date.now(),
        credentialValid: true,
      }),
    })
  })

  afterAll(() => {
    proxyHandle?.stop()
    serverHandle?.stop()
    mockAnthropic?.stop()
  })

  it("bob's request fails with 429, proxy transparently retries with alice's credential", async () => {
    anthropicCallCount = 0
    anthropicResponses = [
      { status: 429, body: { error: "rate limited" } }, // bob's own token
      { status: 200, body: { content: "success via alice" } }, // alice's token
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
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250514",
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe("success via alice")
    expect(anthropicCallCount).toBe(2) // first attempt + retry
  })

  it("returns 429 with X-Pool-Exhausted when all credentials exhausted", async () => {
    // clean up previous proxy
    proxyHandle?.stop()

    anthropicCallCount = 0
    anthropicResponses = [
      { status: 429, body: { error: "rate limited" } }, // bob
      { status: 429, body: { error: "rate limited" } }, // alice
      { status: 429, body: { error: "rate limited" } }, // retry
      { status: 429, body: { error: "rate limited" } }, // retry
    ]

    const proxy2 = createProxy({
      port: PROXY_PORT + 1,
      anthropicBaseUrl: `http://localhost:${ANTHROPIC_PORT}`,
      serverUrl: `http://localhost:${SERVER_PORT}`,
      serverSecret: SECRET,
      maxRetries: 3,
      onActivity: () => {},
    })

    const res = await fetch(
      `http://localhost:${PROXY_PORT + 1}/v1/messages`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer bob-token",
          "Content-Type": "application/json",
          "X-Claude-Pool-Agent-Id": "bob-agent",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-5-20250514" }),
      }
    )

    expect(res.status).toBe(429)
    expect(res.headers.get("X-Pool-Exhausted")).toBe("true")
    proxy2.stop()
  })
})
