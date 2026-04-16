import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { DEFAULTS } from "@claude-pool/shared/src/types"

const ConfigFileSchema = z.object({
  server: z.object({
    url: z.string().url(),
    secret: z.string().min(1),
  }),
  proxy: z.object({
    port: z.number().int().positive(),
  }).default({ port: DEFAULTS.PROXY_PORT }),
  idle: z.object({
    threshold_minutes: z.number().positive(),
  }).default({ threshold_minutes: 15 }),
  credentials: z.object({
    cache_ttl_minutes: z.number().positive(),
  }).default({ cache_ttl_minutes: 30 }),
  failover: z.object({
    max_retries: z.number().int().positive(),
  }).default({ max_retries: DEFAULTS.MAX_FAILOVER_RETRIES }),
})

export type AgentConfig = {
  server: { url: string; secret: string }
  proxy: { port: number }
  idle: { thresholdMs: number }
  credentials: { cacheTtlMs: number }
  failover: { maxRetries: number }
}

export function parseConfig(yamlContent: string): AgentConfig {
  const raw = ConfigFileSchema.parse(parseYaml(yamlContent))
  return {
    server: raw.server,
    proxy: { port: raw.proxy.port },
    idle: { thresholdMs: raw.idle.threshold_minutes * 60 * 1000 },
    credentials: { cacheTtlMs: raw.credentials.cache_ttl_minutes * 60 * 1000 },
    failover: { maxRetries: raw.failover.max_retries },
  }
}

export async function loadConfigAsync(path?: string): Promise<AgentConfig> {
  const configPath = path || `${process.env.HOME}/.claude-pool/config.yaml`
  const content = await Bun.file(configPath).text()
  return parseConfig(content)
}
