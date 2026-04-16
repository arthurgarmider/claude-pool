#!/usr/bin/env bun
import { join } from "path"
import { loadConfigAsync } from "./config"
import { extractToken } from "./credentials"
import { installDaemon, uninstallDaemon, startDaemon, stopDaemon } from "./daemon"
import { DEFAULTS } from "@claude-pool/shared/src/types"

const CONFIG_DIR = join(process.env.HOME!, ".claude-pool")
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml")
const CLAUDE_SETTINGS_PATH = join(process.env.HOME!, ".claude", "settings.json")

const command = process.argv[2]

async function init() {
  const serverUrl = prompt("Server URL: ")
  if (!serverUrl) throw new Error("Server URL is required")

  const secret = prompt("Shared secret: ")
  if (!secret) throw new Error("Shared secret is required")

  const port = DEFAULTS.PROXY_PORT

  const yaml = `server:
  url: ${serverUrl}
  secret: ${secret}

proxy:
  port: ${port}

idle:
  threshold_minutes: 15

credentials:
  cache_ttl_minutes: 30

failover:
  max_retries: 3
`

  await Bun.spawn(["mkdir", "-p", CONFIG_DIR]).exited
  await Bun.write(CONFIG_PATH, yaml)

  // extract and register credentials
  const token = await extractToken()
  const agentId = crypto.randomUUID()
  const userId = process.env.USER || "unknown"

  const res = await fetch(`${serverUrl}/agents/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ agentId, userId, token }),
  })

  if (!res.ok) throw new Error(`Registration failed: ${res.status}`)

  // save agentId
  await Bun.write(join(CONFIG_DIR, "agent-id"), agentId)

  // configure Claude Code to use our proxy
  const settingsFile = Bun.file(CLAUDE_SETTINGS_PATH)
  const settings = (await settingsFile.exists())
    ? await settingsFile.json()
    : {}
  const env = settings.env || {}
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  env.ENABLE_TOOL_SEARCH = "true"
  await Bun.write(
    CLAUDE_SETTINGS_PATH,
    JSON.stringify({ ...settings, env }, null, 2)
  )

  console.log(`Config written to ${CONFIG_PATH}`)
  console.log(`Registered as ${userId} (${agentId})`)
  console.log(`Claude Code configured to use proxy at localhost:${port}`)
  console.log("Run 'claude-pool start' to start the agent daemon.")
}

async function status() {
  const config = await loadConfigAsync()
  const agentId = (await Bun.file(join(CONFIG_DIR, "agent-id")).text()).trim()

  const res = await fetch(`${config.server.url}/agents`, {
    headers: { Authorization: `Bearer ${config.server.secret}` },
  })
  const { agents } = (await res.json()) as {
    agents: Array<{
      agentId: string
      userId: string
      status: string
      lastActivityAt: number
    }>
  }

  const me = agents.find((a) => a.agentId === agentId)
  console.log(`Agent: ${me?.userId || "unknown"} (${agentId})`)
  console.log(`Status: ${me?.status || "not registered"}`)
  console.log(
    `Pool: ${agents.length} agents (${agents.filter((a) => a.status === "idle").length} idle)`
  )
}

async function pool() {
  const config = await loadConfigAsync()
  const res = await fetch(`${config.server.url}/agents`, {
    headers: { Authorization: `Bearer ${config.server.secret}` },
  })
  const { agents } = (await res.json()) as {
    agents: Array<{
      agentId: string
      userId: string
      status: string
      lastActivityAt: number
    }>
  }

  console.log(`${"USER".padEnd(15)} ${"STATUS".padEnd(10)} LAST ACTIVE`)
  console.log("-".repeat(50))
  for (const a of agents) {
    const ago = a.lastActivityAt
      ? `${Math.round((Date.now() - a.lastActivityAt) / 60000)}m ago`
      : "never"
    console.log(`${a.userId.padEnd(15)} ${a.status.padEnd(10)} ${ago}`)
  }
}

async function logs() {
  const logPath = join(CONFIG_DIR, "logs", "agent.log")
  const proc = Bun.spawn(["tail", "-f", logPath], {
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
}

async function uninstall() {
  await stopDaemon()
  await uninstallDaemon()

  // remove ANTHROPIC_BASE_URL from Claude Code settings
  const settingsFile = Bun.file(CLAUDE_SETTINGS_PATH)
  if (await settingsFile.exists()) {
    const settings = await settingsFile.json()
    if (settings.env) {
      const { ANTHROPIC_BASE_URL, ENABLE_TOOL_SEARCH, ...restEnv } =
        settings.env
      await Bun.write(
        CLAUDE_SETTINGS_PATH,
        JSON.stringify({ ...settings, env: restEnv }, null, 2)
      )
    }
  }

  console.log("Uninstalled. Claude Code proxy settings removed.")
}

const commands: Record<string, () => Promise<void>> = {
  init,
  start: async () => {
    await installDaemon()
    await startDaemon()
    console.log("Agent started.")
  },
  stop: async () => {
    await stopDaemon()
    console.log("Agent stopped.")
  },
  status,
  pool,
  logs,
  uninstall,
}

const handler = commands[command]
if (!handler) {
  console.log("Usage: claude-pool <command>")
  console.log("Commands: init, start, stop, status, pool, logs, uninstall")
  process.exit(1)
}

handler().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
