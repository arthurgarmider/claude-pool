// Shared parsing for the Claude Code OAuth credential blob. Both the macOS
// (Keychain) and Linux (~/.claude/.credentials.json) backends store the same
// JSON shape, so the extraction logic lives here.

export const parseOauthJson = (raw: string): string | null => {
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
