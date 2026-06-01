// What a daemon backend needs to install/run the agent. Computed once by the
// dispatcher (index.ts) and handed to the platform-specific backend.
export type DaemonContext = {
  /** Absolute path to the bun executable. */
  bunPath: string
  /** Absolute path to the agent entry point (src/index.ts). */
  entryPoint: string
  /** Directory for agent.log / agent.err. */
  logDir: string
}

export interface DaemonBackend {
  install(ctx: DaemonContext): Promise<void>
  uninstall(ctx: DaemonContext): Promise<void>
  start(ctx: DaemonContext): Promise<void>
  stop(ctx: DaemonContext): Promise<void>
}
