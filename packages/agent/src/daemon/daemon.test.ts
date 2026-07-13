import { describe, it, expect, afterEach } from "bun:test"
import { generateUnit } from "./systemd"
import { launchdBackend } from "./launchd"
import { selectBackend } from "./index"
import type { DaemonContext } from "./types"

const ctx: DaemonContext = {
  bunPath: "/usr/bin/bun",
  entryPoint: "/home/me/.bun/install/global/node_modules/@claudepool/agent/dist/index.ts",
  logDir: "/home/me/.claude-pool/logs",
}

describe("generateUnit (systemd)", () => {
  const unit = generateUnit(ctx)

  it("runs the agent via bun", () => {
    expect(unit).toContain(`ExecStart=${ctx.bunPath} run ${ctx.entryPoint}`)
  })

  it("restarts on failure and logs to the agent log dir", () => {
    expect(unit).toContain("Restart=always")
    expect(unit).toContain(`StandardOutput=append:${ctx.logDir}/agent.log`)
    expect(unit).toContain(`StandardError=append:${ctx.logDir}/agent.err`)
  })

  it("installs into the default user target", () => {
    expect(unit).toContain("WantedBy=default.target")
  })
})

describe("selectBackend", () => {
  const realPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform })
  })

  it("uses launchd on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    expect(await selectBackend()).toBe(launchdBackend)
  })
})
