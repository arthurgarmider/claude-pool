import { join } from "path"
import type { DaemonBackend, DaemonContext } from "./types"

const PLIST_NAME = "com.claude-pool.agent"
const plistPath = (): string =>
  join(process.env.HOME!, "Library/LaunchAgents", `${PLIST_NAME}.plist`)

const generatePlist = (ctx: DaemonContext): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ctx.bunPath}</string>
    <string>run</string>
    <string>${ctx.entryPoint}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${ctx.logDir}/agent.log</string>
  <key>StandardErrorPath</key>
  <string>${ctx.logDir}/agent.err</string>
</dict>
</plist>`

export const launchdBackend: DaemonBackend = {
  async install(ctx) {
    await Bun.write(plistPath(), generatePlist(ctx))
    await Bun.spawn(["launchctl", "load", plistPath()]).exited
  },
  async uninstall() {
    try {
      await Bun.spawn(["launchctl", "unload", plistPath()]).exited
    } catch {
      // may not be loaded
    }
    const file = Bun.file(plistPath())
    if (await file.exists()) {
      await Bun.spawn(["rm", plistPath()]).exited
    }
  },
  async start() {
    await Bun.spawn(["launchctl", "start", PLIST_NAME]).exited
  },
  async stop() {
    await Bun.spawn(["launchctl", "stop", PLIST_NAME]).exited
  },
}
