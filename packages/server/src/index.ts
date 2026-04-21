import { createStore } from "./store"
import { createApp } from "./routes"
import { createCrypto } from "./crypto"
import { DEFAULTS } from "@claude-pool/shared/src/types"

const port = parseInt(process.env.PORT || String(DEFAULTS.SERVER_PORT))
const authSecret = process.env.AUTH_SECRET
const encryptionKey = process.env.ENCRYPTION_KEY

if (!authSecret) {
  console.error("AUTH_SECRET environment variable is required")
  process.exit(1)
}
if (!encryptionKey) {
  console.error(
    "ENCRYPTION_KEY environment variable is required (32 raw bytes, base64). " +
      "Generate with: openssl rand -base64 32"
  )
  process.exit(1)
}

const crypto = createCrypto(encryptionKey)

const dbPath = process.env.DB_PATH || "./claude-pool.db"
const store = createStore(dbPath, crypto)
const app = createApp(store, authSecret)

setInterval(() => {
  store.expireOfflineAgents(DEFAULTS.OFFLINE_THRESHOLD_MS)
  store.expireLeases(DEFAULTS.LEASE_TTL_MS)
}, 60_000)

export default {
  port,
  fetch: app.fetch,
}

console.log(`claude-pool server listening on :${port}`)
