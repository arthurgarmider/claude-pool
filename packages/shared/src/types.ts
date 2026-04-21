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

export const CooldownPayloadSchema = z.object({
  retryAfterSeconds: z.number().int().min(0).max(86400),
  count: z.number().int().min(0).optional(),
})
export type CooldownPayload = z.infer<typeof CooldownPayloadSchema>

export const AgentCooldownPayloadSchema = z.object({
  retryAfterSeconds: z.number().int().min(0).max(86400),
})
export type AgentCooldownPayload = z.infer<typeof AgentCooldownPayloadSchema>

// --- Server Responses ---

// NOTE: `token: string` is REMOVED. Plaintext tokens never leave the store
// except inline inside `acquireCredential`'s return value. `listAgents()` rows
// no longer carry the token. The `/agents` route already stripped it.
export type AgentRecord = {
  agentId: string
  userId: string
  status: AgentStatus
  registeredAt: number
  lastHeartbeatAt: number
  lastActivityAt: number
  cooldownUntil: number | null
}

export type LeaseRecord = {
  id: string
  credentialAgentId: string
  leasedTo: string
  leasedAt: number
  ttl: number
  releasedAt: number | null
  requestCount: number
  closedReason: "released" | "expired" | "cooldown" | null
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
    cooldownUntil: number | null
  }>
}

export type AuditEntry = {
  leaseId: string
  lenderAgentId: string
  lenderUserId: string
  borrowerAgentId: string
  borrowerUserId: string
  leasedAt: number
  releasedAt: number | null
  durationMs: number
  requestCount: number
  closedReason: "released" | "expired" | "cooldown" | null
}
export type AuditResponse = { entries: AuditEntry[] }

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
  DEFAULT_COOLDOWN_MS: 60 * 1000,
  // Hard cap (24h) on any Retry-After we'll honor — matches the server-side
  // Zod schema (.max(86400)) and prevents a hostile/buggy upstream from
  // benching an agent for years.
  MAX_RETRY_AFTER_SECONDS: 86400,
  AUDIT_DEFAULT_LIMIT: 100,
  AUDIT_MAX_LIMIT: 1000,
} as const
