# Observability

claude-pool exposes a Prometheus-compatible metrics endpoint at `GET /metrics`
so operators can watch pool health (active agents, lease rate, 429 events,
cooldown count, request latency) without scraping `/audit` and rolling their
own aggregation.

## Endpoint

```
GET /metrics
```

By default the endpoint requires the same `Authorization: Bearer $AUTH_SECRET`
header as every other API route. Set `METRICS_PUBLIC=true` in the server
environment to allow unauthenticated scraping (useful when Prometheus runs
inside the same private network as the server).

Response is the standard Prometheus text exposition format
(`Content-Type: text/plain; version=0.0.4; charset=utf-8`).

## Exposed metrics

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `claudepool_agents_total` | gauge | `state="active\|idle\|offline\|cooling"` | Registered agents bucketed by state. `cooling` (agents whose `cooldownUntil` is in the future) supersedes the base status. |
| `claudepool_leases_open` | gauge | — | Leases currently held (not yet released, expired, or cooled down). |
| `claudepool_leases_total` | counter | — | Cumulative count of leases successfully acquired since process start. |
| `claudepool_429s_total` | counter | `scope="agent\|lease"` | Cumulative count of upstream 429 events that triggered a cooldown. `lease` = `/credentials/lease/:id/cooldown`, `agent` = `/agents/:id/cooldown`. |
| `claudepool_request_duration_seconds` | histogram | `route`, `method`, `status` | HTTP request duration in seconds. Buckets: 5ms → 10s. |

Counters reset on process restart — this is the standard Prometheus contract.
Use `rate()` / `increase()` over a window in PromQL rather than reading raw
counter values.

## Prometheus scrape config

### Authenticated (recommended for any non-private deployment)

```yaml
scrape_configs:
  - job_name: claude-pool
    metrics_path: /metrics
    scheme: http
    static_configs:
      - targets: ["claude-pool.internal:8787"]
    authorization:
      type: Bearer
      credentials: ${CLAUDE_POOL_AUTH_SECRET}
```

### Public (server started with `METRICS_PUBLIC=true`)

```yaml
scrape_configs:
  - job_name: claude-pool
    metrics_path: /metrics
    static_configs:
      - targets: ["claude-pool.internal:8787"]
```

A default 30s scrape interval is plenty — pool state changes on the order of
seconds, not milliseconds.

## Useful PromQL

```promql
# Lease acquisition rate (per second, 5m window)
rate(claudepool_leases_total[5m])

# 429 rate by scope
sum by (scope) (rate(claudepool_429s_total[5m]))

# Currently cooling agents
claudepool_agents_total{state="cooling"}

# p95 request latency by route
histogram_quantile(
  0.95,
  sum by (le, route) (rate(claudepool_request_duration_seconds_bucket[5m]))
)
```

## Grafana dashboard

A starter dashboard is included at
[`docs/grafana/claude-pool-dashboard.json`](grafana/claude-pool-dashboard.json).
Import it into Grafana (`Dashboards → Import → Upload JSON`) and select your
Prometheus datasource. It ships five panels:

- Agents by state (stacked).
- Open leases (gauge).
- Lease acquisition rate.
- 429 rate by scope.
- Request p95 latency by route.

## Alerting starter rules

```yaml
groups:
  - name: claude-pool
    rules:
      - alert: ClaudePoolNoIdleAgents
        expr: claudepool_agents_total{state="idle"} == 0
        for: 5m
        annotations:
          summary: "claude-pool has no idle agents to lend"

      - alert: ClaudePool429Spike
        expr: sum(rate(claudepool_429s_total[5m])) > 0.1
        for: 10m
        annotations:
          summary: "claude-pool is seeing sustained 429s ({{ $value }}/s)"
```
