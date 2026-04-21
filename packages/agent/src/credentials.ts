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
    // claudeAiOauth may be an object or a JSON string
    const inner = typeof oauth === "string" ? JSON.parse(oauth) : oauth
    return inner?.accessToken ?? null
  } catch {
    return null
  }
}

export const extractTokenFromKeychain = trace(
  "extractTokenFromKeychain",
  async (service: string): Promise<string> => {
    const raw = await readKeychain(service)
    if (!raw) {
      throw new Error(`Keychain entry for "${service}" not found or empty`)
    }
    return raw
  }
)

export const extractToken = trace("extractToken", async (): Promise<string> => {
  // 1. Explicit env var (CI, manual setup, Cursor-injected)
  const envKey = process.env.ANTHROPIC_API_KEY
  if (envKey?.startsWith("sk-")) return envKey

  // 2. Current Claude Code: OAuth token stored as JSON
  const oauthRaw = await readKeychain("Claude Code-credentials")
  if (oauthRaw) {
    const token = parseOauthJson(oauthRaw)
    if (token) return token
  }

  // 3. Legacy Claude Code: plain API key in keychain
  const legacyRaw = await readKeychain("Claude Code")
  if (legacyRaw?.startsWith("sk-")) return legacyRaw

  throw new Error(
    "Could not extract Claude Code credentials. " +
    "Ensure Claude Code is installed and you are logged in, or set ANTHROPIC_API_KEY."
  )
})
