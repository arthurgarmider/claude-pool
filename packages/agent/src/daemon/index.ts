import { join } from "path"
import { mkdir } from "node:fs/promises"
import { trace } from "@claude-pool/shared/src/trace"
import type { DaemonBackend, DaemonContext } from "./types"
import { launchdBackend } from "./launchd"
import { systemdBackend, systemdUserAvailable } from "./systemd"
import { processBackend } from "./process"

const buildContext = async (): Promise<DaemonContext> => {
  const bunPath = Bun.which("bun") || "/usr/local/bin/bun"
  // index.ts (the agent entry point) lives one level up from this directory.
  const entryPoint = join(import.meta.dir, "..", "index.ts")
  const logDir = join(process.env.HOME!, ".claude-pool/logs")
  await mkdir(logDir, { recursive: true })
  return { bunPath, entryPoint, logDir }
}

// Picks launchd on macOS, systemd on Linux when a user session is available,
// and a plain background process otherwise.
const selectBackend = async (): Promise<DaemonBackend> => {
  if (process.platform === "darwin") return launchdBackend
  if (await systemdUserAvailable()) return systemdBackend
  return processBackend
}

export const installDaemon = trace("daemon.install", async () => {
  const ctx = await buildContext()
  await (await selectBackend()).install(ctx)
})

export const uninstallDaemon = trace("daemon.uninstall", async () => {
  const ctx = await buildContext()
  await (await selectBackend()).uninstall(ctx)
})

export const startDaemon = trace("daemon.start", async () => {
  const ctx = await buildContext()
  await (await selectBackend()).start(ctx)
})

export const stopDaemon = trace("daemon.stop", async () => {
  const ctx = await buildContext()
  await (await selectBackend()).stop(ctx)
})

export { selectBackend }
