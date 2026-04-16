import { join } from "path"
import { trace } from "@claude-pool/shared/src/trace"

const PLIST_NAME = "com.claude-pool.agent"
const PLIST_PATH = join(
  process.env.HOME!,
  "Library/LaunchAgents",
  `${PLIST_NAME}.plist`
)

const generatePlist = (bunPath: string, entryPoint: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${entryPoint}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${process.env.HOME}/.claude-pool/logs/agent.log</string>
  <key>StandardErrorPath</key>
  <string>${process.env.HOME}/.claude-pool/logs/agent.err</string>
</dict>
</plist>`

export const installDaemon = trace("daemon.install", async () => {
  const bunPath = Bun.which("bun") || "/usr/local/bin/bun"
  const entryPoint = join(import.meta.dir, "index.ts")

  // ensure log directory exists
  const logDir = join(process.env.HOME!, ".claude-pool/logs")
  await Bun.spawn(["mkdir", "-p", logDir]).exited

  await Bun.write(PLIST_PATH, generatePlist(bunPath, entryPoint))
  await Bun.spawn(["launchctl", "load", PLIST_PATH]).exited
})

export const uninstallDaemon = trace("daemon.uninstall", async () => {
  try {
    await Bun.spawn(["launchctl", "unload", PLIST_PATH]).exited
  } catch {
    // may not be loaded
  }
  const file = Bun.file(PLIST_PATH)
  if (await file.exists()) {
    await Bun.spawn(["rm", PLIST_PATH]).exited
  }
})

export const startDaemon = trace("daemon.start", async () => {
  await Bun.spawn(["launchctl", "start", PLIST_NAME]).exited
})

export const stopDaemon = trace("daemon.stop", async () => {
  await Bun.spawn(["launchctl", "stop", PLIST_NAME]).exited
})
