import { describe, it, expect } from "bun:test"
import { extractTokenFromKeychain, extractToken } from "./credentials"

describe("extractTokenFromKeychain", () => {
  it("extracts token from macOS keychain", async () => {
    // This test hits the real keychain — it will only pass on a Mac
    // with Claude Code configured. Skip in CI.
    if (process.env.CI) return

    const token = await extractTokenFromKeychain()
    expect(token).toBeTruthy()
    expect(typeof token).toBe("string")
    expect(token.length).toBeGreaterThan(10)
  })
})

describe("extractToken", () => {
  it("returns a token string", async () => {
    if (process.env.CI) return

    const token = await extractToken()
    expect(token).toBeTruthy()
    expect(typeof token).toBe("string")
  })

  it("throws with a clear message on failure", async () => {
    // extractTokenFromKeychain with a bogus service should fail
    expect(
      extractTokenFromKeychain("nonexistent-service-12345")
    ).rejects.toThrow()
  })
})
