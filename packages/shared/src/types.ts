import { z } from "zod"

// --- Agent Status ---

export type AgentStatus = "active" | "idle" | "offline"

// --- API Payloads ---

export const RegisterPayloadSchema = z.object({
  agentId: z.string().min(1),
  userId: z.string().min(1),
  token: z.string().min(1),
})
export type RegisterPayload = z.infer<typeof RegisterPayloadSchema>

export const HeartbeatPayloadSchema = z.object({
  agentId: z.string().min(1),
  status: z.enum(["active", "idle"]),
  lastActivityAt: z.number(),
  credentialValid: z.boolean(),
})
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>

// --- Server Responses ---

export type AgentRecord = {
  agentId: string
  userId: string
  token: string
  status: AgentStatus
  registeredAt: number
  lastHeartbeatAt: number
  lastActivityAt: number
}

export type LeaseRecord = {
  id: string
  credentialAgentId: string
  leasedTo: string
  leasedAt: number
  ttl: number
}

export type AvailableCredentialResponse = {
  token: string
  leaseId: string
}

export type AgentListResponse = {
  agents: Array<{
    agentId: string
    userId: string
    status: AgentStatus
    lastActivityAt: number
  }>
}

// --- Constants ---

export const DEFAULTS = {
  PROXY_PORT: 8484,
  SERVER_PORT: 3847,
  IDLE_THRESHOLD_MS: 15 * 60 * 1000,
  HEARTBEAT_INTERVAL_MS: 60 * 1000,
  OFFLINE_THRESHOLD_MS: 3 * 60 * 1000,
  LEASE_TTL_MS: 30 * 60 * 1000,
  MAX_FAILOVER_RETRIES: 3,
  ANTHROPIC_API_BASE: "https://api.anthropic.com",
} as const
