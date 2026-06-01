import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { LinuxCredentialStore } from "./linux"
import { EncryptedFileStore } from "./encrypted-file"
import { parseOauthJson } from "./oauth"

describe("parseOauthJson", () => {
  it("extracts accessToken from the claudeAiOauth blob", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-abc" } })
    expect(parseOauthJson(raw)).toBe("sk-ant-oat-abc")
  })

  it("handles a stringified inner oauth object", () => {
    const raw = JSON.stringify({
      claudeAiOauth: JSON.stringify({ accessToken: "sk-ant-oat-xyz" }),
    })
    expect(parseOauthJson(raw)).toBe("sk-ant-oat-xyz")
  })

  it("returns null on malformed json", () => {
    expect(parseOauthJson("{not json")).toBeNull()
    expect(parseOauthJson("{}")).toBeNull()
  })
})

describe("LinuxCredentialStore.readClaudeCodeOauth", () => {
  let dir: string
  let credPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cp-linux-"))
    credPath = join(dir, ".credentials.json")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads the token from Claude Code's credentials file", async () => {
    await writeFile(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-file" } })
    )
    const store = new LinuxCredentialStore({ claudeCredentialsPath: credPath })
    expect(await store.readClaudeCodeOauth()).toBe("sk-ant-oat-file")
  })

  it("returns null when the credentials file is missing", async () => {
    const store = new LinuxCredentialStore({
      claudeCredentialsPath: join(dir, "does-not-exist.json"),
    })
    expect(await store.readClaudeCodeOauth()).toBeNull()
  })

  it("returns null when the file is malformed", async () => {
    await writeFile(credPath, "garbage")
    const store = new LinuxCredentialStore({ claudeCredentialsPath: credPath })
    expect(await store.readClaudeCodeOauth()).toBeNull()
  })
})

describe("EncryptedFileStore", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cp-enc-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("round-trips a secret through encryption", async () => {
    const store = new EncryptedFileStore(dir)
    await store.write("my-service", "super-secret-value")
    expect(await store.read("my-service")).toBe("super-secret-value")
  })

  it("returns null for unknown services and before any write", async () => {
    const store = new EncryptedFileStore(dir)
    expect(await store.read("nope")).toBeNull()
  })

  it("does not store the plaintext on disk", async () => {
    const store = new EncryptedFileStore(dir)
    await store.write("svc", "plaintext-needle")
    const onDisk = await Bun.file(join(dir, "secrets.json")).text()
    expect(onDisk).not.toContain("plaintext-needle")
  })
})
