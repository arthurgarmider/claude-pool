import { join } from "path"
import { mkdir } from "node:fs/promises"
import type { DaemonBackend, DaemonContext } from "./types"

export const UNIT_NAME = "claude-pool.service"

const unitDir = (): string =>
  join(
    process.env.XDG_CONFIG_HOME || join(process.env.HOME!, ".config"),
    "systemd/user"
  )
const unitPath = (): string => join(unitDir(), UNIT_NAME)

export const generateUnit = (ctx: DaemonContext): string =>
  `[Unit]
Description=claude-pool agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${ctx.bunPath} run ${ctx.entryPoint}
Restart=always
RestartSec=5
StandardOutput=append:${ctx.logDir}/agent.log
StandardError=append:${ctx.logDir}/agent.err

[Install]
WantedBy=default.target
`

const systemctl = (...args: string[]) =>
  Bun.spawn(["systemctl", "--user", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  }).exited

// True when a systemd user session is reachable (systemctl present and the
// user manager answers). Used by the dispatcher to fall back to a plain
// background process on hosts without a user session (minimal containers, WSL).
export const systemdUserAvailable = async (): Promise<boolean> => {
  if (!Bun.which("systemctl")) return false
  try {
    const code = await Bun.spawn(["systemctl", "--user", "show-environment"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited
    return code === 0
  } catch {
    return false
  }
}

export const systemdBackend: DaemonBackend = {
  async install(ctx) {
    await mkdir(unitDir(), { recursive: true })
    await Bun.write(unitPath(), generateUnit(ctx))
    await systemctl("daemon-reload")
  },
  async uninstall() {
    await systemctl("disable", "--now", UNIT_NAME)
    const file = Bun.file(unitPath())
    if (await file.exists()) {
      await Bun.spawn(["rm", unitPath()]).exited
    }
    await systemctl("daemon-reload")
  },
  async start() {
    await systemctl("enable", "--now", UNIT_NAME)
  },
  async stop() {
    await systemctl("stop", UNIT_NAME)
  },
}
