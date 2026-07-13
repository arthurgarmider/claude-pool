# Plan: Linux support for the claude-pool agent

## Context

The agent (`packages/agent/`, published as `@claudepool/agent`) currently only works on
macOS. Two pieces of it are hard-wired to macOS:

- **Credential retrieval** (`src/credentials.ts`) — shells out to the macOS `security` CLI to
  read the **Claude Code OAuth token out of the macOS Keychain**. Note: the agent does *not*
  store its own secret here; it *borrows* Claude Code's token. On Linux, Claude Code stores that
  same token in a plain file at `~/.claude/.credentials.json` (same `claudeAiOauth.accessToken`
  JSON shape we already parse), so the Linux "backend" is mostly a different *read source*, not a
  new secret store.
- **Daemon management** (`src/daemon.ts`) — generates a launchd `.plist` and drives `launchctl`.

Everything else (config at `~/.claude-pool/`, Claude Code settings at `~/.claude/settings.json`,
the proxy, heartbeat, the `bun build` pipeline) is already platform-agnostic and Bun runs natively
on Linux. The goal: `bun install -g @claudepool/agent` then `claude-pool init && claude-pool start`
behaves the same on Ubuntu 22.04+ / Debian 12 / Arch as on macOS, with tests green on
`ubuntu-latest`.

### Decisions (confirmed with user)
- **Linux credential backend:** read `~/.claude/.credentials.json` first; also try `secret-tool`
  (libsecret) if available; encrypted-file fallback under `$XDG_CONFIG_HOME/claude-pool/` for
  agent-held keys. No mandatory native dependency.
- **Daemon:** systemd `--user` unit, with a `nohup` background-process + pidfile fallback when no
  systemd user session is present.
- **Packaging:** npm only this round (verify Linux install + docs). No `.deb` / Homebrew yet.

## Approach

### 1. Extract a `keychain/` credential abstraction (matches the issue's pointer)

Create `packages/agent/src/keychain/` and move the platform-specific token reading out of
`credentials.ts`:

- `keychain/types.ts` — the contract:
  ```ts
  export interface CredentialStore {
    /** Raw secret for a named service entry, or null if absent. */
    read(service: string): Promise<string | null>
    /** The Claude Code OAuth access token, or null. */
    readClaudeCodeOauth(): Promise<string | null>
  }
  ```
- `keychain/macos.ts` — move the existing `readKeychain` (`security find-generic-password`) and the
  `Claude Code-credentials` → `Claude Code` fallback logic (`credentials.ts:3-37`) here, implementing
  `CredentialStore`.
- `keychain/linux.ts` — implement `CredentialStore`:
  - `readClaudeCodeOauth()`: in order — (a) `secret-tool lookup` for the Claude Code entry **if
    `secret-tool` is on PATH** (`Bun.which("secret-tool")`); (b) read & JSON-parse
    `~/.claude/.credentials.json` and pull `claudeAiOauth.accessToken`. Reuse the existing
    `parseOauthJson` helper (move it to a shared `keychain/oauth.ts` so both backends use it).
  - `read(service)`: try `secret-tool` if present, else the encrypted-file store under
    `$XDG_CONFIG_HOME/claude-pool/` (default `~/.config/claude-pool/`).
- `keychain/index.ts` — `getCredentialStore(): CredentialStore` dispatching on `process.platform`
  (`"darwin"` → macOS, else Linux). Re-export `parseOauthJson`.

Then slim `credentials.ts` to call the abstraction:
- `readOauthFromKeychain()` → `getCredentialStore().readClaudeCodeOauth()`.
- `extractTokenFromKeychain(service?)` → `getCredentialStore().read(service)` / `readClaudeCodeOauth()`.
- Keep `collectCredentials`, `extractToken`, `AgentCredentials`, `CollectOpts`, and all current
  priority/validation logic **unchanged** in signature — only the source of the OAuth token changes.
  Update the macOS-specific error string in `extractTokenFromKeychain` (`credentials.ts:54`) to be
  platform-neutral ("Could not read the Claude Code OAuth token.").

The encrypted-file fallback (`read`/write for agent-held keys) is a small AES helper using Bun's
`crypto` with a key derived from a per-host file under `$XDG_CONFIG_HOME/claude-pool/`. Keep it
minimal — it only backs explicit/env keys the user opts to persist; the common path is the
Claude Code file read, which needs no encryption.

### 2. Platform-dispatch the daemon (`src/daemon.ts`)

Refactor `daemon.ts` into `daemon/` keeping the **same four exports** (`installDaemon`,
`uninstallDaemon`, `startDaemon`, `stopDaemon`) so `cli.ts:5` is untouched:

- `daemon/launchd.ts` — the current plist + `launchctl` implementation, verbatim.
- `daemon/systemd.ts` — write a user unit to `~/.config/systemd/user/claude-pool.service`
  (`ExecStart=<bunPath> run <entryPoint>`, `Restart=always`, `StandardOutput=append:~/.claude-pool/logs/agent.log`),
  then `systemctl --user daemon-reload` / `enable --now` / `disable` / `start` / `stop`. Detect
  availability via `Bun.which("systemctl")` + a successful `systemctl --user is-system-running`-style
  probe.
- `daemon/process.ts` — fallback: spawn the daemon detached (`nohup`, `stdio` to the existing
  `~/.claude-pool/logs/agent.log`/`.err`), write a pidfile under `~/.claude-pool/agent.pid`;
  stop = read pid + `kill`.
- `daemon/index.ts` — pick launchd on `darwin`, else systemd-if-available, else process fallback;
  re-export the four functions. Reuse the existing `bunPath`/`entryPoint`/log-dir setup from
  `daemon.ts:36-41`.

Replace the macOS `mkdir`/`rm`/`tail` shell-outs where convenient with Bun/`node:fs` equivalents so
behavior is identical cross-platform (`logs()` in `cli.ts:172` uses `tail -f`, which exists on Linux
— leave it).

### 3. Tests

- `keychain/linux.test.ts` (new): write a temp `.credentials.json` with the `claudeAiOauth` shape,
  point the Linux backend at it (inject the path), assert the token is extracted; assert `null` when
  the file is missing/malformed. These run on `ubuntu-latest` without real secrets.
- Keep `credentials.test.ts` as-is; its keychain-hitting cases already `return` early under
  `process.env.CI`. Add one collect-path case that works on Linux via the temp file.
- `daemon` tests: keep light — assert the correct backend is selected per `process.platform`
  (dependency-inject or mock `Bun.which`) and that the systemd unit text is generated correctly;
  avoid actually invoking `systemctl` in CI.

### 4. CI matrix

Update `.github/workflows/test.yml` to a matrix `runs-on: [ubuntu-latest, macos-latest]` so both
platforms are exercised (the issue requires ubuntu green; macOS guards regressions in the existing
backend). Single `bun test` step unchanged.

### 5. Docs + metadata

- `packages/agent/package.json`: add `"os": ["darwin", "linux"]`. Build script already produces
  portable `dist/cli.js`; no change needed.
- `packages/agent/README.md` + root `README.md` (`Requirements`, line ~149; "install on their Mac",
  line ~58): document Linux install (`bun install -g @claudepool/agent` on Ubuntu 22.04+/Debian 12/
  Arch) and that `claude-pool start` uses a systemd user service.

## Critical files
- `packages/agent/src/credentials.ts` → slim to call new abstraction (keep public API).
- `packages/agent/src/keychain/{types,oauth,index,macos,linux}.ts` → **new** abstraction.
- `packages/agent/src/daemon.ts` → split into `packages/agent/src/daemon/{index,launchd,systemd,process}.ts` (keep four exports).
- `packages/agent/src/keychain/linux.test.ts` → **new**.
- `.github/workflows/test.yml` → add OS matrix.
- `packages/agent/package.json` (`os` field), `packages/agent/README.md`, root `README.md`.

## Reuse
- `parseOauthJson` (`credentials.ts:14`) — move to `keychain/oauth.ts`, share across backends.
- `trace()` from `@claude-pool/shared/src/trace` — wrap new backend methods as the existing code does.
- Daemon `bunPath`/`entryPoint`/log-dir bootstrap (`daemon.ts:36-41`) — reuse in `daemon/index.ts`.

## Verification
1. `bun install && bun test` locally (macOS) — existing + new tests pass, macOS backend unchanged.
2. On an Ubuntu 22.04 box / container with Bun + Claude Code logged in:
   - `bun install -g @claudepool/agent` (or `bun link` from the repo).
   - `claude-pool init` → reads OAuth from `~/.claude/.credentials.json`, writes `~/.claude-pool/config.yaml`,
     registers, patches `~/.claude/settings.json`.
   - `claude-pool start` → installs+starts the systemd user unit (`systemctl --user status claude-pool`);
     `claude-pool logs` tails `~/.claude-pool/logs/agent.log`; `claude-pool stop` / `uninstall` clean up.
   - In a container without systemd user session, confirm the `nohup`+pidfile fallback starts/stops.
3. Push branch → confirm the `test` workflow is green on both `ubuntu-latest` and `macos-latest`.
