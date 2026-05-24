import { Hono } from "hono"
import {
  RegisterPayloadSchema,
  HeartbeatPayloadSchema,
  CooldownPayloadSchema,
  AgentCooldownPayloadSchema,
  DEFAULTS,
} from "@claude-pool/shared/src/types"
import type { createStore } from "./store"
import { createMetrics, type Metrics } from "./metrics"

export function createApp(
  store: ReturnType<typeof createStore>,
  authSecret: string,
  metrics: Metrics = createMetrics(store),
) {
  const app = new Hono()

  app.use("*", async (c, next) => {
    const endTimer = metrics.requestDuration.startTimer()
    await next()
    endTimer({
      route: c.req.routePath || c.req.path,
      method: c.req.method,
      status: String(c.res.status),
    })
  })

  app.use("*", async (c, next) => {
    if (
      c.req.path === "/metrics" &&
      process.env.METRICS_PUBLIC === "true"
    ) {
      return next()
    }
    const auth = c.req.header("Authorization")
    if (auth !== `Bearer ${authSecret}`) {
      return c.json({ error: "unauthorized" }, 401)
    }
    await next()
  })

  app.get("/metrics", async (c) => {
    return c.text(await metrics.registry.metrics(), 200, {
      "Content-Type": metrics.registry.contentType,
    })
  })

  app.get("/health", (c) => c.json({ status: "ok" }))

  app.post("/agents/register", async (c) => {
    const parsed = RegisterPayloadSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    store.registerAgent(parsed.data)
    return c.json({ ok: true })
  })

  app.post("/agents/heartbeat", async (c) => {
    const parsed = HeartbeatPayloadSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    store.heartbeat(parsed.data)
    return c.json({ ok: true })
  })

  app.post("/agents/:id/cooldown", async (c) => {
    const parsed = AgentCooldownPayloadSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const ms =
      parsed.data.retryAfterSeconds > 0
        ? parsed.data.retryAfterSeconds * 1000
        : DEFAULTS.DEFAULT_COOLDOWN_MS
    store.markAgentCooldown(c.req.param("id"), ms)
    metrics.rateLimitsTotal.inc({ scope: "agent" })
    return c.json({ ok: true })
  })

  app.get("/credentials/available", (c) => {
    const agentId = c.req.query("agentId")
    if (!agentId) return c.json({ error: "agentId query param required" }, 400)
    const result = store.acquireCredential(agentId)
    if (!result) return c.json({ error: "no credentials available" }, 404)
    metrics.leasesTotal.inc()
    return c.json(result)
  })

  app.delete("/credentials/lease/:id", (c) => {
    const raw = c.req.query("count")
    const parsed = raw === undefined ? 0 : Number.parseInt(raw, 10)
    const count = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
    store.releaseLease(c.req.param("id"), count)
    return c.json({ ok: true })
  })

  app.post("/credentials/lease/:id/cooldown", async (c) => {
    const parsed = CooldownPayloadSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const ms =
      parsed.data.retryAfterSeconds > 0
        ? parsed.data.retryAfterSeconds * 1000
        : DEFAULTS.DEFAULT_COOLDOWN_MS
    store.markLeaseCooldown(c.req.param("id"), ms, parsed.data.count ?? 0)
    metrics.rateLimitsTotal.inc({ scope: "lease" })
    return c.json({ ok: true })
  })

  app.get("/agents", (c) => {
    return c.json({ agents: store.listAgents() })
  })

  app.delete("/agents/:id", (c) => {
    store.removeAgent(c.req.param("id"))
    return c.json({ ok: true })
  })

  app.get("/audit", (c) => {
    const agentIdQ = c.req.query("agentId")
    const sinceQ = c.req.query("since")
    const limitQ = c.req.query("limit")
    const since = sinceQ ? Number.parseInt(sinceQ, 10) : undefined
    const limit = limitQ ? Number.parseInt(limitQ, 10) : undefined
    const entries = store.listAudit({
      agentId: agentIdQ || undefined,
      since: Number.isFinite(since) ? since : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    })
    return c.json({ entries })
  })

  return app
}
