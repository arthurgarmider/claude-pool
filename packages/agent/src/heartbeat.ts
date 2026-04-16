import { trace } from "@claude-pool/shared/src/trace"
import type { HeartbeatPayload } from "@claude-pool/shared/src/types"

export function createHeartbeat(agentId: string, idleThresholdMs: number) {
  let lastActivityAt = 0

  const recordActivity = () => {
    lastActivityAt = Date.now()
  }

  const getStatus = (): "active" | "idle" => {
    if (lastActivityAt === 0) return "idle"
    return Date.now() - lastActivityAt < idleThresholdMs ? "active" : "idle"
  }

  const getPayload = (credentialValid: boolean): HeartbeatPayload => ({
    agentId,
    status: getStatus(),
    lastActivityAt,
    credentialValid,
  })

  const sendHeartbeat = trace(
    "heartbeat.send",
    async (serverUrl: string, secret: string, credentialValid: boolean) => {
      const res = await fetch(`${serverUrl}/agents/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(getPayload(credentialValid)),
      })
      if (!res.ok) {
        throw new Error(`heartbeat failed: ${res.status}`)
      }
    }
  )

  return { recordActivity, getStatus, getPayload, sendHeartbeat }
}

export function startHeartbeatLoop(
  heartbeat: ReturnType<typeof createHeartbeat>,
  serverUrl: string,
  secret: string,
  intervalMs: number,
  credentialValid: () => boolean
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    heartbeat.sendHeartbeat(serverUrl, secret, credentialValid()).catch(() => {})
  }, intervalMs)
}
