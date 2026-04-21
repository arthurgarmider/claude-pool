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
}

export function createProxy(config: ProxyConfig) {
  let cachedCredential: CachedCredential | null = null
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
        return { token, leaseId, acquiredAt: Date.now() }
      } catch {
        return null
      }
    }
  )

  const releaseLease = async (leaseId: string) => {
    try {
      await fetch(`${config.serverUrl}/credentials/lease/${leaseId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.serverSecret}` },
      })
    } catch {
      // best-effort
    }
  }

  const forwardRequest = async (
    url: string,
    method: string,
    headers: Headers,
    body: ArrayBuffer,
    authToken: string
  ): Promise<Response> => {
    const targetUrl = `${config.anthropicBaseUrl}${new URL(url).pathname}${new URL(url).search}`

    const fwdHeaders = new Headers(headers)
    const isOauthToken = authToken.startsWith("sk-ant-oat")
    fwdHeaders.set("Authorization", `Bearer ${authToken}`)
    if (isOauthToken) {
      fwdHeaders.delete("x-api-key")
    } else {
      fwdHeaders.set("x-api-key", authToken)
    }
    fwdHeaders.delete("host")
    // Bun's fetch auto-decompresses responses; strip Accept-Encoding so
    // Anthropic sends plain bytes that Claude Code can read directly
    fwdHeaders.delete("accept-encoding")

    const upstream = await fetch(targetUrl, {
      method,
      headers: fwdHeaders,
      body: method !== "GET" && method !== "HEAD" ? body : undefined,
    })

    // Bun auto-decompresses the body but may still forward Content-Encoding,
    // which would cause the client to try decompressing already-decoded bytes
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

      // try with original credentials
      const response = await forwardRequest(
        reqUrl,
        reqMethod,
        reqHeaders,
        bodyBytes,
        originalAuth
      )
      if (response.status !== 429) {
        return response
      }

      // 429 — attempt failover
      const agentId =
        req.headers.get("X-Claude-Pool-Agent-Id") || "default"

      for (let attempt = 0; attempt < config.maxRetries; attempt++) {
        // check cache validity
        if (
          cachedCredential &&
          Date.now() - cachedCredential.acquiredAt > cacheTtlMs
        ) {
          await releaseLease(cachedCredential.leaseId)
          cachedCredential = null
        }

        // get credential from cache or pool
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
          return retryResponse
        }

        // this credential is also exhausted — release and try another
        await releaseLease(cachedCredential.leaseId)
        cachedCredential = null
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
      releaseLease(cachedCredential.leaseId)
      cachedCredential = null
    }
    server.stop()
  }

  return { server, stop }
}
