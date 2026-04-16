import { describe, it, expect } from "bun:test"
import { createHeartbeat } from "./heartbeat"

describe("heartbeat", () => {
  it("starts as idle", () => {
    const hb = createHeartbeat("a1", 15 * 60 * 1000)
    expect(hb.getStatus()).toBe("idle")
  })

  it("becomes active after recording activity", () => {
    const hb = createHeartbeat("a1", 15 * 60 * 1000)
    hb.recordActivity()
    expect(hb.getStatus()).toBe("active")
  })

  it("becomes idle after threshold passes", () => {
    const hb = createHeartbeat("a1", 100) // 100ms threshold for testing
    hb.recordActivity()
    expect(hb.getStatus()).toBe("active")
    // busy wait past threshold
    const start = Date.now()
    while (Date.now() - start < 150) {}
    expect(hb.getStatus()).toBe("idle")
  })

  it("builds heartbeat payload", () => {
    const hb = createHeartbeat("a1", 15 * 60 * 1000)
    hb.recordActivity()
    const payload = hb.getPayload(true)
    expect(payload.agentId).toBe("a1")
    expect(payload.status).toBe("active")
    expect(payload.credentialValid).toBe(true)
    expect(payload.lastActivityAt).toBeGreaterThan(0)
  })
})
