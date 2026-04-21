import { trace } from "@claude-pool/shared/src/trace"
import { DEFAULTS } from "@claude-pool/shared/src/types"

type ProxyConfig = {
  port: number
  anthropicBaseUrl: string
  serverUrl: string
  serverSecret: string
  maxRetries: number
  onActivity: () => void
}

type CachedCredential = {
  token: string
  leaseId: string
  acquiredAt: number
  requestCount: number
}

export function createProxy(config: ProxyConfig) {
  let cachedCredential: CachedCredential | null = null
  let localAgentCooldownUntil = 0
  const cacheTtlMs = DEFAULTS.LEASE_TTL_MS

  const fetchCredentialFromPool = trace(
    "proxy.fetchCredential",
    async (agentId: string): Promise<CachedCredential | null> => {
      try {
        const res = await fetch(
          `${config.serverUrl}/credentials/available?agentId=${agentId}`,
          { headers: { Authorization: `Bearer ${config.serverSecret}` } }
        )
        if (!res.ok) return null
        const { token, leaseId } = (await res.json()) as {
          token: string
          leaseId: string
        }
        return { token, leaseId, acquiredAt: Date.now(), requestCount: 0 }
      } catch {
        return null
      }
    }
  )

  const releaseLease = async (leaseId: string, count: number) => {
    try {
      await fetch(
        `${config.serverUrl}/credentials/lease/${leaseId}?count=${count}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${config.serverSecret}` },
        }
      )
    } catch {
      /* best-effort */
    }
  }

  const cooldownLease = async (
    leaseId: string,
    retryAfterSeconds: number,
    count: number
  ) => {
    try {
      await fetch(`${config.serverUrl}/credentials/lease/${leaseId}/cooldown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.serverSecret}`,
        },
        body: JSON.stringify({ retryAfterSeconds, count }),
      })
    } catch {
      /* best-effort */
    }
  }

  const cooldownAgent = async (agentId: string, retryAfterSeconds: number) => {
    try {
      await fetch(`${config.serverUrl}/agents/${agentId}/cooldown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.serverSecret}`,
        },
        body: JSON.stringify({ retryAfterSeconds }),
      })
    } catch {
      /* best-effort */
    }
  }

  const parseRetryAfter = (res: Response): number => {
    const raw = res.headers.get("retry-after")
    if (!raw) return 0
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }

  const forwardRequest = async (
    url: string,
    method: string,
    headers: Headers,
    body: ArrayBuffer,
    authToken: string
  ): Promise<Response> => {
    const u = new URL(url)
    const targetUrl = `${config.anthropicBaseUrl}${u.pathname}${u.search}`

    const fwdHeaders = new Headers(headers)
    const isOauthToken = authToken.startsWith("sk-ant-oat")
    fwdHeaders.set("Authorization", `Bearer ${authToken}`)
    if (isOauthToken) {
      fwdHeaders.delete("x-api-key")
    } else {
      fwdHeaders.set("x-api-key", authToken)
    }
    fwdHeaders.delete("host")
    fwdHeaders.delete("accept-encoding")

    const upstream = await fetch(targetUrl, {
      method,
      headers: fwdHeaders,
      body: method !== "GET" && method !== "HEAD" ? body : undefined,
    })

    const resHeaders = new Headers(upstream.headers)
    resHeaders.delete("content-encoding")
    resHeaders.delete("transfer-encoding")

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    })
  }

  const server = Bun.serve({
    port: config.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      console.log(`→ proxy ${req.method} ${new URL(req.url).pathname}`)
      config.onActivity()

      const originalAuth =
        req.headers.get("Authorization")?.replace("Bearer ", "") ||
        req.headers.get("x-api-key") ||
        ""

      const bodyBytes = await req.arrayBuffer()
      const reqUrl = req.url
      const reqMethod = req.method
      const reqHeaders = new Headers(req.headers)
      const agentId = req.headers.get("X-Claude-Pool-Agent-Id") || "default"

      // 1. try own token, unless we already know it's cooled down locally
      if (Date.now() >= localAgentCooldownUntil) {
        const ownResponse = await forwardRequest(
          reqUrl,
          reqMethod,
          reqHeaders,
          bodyBytes,
          originalAuth
        )
        if (ownResponse.status !== 429) {
          // own-token success path: do NOT touch the cached borrowed counter
          return ownResponse
        }

        // own token 429 → bench self locally + on the server, drain body.
        // Cap Retry-After at 24h so an upstream bug or hostile header can't
        // bench us for years; the server-side Zod schema enforces the same cap.
        const rawRetryAfter = parseRetryAfter(ownResponse)
        const ownRetryAfter = Math.min(rawRetryAfter, DEFAULTS.MAX_RETRY_AFTER_SECONDS)
        await ownResponse.arrayBuffer().catch(() => {})
        const cooldownMs =
          ownRetryAfter > 0
            ? ownRetryAfter * 1000
            : DEFAULTS.DEFAULT_COOLDOWN_MS
        localAgentCooldownUntil = Date.now() + cooldownMs
        cooldownAgent(agentId, ownRetryAfter).catch(() => {})
      }

      // 2. failover loop (entered either after a fresh 429 or because we're
      // still in the local cooldown window from an earlier 429)
      for (let attempt = 0; attempt < config.maxRetries; attempt++) {
        if (
          cachedCredential &&
          Date.now() - cachedCredential.acquiredAt > cacheTtlMs
        ) {
          await releaseLease(cachedCredential.leaseId, cachedCredential.requestCount)
          cachedCredential = null
        }

        if (!cachedCredential) {
          cachedCredential = await fetchCredentialFromPool(agentId)
        }

        if (!cachedCredential) {
          return new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "X-Pool-Exhausted": "true",
            },
          })
        }

        const retryResponse = await forwardRequest(
          reqUrl,
          reqMethod,
          reqHeaders,
          bodyBytes,
          cachedCredential.token
        )

        if (retryResponse.status !== 429) {
          cachedCredential.requestCount += 1
          return retryResponse
        }

        // borrowed credential 429 → cooldown it on the server, drop cache
        const borrowedRetryAfter = Math.min(
          parseRetryAfter(retryResponse),
          DEFAULTS.MAX_RETRY_AFTER_SECONDS
        )
        await retryResponse.arrayBuffer().catch(() => {})
        const finalCount = cachedCredential.requestCount
        const exhaustedLeaseId = cachedCredential.leaseId
        cachedCredential = null
        await cooldownLease(exhaustedLeaseId, borrowedRetryAfter, finalCount)
      }

      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "X-Pool-Exhausted": "true",
        },
      })
    },
  })

  const stop = () => {
    if (cachedCredential) {
      releaseLease(cachedCredential.leaseId, cachedCredential.requestCount)
      cachedCredential = null
    }
    server.stop()
  }

  return { server, stop }
}
