import type { CredentialStore } from "./types"
import { MacOSKeychainStore } from "./macos"
import { LinuxCredentialStore } from "./linux"

export type { CredentialStore } from "./types"
export { parseOauthJson } from "./oauth"

let cached: CredentialStore | null = null

// Returns the credential store for the current platform. macOS uses the
// Keychain; everything else uses the Linux backend (Claude Code's credential
// file, libsecret, or an encrypted fallback).
export const getCredentialStore = (): CredentialStore => {
  if (cached) return cached
  cached =
    process.platform === "darwin"
      ? new MacOSKeychainStore()
      : new LinuxCredentialStore()
  return cached
}
