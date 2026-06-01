import { join } from "path"
import type { CredentialStore } from "./types"
import { parseOauthJson } from "./oauth"
import { EncryptedFileStore } from "./encrypted-file"

// Looks a secret up via libsecret's `secret-tool`, if it is installed. Returns
// null when the tool is absent or the attribute set is not found.
const secretToolLookup = async (
  attrs: Record<string, string>
): Promise<string | null> => {
  if (!Bun.which("secret-tool")) return null
  const pairs = Object.entries(attrs).flatMap(([k, v]) => [k, v])
  const proc = Bun.spawn(["secret-tool", "lookup", ...pairs], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) return null
  const raw = (await new Response(proc.stdout).text()).trim()
  return raw || null
}

export type LinuxStoreOptions = {
  /** Override the Claude Code credentials file (defaults to ~/.claude/.credentials.json). */
  claudeCredentialsPath?: string
  /** Override the encrypted fallback store. */
  encryptedStore?: EncryptedFileStore
}

export class LinuxCredentialStore implements CredentialStore {
  private readonly claudeCredentialsPath: string
  private readonly encrypted: EncryptedFileStore

  constructor(opts: LinuxStoreOptions = {}) {
    this.claudeCredentialsPath =
      opts.claudeCredentialsPath ??
      join(process.env.HOME!, ".claude", ".credentials.json")
    this.encrypted = opts.encryptedStore ?? new EncryptedFileStore()
  }

  async read(service: string): Promise<string | null> {
    const fromSecretTool = await secretToolLookup({ service })
    if (fromSecretTool) return fromSecretTool
    return this.encrypted.read(service)
  }

  async readClaudeCodeOauth(): Promise<string | null> {
    // Preferred: libsecret, if Claude Code stored its token there.
    const fromSecretTool = await secretToolLookup({
      service: "Claude Code-credentials",
    })
    if (fromSecretTool) {
      const token = parseOauthJson(fromSecretTool)
      if (token) return token
    }

    // Default on Linux: Claude Code writes a plain JSON file.
    const file = Bun.file(this.claudeCredentialsPath)
    if (await file.exists()) {
      const token = parseOauthJson(await file.text())
      if (token) return token
    }
    return null
  }
}
