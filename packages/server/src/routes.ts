import { Hono } from "hono"
import { RegisterPayloadSchema, HeartbeatPayloadSchema } from "@claude-pool/shared/src/types"
import type { createStore } from "./store"

export function createApp(store: ReturnType<typeof createStore>, authSecret: string) {
  const app = new Hono()

  app.use("*", async (c, next) => {
    const auth = c.req.header("Authorization")
    if (auth !== `Bearer ${authSecret}`) {
      return c.json({ error: "unauthorized" }, 401)
    }
    await next()
  })

  app.get("/health", (c) => c.json({ status: "ok" }))

  app.post("/agents/register", async (c) => {
    const parsed = RegisterPayloadSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400)
    }
    store.registerAgent(parsed.data)
    return c.json({ ok: true })
  })

  app.post("/agents/heartbeat", async (c) => {
    const parsed = HeartbeatPayloadSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400)
    }
    store.heartbeat(parsed.data)
    return c.json({ ok: true })
  })

  app.get("/credentials/available", (c) => {
    const agentId = c.req.query("agentId")
    if (!agentId) {
      return c.json({ error: "agentId query param required" }, 400)
    }
    const result = store.acquireCredential(agentId)
    if (!result) {
      return c.json({ error: "no credentials available" }, 404)
    }
    return c.json(result)
  })

  app.delete("/credentials/lease/:id", (c) => {
    store.releaseLease(c.req.param("id"))
    return c.json({ ok: true })
  })

  app.get("/agents", (c) => {
    const agents = store.listAgents().map(({ token, ...rest }) => rest)
    return c.json({ agents })
  })

  app.delete("/agents/:id", (c) => {
    store.removeAgent(c.req.param("id"))
    return c.json({ ok: true })
  })

  return app
}
