import { trace } from "@claude-pool/shared/src/trace"

export const extractTokenFromKeychain = trace(
  "extractTokenFromKeychain",
  async (service = "Claude Code"): Promise<string> => {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-s", service, "-w"],
      { stdout: "pipe", stderr: "pipe" }
    )
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(
        `Failed to read keychain entry for service "${service}": ${stderr.trim()}`
      )
    }
    const token = (await new Response(proc.stdout).text()).trim()
    if (!token) {
      throw new Error(`Keychain entry for "${service}" is empty`)
    }
    return token
  }
)

export const extractToken = trace("extractToken", async (): Promise<string> => {
  try {
    return await extractTokenFromKeychain("Claude Code")
  } catch {
    throw new Error(
      "Could not extract Claude Code credentials. " +
      "Ensure Claude Code is installed and you have logged in at least once."
    )
  }
})
