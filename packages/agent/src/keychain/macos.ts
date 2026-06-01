import type { CredentialStore } from "./types"
import { parseOauthJson } from "./oauth"

// Reads a generic-password entry from the macOS Keychain via the `security` CLI.
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

export class MacOSKeychainStore implements CredentialStore {
  read(service: string): Promise<string | null> {
    return readKeychain(service)
  }

  async readClaudeCodeOauth(): Promise<string | null> {
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
}
