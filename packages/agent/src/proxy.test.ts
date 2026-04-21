import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createProxy } from "./proxy"

let mockUpstream: ReturnType<typeof Bun.serve>
let callCount: number
let mockResponses: Array<{
  status: number
  body: unknown
  headers?: Record<string, string>
}>

let mockPoolServer: ReturnType<typeof Bun.serve>
let poolCredentials: Array<{ token: string; leaseId: string }>
let poolCalls: Array<{ method: string; path: string; body: unknown }>

beforeEach(() => {
  callCount = 0
  mockResponses = []
  poolCredentials = []
  poolCalls = []

  mockUpstream = Bun.serve({
    port: 19001,
    fetch() {
      const response = mockResponses[callCount] || { status: 200, body: { ok: true } }
      callCount++
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "Content-Type": "application/json", ...(response.headers ?? {}) },
      })
    },
  })

  mockPoolServer = Bun.serve({
    port: 19002,
    async fetch(req) {
      const url = new URL(req.url)
      let body: unknown = undefined
      if (req.method === "POST") {
        const text = await req.text()
        body = text ? JSON.parse(text) : undefined
      }
      poolCalls.push({ method: req.method, path: url.pathname + url.search, body })

      if (
        req.method === "GET" &&
        url.pathname === "/credentials/available" &&
        poolCredentials.length > 0
      ) {
        return new Response(JSON.stringify(poolCredentials.shift()))
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/credentials/lease/")) {
        return new Response(JSON.stringify({ ok: true }))
      }
      if (
        req.method === "POST" &&
        url.pathname.startsWith("/credentials/lease/") &&
        url.pathname.endsWith("/cooldown")
      ) {
        return new Response(JSON.stringify({ ok: true }))
      }
      if (
        req.method === "POST" &&
        url.pathname.startsWith("/agents/") &&
        url.pathname.endsWith("/cooldown")
      ) {
        return new Response(JSON.stringify({ ok: true }))
      }
      return new Response(JSON.stringify({ error: "no credentials" }), { status: 404 })
    },
  })
})

afterEach(() => {
  mockUpstream.stop()
  mockPoolServer.stop()
})

describe("proxy", () => {
  it("passes through successful requests", async () => {
    mockResponses = [{ status: 200, body: { content: "hello" } }]
    const proxy = createProxy({
      port: 19003,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19002",
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => {},
    })
    const res = await fetch("http://localhost:19003/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer my-token", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    proxy.stop()
  })

  it("on 429 from own token: POSTs /agents/:id/cooldown then enters failover", async () => {
    mockResponses = [
      { status: 429, body: { error: "rate limited" }, headers: { "Retry-After": "42" } },
      { status: 200, body: { content: "from pool" } },
    ]
    poolCredentials = [{ token: "borrowed-token", leaseId: "lease-1" }]

    const proxy = createProxy({
      port: 19004,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19002",
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => {},
    })

    const res = await fetch("http://localhost:19004/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer my-token",
        "Content-Type": "application/json",
        "X-Claude-Pool-Agent-Id": "bob-agent",
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const agentCooldown = poolCalls.find(
      (c) => c.method === "POST" && c.path === "/agents/bob-agent/cooldown"
    )
    expect(agentCooldown).toBeDefined()
    expect(agentCooldown!.body).toEqual({ retryAfterSeconds: 42 })
    proxy.stop()
  })

  it("on 429 from borrowed credential: POSTs /credentials/lease/:id/cooldown with Retry-After", async () => {
    mockResponses = [
      { status: 429, body: { error: "rl" } }, // own
      { status: 429, body: { error: "rl" }, headers: { "Retry-After": "17" } }, // borrowed
      { status: 200, body: { content: "third try" } },
    ]
    poolCredentials = [
      { token: "borrowed-1", leaseId: "lease-1" },
      { token: "borrowed-2", leaseId: "lease-2" },
    ]
    const proxy = createProxy({
      port: 19005,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19002",
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => {},
    })

    const res = await fetch("http://localhost:19005/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer my-token",
        "Content-Type": "application/json",
        "X-Claude-Pool-Agent-Id": "bob-agent",
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const leaseCooldown = poolCalls.find(
      (c) =>
        c.method === "POST" &&
        c.path === "/credentials/lease/lease-1/cooldown"
    )
    expect(leaseCooldown).toBeDefined()
    expect((leaseCooldown!.body as any).retryAfterSeconds).toBe(17)
    expect((leaseCooldown!.body as any).count).toBe(0)
    proxy.stop()
  })

  it("on 429 borrowed without Retry-After: cooldown body has retryAfterSeconds=0", async () => {
    mockResponses = [
      { status: 429, body: { error: "rl" } }, // own
      { status: 429, body: { error: "rl" } }, // borrowed
      { status: 200, body: { content: "ok" } },
    ]
    poolCredentials = [
      { token: "borrowed-1", leaseId: "lease-1" },
      { token: "borrowed-2", leaseId: "lease-2" },
    ]
    const proxy = createProxy({
      port: 19006,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19002",
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => {},
    })
    await fetch("http://localhost:19006/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer my-token",
        "Content-Type": "application/json",
        "X-Claude-Pool-Agent-Id": "bob-agent",
      },
      body: JSON.stringify({}),
    })
    const cd = poolCalls.find(
      (c) =>
        c.method === "POST" &&
        c.path === "/credentials/lease/lease-1/cooldown"
    )
    expect((cd!.body as any).retryAfterSeconds).toBe(0)
    proxy.stop()
  })

  it("clean release sends accumulated count via ?count=N", async () => {
    // every call succeeds via the borrowed credential after the first 429
    mockResponses = [
      { status: 429, body: { error: "rl" } }, // own (request 1)
      { status: 200, body: { content: "ok-1" } }, // borrowed (request 1 retry)
      { status: 200, body: { content: "ok-2" } }, // borrowed (request 2)
      { status: 200, body: { content: "ok-3" } }, // borrowed (request 3)
    ]
    poolCredentials = [{ token: "borrowed-1", leaseId: "lease-1" }]
    const proxy = createProxy({
      port: 19007,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19002",
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => {},
    })
    for (let i = 0; i < 3; i++) {
      await fetch("http://localhost:19007/v1/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer my-token",
          "Content-Type": "application/json",
          "X-Claude-Pool-Agent-Id": "bob-agent",
        },
        body: JSON.stringify({}),
      })
    }
    proxy.stop()
    // wait for the async release fired by stop()
    await Bun.sleep(50)
    const release = poolCalls.find(
      (c) =>
        c.method === "DELETE" &&
        c.path.startsWith("/credentials/lease/lease-1")
    )
    expect(release).toBeDefined()
    expect(release!.path).toContain("count=3")
  })

  it("returns 429 with X-Pool-Exhausted when pool is empty", async () => {
    mockResponses = [{ status: 429, body: { error: "rl" } }]
    const proxy = createProxy({
      port: 19008,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19002",
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => {},
    })
    const res = await fetch("http://localhost:19008/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer my-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get("X-Pool-Exhausted")).toBe("true")
    proxy.stop()
  })

  it("calls onActivity for every request", async () => {
    mockResponses = [{ status: 200, body: { ok: true } }]
    let activityCount = 0
    const proxy = createProxy({
      port: 19009,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19002",
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => { activityCount++ },
    })
    await fetch("http://localhost:19009/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer my-token", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(activityCount).toBe(1)
    proxy.stop()
  })
})
