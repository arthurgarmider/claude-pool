import { describe, it, expect } from "bun:test"
import { randomBytes } from "node:crypto"
import { createCrypto } from "./crypto"

const KEY_B64 = randomBytes(32).toString("base64")

describe("crypto", () => {
  it("round-trips plaintext", () => {
    const crypto = createCrypto(KEY_B64)
    const { ciphertext, nonce } = crypto.encryptToken("hello-world")
    expect(crypto.decryptToken(ciphertext, nonce)).toBe("hello-world")
  })

  it("produces different ciphertexts for the same plaintext (unique nonces)", () => {
    const crypto = createCrypto(KEY_B64)
    const a = crypto.encryptToken("secret")
    const b = crypto.encryptToken("secret")
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0)
    expect(Buffer.compare(a.nonce, b.nonce)).not.toBe(0)
  })

  it("decrypt with a different key throws", () => {
    const c1 = createCrypto(KEY_B64)
    const c2 = createCrypto(randomBytes(32).toString("base64"))
    const { ciphertext, nonce } = c1.encryptToken("secret")
    expect(() => c2.decryptToken(ciphertext, nonce)).toThrow()
  })

  it("decrypt with tampered ciphertext throws", () => {
    const crypto = createCrypto(KEY_B64)
    const { ciphertext, nonce } = crypto.encryptToken("secret")
    const tampered = Buffer.from(ciphertext)
    tampered[0] ^= 0xff
    expect(() => crypto.decryptToken(tampered, nonce)).toThrow()
  })

  it("decrypt with wrong nonce throws", () => {
    const crypto = createCrypto(KEY_B64)
    const { ciphertext } = crypto.encryptToken("secret")
    const wrongNonce = randomBytes(12)
    expect(() => crypto.decryptToken(ciphertext, wrongNonce)).toThrow()
  })

  it("rejects keys that are not 32 bytes after base64 decode", () => {
    const tooShort = Buffer.alloc(16).toString("base64")
    expect(() => createCrypto(tooShort)).toThrow(/32 bytes/)
    const tooLong = Buffer.alloc(64).toString("base64")
    expect(() => createCrypto(tooLong)).toThrow(/32 bytes/)
  })
})
