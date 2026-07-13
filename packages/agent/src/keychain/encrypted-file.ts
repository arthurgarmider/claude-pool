import { join } from "path"
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto"

// A tiny AES-256-GCM secret store for headless Linux machines that have no
// libsecret/Keyring. Secrets live in `secrets.json` under the config dir,
// encrypted with a per-host key file (`secrets.key`, mode 0600). This is not a
// substitute for a real keyring, just a local-disk fallback that avoids storing
// secrets in plaintext.

const xdgConfigHome = (): string =>
  process.env.XDG_CONFIG_HOME || join(process.env.HOME!, ".config")

export const defaultStoreDir = (): string =>
  join(xdgConfigHome(), "claude-pool")

type Entry = { iv: string; tag: string; data: string }

export class EncryptedFileStore {
  private readonly keyPath: string
  private readonly storePath: string

  constructor(dir: string = defaultStoreDir()) {
    this.keyPath = join(dir, "secrets.key")
    this.storePath = join(dir, "secrets.json")
  }

  private async getKey(create: boolean): Promise<Buffer | null> {
    const file = Bun.file(this.keyPath)
    if (await file.exists()) {
      return Buffer.from(await file.text(), "hex")
    }
    if (!create) return null
    const key = randomBytes(32)
    await Bun.write(this.keyPath, key.toString("hex"))
    // Best-effort lockdown; ignore on platforms/filesystems that refuse.
    await Bun.spawn(["chmod", "600", this.keyPath]).exited.catch(() => {})
    return key
  }

  private async readAll(): Promise<Record<string, Entry>> {
    const file = Bun.file(this.storePath)
    if (!(await file.exists())) return {}
    try {
      return (await file.json()) as Record<string, Entry>
    } catch {
      return {}
    }
  }

  async read(service: string): Promise<string | null> {
    const key = await this.getKey(false)
    if (!key) return null
    const entry = (await this.readAll())[service]
    if (!entry) return null
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(entry.iv, "hex")
      )
      decipher.setAuthTag(Buffer.from(entry.tag, "hex"))
      const out = Buffer.concat([
        decipher.update(Buffer.from(entry.data, "hex")),
        decipher.final(),
      ])
      return out.toString("utf8")
    } catch {
      return null
    }
  }

  async write(service: string, value: string): Promise<void> {
    const key = (await this.getKey(true))!
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    const all = await this.readAll()
    all[service] = {
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: data.toString("hex"),
    }
    await Bun.write(this.storePath, JSON.stringify(all))
  }
}
