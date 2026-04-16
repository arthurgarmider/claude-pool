import { createStore } from "./store"
import { createApp } from "./routes"
import { DEFAULTS } from "@claude-pool/shared/src/types"

const port = parseInt(process.env.PORT || String(DEFAULTS.SERVER_PORT))
const authSecret = process.env.AUTH_SECRET

if (!authSecret) {
  console.error("AUTH_SECRET environment variable is required")
  process.exit(1)
}

const dbPath = process.env.DB_PATH || "./claude-pool.db"
const store = createStore(dbPath)
const app = createApp(store, authSecret)

// periodic cleanup: expire offline agents and stale leases every 60s
setInterval(() => {
  store.expireOfflineAgents(DEFAULTS.OFFLINE_THRESHOLD_MS)
  store.expireLeases(DEFAULTS.LEASE_TTL_MS)
}, 60_000)

export default {
  port,
  fetch: app.fetch,
}

console.log(`claude-pool server listening on :${port}`)
