import { describe, it, expect } from "bun:test"
import { parseConfig } from "./config"

const VALID_YAML = `
server:
  url: https://pool.example.com
  secret: my-secret
proxy:
  port: 9999
idle:
  threshold_minutes: 10
credentials:
  cache_ttl_minutes: 15
failover:
  max_retries: 5
`

const MINIMAL_YAML = `
server:
  url: https://pool.example.com
  secret: my-secret
`

describe("parseConfig", () => {
  it("parses full config", () => {
    const config = parseConfig(VALID_YAML)
    expect(config.server.url).toBe("https://pool.example.com")
    expect(config.server.secret).toBe("my-secret")
    expect(config.proxy.port).toBe(9999)
    expect(config.idle.thresholdMs).toBe(10 * 60 * 1000)
    expect(config.credentials.cacheTtlMs).toBe(15 * 60 * 1000)
    expect(config.failover.maxRetries).toBe(5)
  })

  it("applies defaults for optional fields", () => {
    const config = parseConfig(MINIMAL_YAML)
    expect(config.proxy.port).toBe(8484)
    expect(config.idle.thresholdMs).toBe(15 * 60 * 1000)
    expect(config.credentials.cacheTtlMs).toBe(30 * 60 * 1000)
    expect(config.failover.maxRetries).toBe(3)
  })

  it("throws on missing server.url", () => {
    expect(() => parseConfig("server:\n  secret: s")).toThrow()
  })

  it("throws on missing server.secret", () => {
    expect(() => parseConfig("server:\n  url: http://x")).toThrow()
  })
})
