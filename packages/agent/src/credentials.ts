import { trace } from "@claude-pool/shared/src/trace"
import { getCredentialStore } from "./keychain"

const readOauthFromKeychain = (): Promise<string | null> =>
  getCredentialStore().readClaudeCodeOauth()

// Kept for backward-compat: tests + any caller that just wants the Claude Code
// OAuth token (or a named secret) out of the platform credential store. Throws
// if missing. Does not consult env.
export const extractTokenFromKeychain = trace(
  "extractTokenFromKeychain",
  async (service?: string): Promise<string> => {
    if (service) {
      const raw = await getCredentialStore().read(service)
      if (!raw) {
        throw new Error(`Credential entry for "${service}" not found or empty`)
      }
      return raw
    }
    const token = await readOauthFromKeychain()
    if (!token) {
      throw new Error("Could not read the Claude Code OAuth token.")
    }
    return token
  }
)

// Legacy helper. Prefer collectCredentials() for new code. Kept so the
// refresh loop in index.ts can still be incrementally migrated.
export const extractToken = trace(
  "extractToken",
  async (): Promise<string> => {
    // Lenient: accept any sk-* (legacy OAuth tokens start sk-ant-oat*)
    const envKey = process.env.ANTHROPIC_API_KEY
    if (envKey?.startsWith("sk-")) return envKey
    const oauth = await readOauthFromKeychain()
    if (oauth) return oauth
    throw new Error(
      "Could not extract Claude Code credentials. " +
        "Ensure Claude Code is installed and you are logged in, or set ANTHROPIC_API_KEY."
    )
  }
)

export type AgentCredentials = {
  apiKey?: string
  oauthToken?: string
}

export type CollectOpts = {
  /** If true, never read the Claude Code keychain. */
  apiKeyOnly?: boolean
  /** Highest-priority source for the API key (CLI flag or interactive prompt). */
  explicitApiKey?: string
}

export const collectCredentials = trace(
  "collectCredentials",
  async (opts: CollectOpts = {}): Promise<AgentCredentials> => {
    const result: AgentCredentials = {}

    // Strict: apiKey field is reserved for Anthropic API keys (sk-ant-api*).
    if (opts.explicitApiKey) {
      if (!opts.explicitApiKey.startsWith("sk-ant-api")) {
        throw new Error(
          `Invalid API key: must start with "sk-ant-api". ` +
            `Got prefix: "${opts.explicitApiKey.slice(0, 10)}…"`
        )
      }
      result.apiKey = opts.explicitApiKey
    } else {
      const envKey = process.env.ANTHROPIC_API_KEY
      if (envKey && envKey.startsWith("sk-ant-api")) {
        result.apiKey = envKey
      }
    }

    // OAuth: keychain only (unless apiKeyOnly)
    if (!opts.apiKeyOnly) {
      const oauth = await readOauthFromKeychain()
      if (oauth) {
        result.oauthToken = oauth
      }
    }

    if (!result.apiKey && !result.oauthToken) {
      throw new Error(
        "No credentials found. Set ANTHROPIC_API_KEY or log into Claude Code " +
          "(or pass --api-key sk-ant-api-…)."
      )
    }
    return result
  }
)
