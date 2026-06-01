import { join } from "path"
import type { DaemonBackend, DaemonContext } from "./types"

// Fallback for hosts without a systemd user session: a detached background
// process tracked by a pidfile. No boot persistence or auto-restart, but it
// works anywhere (containers, WSL, bare shells).

const pidFile = (): string => join(process.env.HOME!, ".claude-pool", "agent.pid")

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readPid = async (): Promise<number | null> => {
  const file = Bun.file(pidFile())
  if (!(await file.exists())) return null
  const pid = parseInt((await file.text()).trim(), 10)
  return Number.isFinite(pid) ? pid : null
}

export const processBackend: DaemonBackend = {
  // Nothing to install; start() launches the process directly.
  async install() {},

  async uninstall() {
    await processBackend.stop({} as DaemonContext)
  },

  async start(ctx) {
    const existing = await readPid()
    if (existing && isRunning(existing)) return // already running

    const out = join(ctx.logDir, "agent.log")
    const err = join(ctx.logDir, "agent.err")
    // `nohup ... &` detaches the child so it outlives this CLI invocation;
    // `echo $!` reports its pid back on stdout.
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        'nohup "$1" run "$2" >> "$3" 2>> "$4" & echo $!',
        "sh",
        ctx.bunPath,
        ctx.entryPoint,
        out,
        err,
      ],
      { stdout: "pipe", stderr: "ignore" }
    )
    await proc.exited
    const pid = (await new Response(proc.stdout).text()).trim()
    await Bun.write(pidFile(), pid)
  },

  async stop() {
    const pid = await readPid()
    if (pid && isRunning(pid)) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // already gone
      }
    }
    const file = Bun.file(pidFile())
    if (await file.exists()) await Bun.spawn(["rm", pidFile()]).exited
  },
}
