// Platform-agnostic contract for reading secrets. macOS reads the system
// Keychain; Linux reads Claude Code's credential file / libsecret / an
// encrypted fallback file. Callers (credentials.ts) never branch on platform.

export interface CredentialStore {
  /** Raw secret stored under a named service entry, or null if absent. */
  read(service: string): Promise<string | null>
  /** The Claude Code OAuth access token, or null if not logged in. */
  readClaudeCodeOauth(): Promise<string | null>
}
