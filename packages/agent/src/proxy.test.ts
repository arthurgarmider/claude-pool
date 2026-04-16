import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createProxy } from "./proxy"

let mockUpstream: ReturnType<typeof Bun.serve>
let callCount: number
let mockResponses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>

let mockPoolServer: ReturnType<typeof Bun.serve>
let poolCredentials: Array<{ token: string; leaseId: string }>

beforeEach(() => {
  callCount = 0
  mockResponses = []
  poolCredentials = []

  mockUpstream = Bun.serve({
    port: 19001,
    fetch() {
      const response = mockResponses[callCount] || { status: 200, body: { ok: true } }
      callCount++
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "Content-Type": "application/json", ...response.headers },
      })
    },
  })

  mockPoolServer = Bun.serve({
    port: 19002,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/credentials/available" && poolCredentials.length > 0) {
        return new Response(JSON.stringify(poolCredentials.shift()))
      }
      if (url.pathname.startsWith("/credentials/lease/")) {
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
      body: JSON.stringify({ model: "claude-sonnet-4-5-20250514" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe("hello")
    proxy.stop()
  })

  it("retries with pool credential on 429", async () => {
    mockResponses = [
      { status: 429, body: { error: "rate limited" } },
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
      headers: { Authorization: "Bearer my-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5-20250514" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe("from pool")
    expect(callCount).toBe(2)
    proxy.stop()
  })

  it("returns 429 with X-Pool-Exhausted when pool is empty", async () => {
    mockResponses = [{ status: 429, body: { error: "rate limited" } }]

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
      headers: { Authorization: "Bearer my-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5-20250514" }),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get("X-Pool-Exhausted")).toBe("true")
    proxy.stop()
  })

  it("calls onActivity for every request", async () => {
    mockResponses = [{ status: 200, body: { ok: true } }]
    let activityCount = 0

    const proxy = createProxy({
      port: 19006,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19002",
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => { activityCount++ },
    })

    await fetch("http://localhost:19006/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer my-token", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(activityCount).toBe(1)
    proxy.stop()
  })

  it("handles server unreachable — returns original 429", async () => {
    mockResponses = [{ status: 429, body: { error: "rate limited" } }]

    const proxy = createProxy({
      port: 19007,
      anthropicBaseUrl: "http://localhost:19001",
      serverUrl: "http://localhost:19999", // nothing listening
      serverSecret: "secret",
      maxRetries: 3,
      onActivity: () => {},
    })

    const res = await fetch("http://localhost:19007/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer my-token", "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(429)
    proxy.stop()
  })
})
