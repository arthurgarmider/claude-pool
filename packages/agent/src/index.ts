import { join } from "path"
import { loadConfigAsync } from "./config"
import { extractToken } from "./credentials"
import { createHeartbeat, startHeartbeatLoop } from "./heartbeat"
import { createProxy } from "./proxy"
import { DEFAULTS } from "@claude-pool/shared/src/types"

const CONFIG_DIR = join(process.env.HOME!, ".claude-pool")

async function main() {
  const config = await loadConfigAsync()
  const agentId = (
    await Bun.file(join(CONFIG_DIR, "agent-id")).text()
  ).trim()

  const token = await extractToken()
  let credentialValid = true

  // register with server
  const registerRes = await fetch(`${config.server.url}/agents/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.server.secret}`,
    },
    body: JSON.stringify({
      agentId,
      userId: process.env.USER || "unknown",
      token,
    }),
  })
  if (!registerRes.ok) {
    throw new Error(`Registration failed: ${registerRes.status}`)
  }

  const heartbeat = createHeartbeat(agentId, config.idle.thresholdMs)

  const proxy = createProxy({
    port: config.proxy.port,
    anthropicBaseUrl: DEFAULTS.ANTHROPIC_API_BASE,
    serverUrl: config.server.url,
    serverSecret: config.server.secret,
    maxRetries: config.failover.maxRetries,
    onActivity: () => heartbeat.recordActivity(),
  })

  startHeartbeatLoop(
    heartbeat,
    config.server.url,
    config.server.secret,
    DEFAULTS.HEARTBEAT_INTERVAL_MS,
    () => credentialValid
  )

  // periodic credential refresh
  setInterval(async () => {
    try {
      const freshToken = await extractToken()
      await fetch(`${config.server.url}/agents/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.server.secret}`,
        },
        body: JSON.stringify({
          agentId,
          userId: process.env.USER || "unknown",
          token: freshToken,
        }),
      })
      credentialValid = true
    } catch {
      credentialValid = false
    }
  }, 10 * 60 * 1000) // every 10 minutes

  // cleanup on shutdown
  const cleanup = () => {
    proxy.stop()
    process.exit(0)
  }
  process.on("SIGTERM", cleanup)
  process.on("SIGINT", cleanup)

  console.log(
    `claude-pool agent running — proxy on :${config.proxy.port}, heartbeat every 60s`
  )
}

main().catch((e) => {
  console.error("agent failed to start:", e.message)
  process.exit(1)
})
