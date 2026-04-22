import { trace } from "@claude-pool/shared/src/trace"

const readKeychain = async (service: string): Promise<string | null> => {
  const proc = Bun.spawn(
    ["security", "find-generic-password", "-s", service, "-w"],
    { stdout: "pipe", stderr: "pipe" }
  )
  const exitCode = await proc.exited
  if (exitCode !== 0) return null
  const raw = (await new Response(proc.stdout).text()).trim()
  return raw || null
}

const parseOauthJson = (raw: string): string | null => {
  try {
    const parsed = JSON.parse(raw)
    const oauth = parsed?.claudeAiOauth
    if (!oauth) return null
    const inner = typeof oauth === "string" ? JSON.parse(oauth) : oauth
    return inner?.accessToken ?? null
  } catch {
    return null
  }
}

const readOauthFromKeychain = async (): Promise<string | null> => {
  // Current Claude Code: OAuth JSON in "Claude Code-credentials".
  const oauthRaw = await readKeychain("Claude Code-credentials")
  if (oauthRaw) {
    const token = parseOauthJson(oauthRaw)
    if (token) return token
  }
  // Legacy Claude Code: plain API key in "Claude Code".
  const legacyRaw = await readKeychain("Claude Code")
  if (legacyRaw?.startsWith("sk-")) return legacyRaw
  return null
}

// Kept for backward-compat: tests + any caller that just wants an OAuth token
// out of the keychain. Throws if missing. Does not consult env.
export const extractTokenFromKeychain = trace(
  "extractTokenFromKeychain",
  async (service?: string): Promise<string> => {
    if (service) {
      const raw = await readKeychain(service)
      if (!raw) {
        throw new Error(`Keychain entry for "${service}" not found or empty`)
      }
      return raw
    }
    const token = await readOauthFromKeychain()
    if (!token) {
      throw new Error(
        "Could not extract Claude Code OAuth token from macOS Keychain."
      )
    }
    return token
  }
)

// Legacy helper. Prefer collectCredentials() for new code. Kept so the
// refresh loop in index.ts can still be incrementally migrated.
export const extractToken = trace(
  "extractToken",
  async (): Promise<string> => {
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

    // API key: flag → env
    if (opts.explicitApiKey && opts.explicitApiKey.startsWith("sk-ant-api")) {
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
