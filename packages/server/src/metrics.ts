import { Registry, Counter, Gauge, Histogram } from "prom-client"
import type { createStore } from "./store"

export type Metrics = ReturnType<typeof createMetrics>

export function createMetrics(store?: ReturnType<typeof createStore>) {
  const registry = new Registry()

  const agentsTotal = new Gauge({
    name: "claudepool_agents_total",
    help: "Registered agents bucketed by state (cooling supersedes the base status).",
    labelNames: ["state"] as const,
    registers: [registry],
    collect() {
      if (!store) return
      const now = Date.now()
      const counts = { active: 0, idle: 0, offline: 0, cooling: 0 }
      for (const a of store.listAgents()) {
        if (a.cooldownUntil && a.cooldownUntil > now) {
          counts.cooling += 1
        } else {
          counts[a.status] += 1
        }
      }
      this.set({ state: "active" }, counts.active)
      this.set({ state: "idle" }, counts.idle)
      this.set({ state: "offline" }, counts.offline)
      this.set({ state: "cooling" }, counts.cooling)
    },
  })

  const leasesOpen = new Gauge({
    name: "claudepool_leases_open",
    help: "Leases that are currently held (releasedAt IS NULL).",
    registers: [registry],
    collect() {
      if (!store) return
      this.set(store.countOpenLeases())
    },
  })

  const leasesTotal = new Counter({
    name: "claudepool_leases_total",
    help: "Cumulative count of leases successfully acquired.",
    registers: [registry],
  })

  const rateLimitsTotal = new Counter({
    name: "claudepool_429s_total",
    help: "Cumulative count of upstream 429 events that triggered a cooldown.",
    labelNames: ["scope"] as const,
    registers: [registry],
  })

  const requestDuration = new Histogram({
    name: "claudepool_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["route", "method", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  })

  return {
    registry,
    agentsTotal,
    leasesOpen,
    leasesTotal,
    rateLimitsTotal,
    requestDuration,
  }
}
