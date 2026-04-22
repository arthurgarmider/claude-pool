import { describe, it, expect, afterEach } from "bun:test"
import { extractTokenFromKeychain, extractToken, collectCredentials } from "./credentials"

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

describe("collectCredentials", () => {
  const savedEnv = process.env.ANTHROPIC_API_KEY
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedEnv
  })

  it("returns {apiKey} from explicit flag, ignoring env + keychain", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-env-value-00000000000000"
    const creds = await collectCredentials({
      explicitApiKey: "sk-ant-api-flag-value-0000000000000",
      apiKeyOnly: true, // ensure keychain is skipped in this environment
    })
    expect(creds.apiKey).toBe("sk-ant-api-flag-value-0000000000000")
    expect(creds.oauthToken).toBeUndefined()
  })

  it("returns {apiKey} from env when no flag given, with apiKeyOnly=true (no keychain)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-env-value-00000000000000"
    const creds = await collectCredentials({ apiKeyOnly: true })
    expect(creds.apiKey).toBe("sk-ant-api-env-value-00000000000000")
    expect(creds.oauthToken).toBeUndefined()
  })

  it("throws with a clear message when nothing is available", async () => {
    delete process.env.ANTHROPIC_API_KEY
    // apiKeyOnly=true means keychain is not even attempted, so if env is
    // missing the function must throw with the user-facing error.
    await expect(collectCredentials({ apiKeyOnly: true })).rejects.toThrow(
      /ANTHROPIC_API_KEY|Claude Code/
    )
  })

  it("ignores env values that do not start with sk-ant-api", async () => {
    process.env.ANTHROPIC_API_KEY = "not-an-anthropic-key"
    await expect(collectCredentials({ apiKeyOnly: true })).rejects.toThrow()
  })

  it("throws immediately when explicit apiKey has an invalid prefix", async () => {
    await expect(
      collectCredentials({
        explicitApiKey: "sk-bogus-0000000000000000",
        apiKeyOnly: true,
      })
    ).rejects.toThrow(/Invalid API key/)
  })
})
