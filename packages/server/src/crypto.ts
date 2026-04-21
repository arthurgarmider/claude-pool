import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto"
import { traceQuiet } from "@claude-pool/shared/src/trace"

export type Crypto = ReturnType<typeof createCrypto>

export function createCrypto(keyB64: string) {
  const key = Buffer.from(keyB64, "base64")
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes after base64 decode")
  }

  const encryptToken = traceQuiet("crypto.encrypt", (plaintext: string) => {
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, nonce)
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    return { ciphertext: Buffer.concat([ciphertext, tag]), nonce }
  })

  const decryptToken = traceQuiet(
    "crypto.decrypt",
    (ciphertext: Buffer, nonce: Buffer) => {
      const tag = ciphertext.subarray(ciphertext.length - 16)
      const ct = ciphertext.subarray(0, ciphertext.length - 16)
      const decipher = createDecipheriv("aes-256-gcm", key, nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
        "utf8"
      )
    }
  )

  return { encryptToken, decryptToken }
}
