/**
 * src/main/simhostSupervisor.ts
 *
 * SimHost supervision: fork → port handshake → crash detection → respawn
 * with backoff → fatal state after 5 crashes < 30 s apart (Spec §6, §12).
 *
 * Design notes:
 *  - All Electron-specific types (utilityProcess, MessageChannelMain, etc.)
 *    are abstracted behind narrow interfaces (ChildHandle, PortPair, …) so
 *    the unit tests in __tests__/supervisor.test.ts can run in plain Node
 *    without an Electron runtime.
 *  - Production callers import `createProductionSupervisor` which wires up
 *    the real Electron APIs.
 *  - "Main is NOT in the steady-state message path" (Spec §6): after the
 *    one-time port handshake, messages flow directly renderer↔SimHost.
 *
 * Backoff schedule: [250 ms, 1 s, 5 s]. After the 3rd crash the delay stays
 * at 5 s for all subsequent crashes until the fatal threshold.
 *
 * Fatal threshold: 5 consecutive crashes that each occurred < 30 s after the
 * previous one (i.e. the window of rapid crashes is measured pairwise).
 */

// ─── Injectable abstractions (for unit testing without Electron) ──────────────

/** Minimal interface for a forked child process. */
export interface ChildHandle {
  postMessage(message: unknown, ports?: unknown[]): void
  kill(): boolean | void
  on(event: 'exit', listener: (code: number) => void): void
  off(event: 'exit', listener: (code: number) => void): void
}

/** Minimal interface for one end of a MessagePort. */
export interface PortHandle {
  start(): void
  close(): void
  postMessage(message: unknown, ports?: unknown[]): void
  on(event: string, listener: (...args: unknown[]) => void): void
  off(event: string, listener: (...args: unknown[]) => void): void
  /**
   * The underlying transferable port object (the real Electron MessagePortMain
   * in production). Electron's postMessage transfer list requires the RAW port,
   * not this wrapper — `unwrapPort` reaches through to it. Undefined for the
   * stub ports used in unit tests (which are passed through as-is).
   */
  readonly __raw?: unknown
}

/** Reach through a PortHandle to the raw transferable port for postMessage. */
export function unwrapPort(p: unknown): unknown {
  return (p as PortHandle | undefined)?.__raw ?? p
}

/** The two ports of a MessageChannel. */
export interface PortPair {
  port1: PortHandle
  port2: PortHandle
}

/** Minimal interface for the renderer webContents (enough for postMessage). */
export interface WebContentsHandle {
  isDestroyed(): boolean
  postMessage(channel: string, message: unknown, transfer?: PortHandle[]): void
}

/** Factory that forks the SimHost child process. Returns a ChildHandle. */
export type ForkFn = (modulePath: string) => ChildHandle

/** Factory that creates a fresh MessageChannel per spawn. */
export type PortPairFactory = () => PortPair

/** Callback fired when SimHost crashes (contextBridge path, Spec §6.1). */
export type CrashedCallback = (payload: { willRespawn: boolean }) => void

// ─── Backoff schedule ─────────────────────────────────────────────────────────

const BACKOFF_DELAYS_MS = [250, 1_000, 5_000] as const
const FATAL_CRASH_COUNT = 5
const FATAL_WINDOW_MS = 30_000

// ─── Supervisor ───────────────────────────────────────────────────────────────

export interface SimhostSupervisorOptions {
  /** Injectable fork function (defaults to production Electron fork). */
  fork: ForkFn
  /** Injectable MessageChannel factory. */
  portPairFactory: PortPairFactory
  /** Path to the simhost module. Defaults to the electron-vite output path. */
  simhostPath?: string
  /** Called when SimHost exits (crash notification to renderer). */
  onSimhostCrashed?: CrashedCallback
}

export class SimhostSupervisor {
  private readonly fork: ForkFn
  private readonly portPairFactory: PortPairFactory
  private readonly simhostPath: string
  private readonly onSimhostCrashedCb: CrashedCallback | undefined

  private child: ChildHandle | null = null
  private currentPair: PortPair | null = null
  private webContents: WebContentsHandle | null = null

  /** Wall-clock timestamps of recent crash exits (ms). */
  private crashTimestamps: number[] = []
  /** Number of crashes so far (for backoff schedule). */
  private crashCount = 0

  private fatal = false
  private disposed = false

  private respawnTimer: ReturnType<typeof setTimeout> | null = null

  /** true once the renderer has called onRendererReady() for the current spawn. */
  private rendererReady = false

  /** Bound exit listener so we can detach it from the dead child. */
  private boundExitListener: ((code: number) => void) | null = null

  constructor(opts: SimhostSupervisorOptions) {
    this.fork = opts.fork
    this.portPairFactory = opts.portPairFactory
    this.simhostPath = opts.simhostPath ?? 'out/simhost/index.js'
    this.onSimhostCrashedCb = opts.onSimhostCrashed
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fork the first SimHost process. Call once from main process after
   * `app.whenReady()`.
   */
  start(): void {
    if (this.disposed) return
    this.spawnChild()
  }

  /**
   * Provide the renderer's webContents so the supervisor can deliver port2.
   * Call once (or again on window recreation) before `onRendererReady()`.
   */
  setWebContents(wc: WebContentsHandle): void {
    this.webContents = wc
  }

  /**
   * Called when the renderer has loaded and is ready to receive the MessagePort.
   * This triggers the renderer-side of the one-time port handshake.
   *
   * In production: call from `BrowserWindow.webContents.on('did-finish-load', …)`.
   * In tests: call directly after setting up stubs.
   */
  onRendererReady(): void {
    this.rendererReady = true
    this.doRendererHandshake()
  }

  /** true once the fatal threshold has been reached (no more respawns). */
  isFatal(): boolean {
    return this.fatal
  }

  /** Shut down the supervisor and kill the child. Does not respawn. */
  dispose(): void {
    this.disposed = true
    if (this.respawnTimer !== null) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = null
    }
    this.killChild()
  }

  // ── Spawn + handshake ──────────────────────────────────────────────────────

  private spawnChild(): void {
    if (this.disposed || this.fatal) return

    // Create a fresh MessageChannel for this spawn (one-time handshake).
    this.currentPair = this.portPairFactory()
    this.rendererReady = false

    const child = this.fork(this.simhostPath)
    this.child = child

    // Send port1 to the SimHost child immediately.
    child.postMessage({ type: 'port' }, [this.currentPair.port1])

    // Listen for exits (crashes) on this child.
    const listener = (code: number) => this.onChildExit(code)
    this.boundExitListener = listener
    child.on('exit', listener)

    // If the renderer was already ready from a previous spawn, deliver port2
    // for this new spawn now. (Handles the case where the renderer outlives a
    // SimHost crash and is already loaded when we respawn.)
    if (this.rendererReady) {
      this.doRendererHandshake()
    }
  }

  /**
   * Deliver port2 to the renderer. Called from onRendererReady() (initial load)
   * and from spawnChild() when the renderer is already up after a crash.
   */
  private doRendererHandshake(): void {
    if (!this.rendererReady) return
    if (!this.currentPair) return
    const wc = this.webContents
    if (!wc || wc.isDestroyed()) return

    wc.postMessage('simhost-port', { type: 'port' }, [this.currentPair.port2])
  }

  // ── Crash handling + backoff ───────────────────────────────────────────────

  private onChildExit(_code: number): void {
    if (this.disposed) return

    // Detach the exit listener from the now-dead child.
    if (this.child && this.boundExitListener) {
      this.child.off('exit', this.boundExitListener)
    }
    this.child = null
    this.boundExitListener = null

    const now = Date.now()

    // Record this crash timestamp and prune any that are older than the fatal
    // window (we only count crashes that are "rapid" — < 30 s apart pairwise).
    this.crashTimestamps.push(now)
    // Keep only crashes within the fatal window of the earliest remaining crash.
    while (
      this.crashTimestamps.length > 1 &&
      now - this.crashTimestamps[0]! >= FATAL_WINDOW_MS
    ) {
      this.crashTimestamps.shift()
    }

    this.crashCount++

    // Determine whether we've hit the fatal threshold.
    const willRespawn = !this.isFatalThreshold()

    // Notify renderer via contextBridge (the MessagePort died with the process).
    this.onSimhostCrashedCb?.({ willRespawn })

    if (!willRespawn) {
      this.fatal = true
      return
    }

    // Schedule respawn with backoff.
    const delay = this.backoffDelay()
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      this.spawnChild()
    }, delay)
  }

  /**
   * True when the number of crashes that occurred within the fatal window (30 s)
   * has reached or exceeded the fatal threshold (5).
   */
  private isFatalThreshold(): boolean {
    return this.crashTimestamps.length >= FATAL_CRASH_COUNT
  }

  /**
   * Backoff delay based on crash count.
   * 1st crash → 250 ms, 2nd → 1 s, 3rd+ → 5 s.
   */
  private backoffDelay(): number {
    const idx = Math.min(this.crashCount - 1, BACKOFF_DELAYS_MS.length - 1)
    return BACKOFF_DELAYS_MS[idx]!
  }

  // ── Child lifecycle ────────────────────────────────────────────────────────

  private killChild(): void {
    if (!this.child) return
    if (this.boundExitListener) {
      this.child.off('exit', this.boundExitListener)
      this.boundExitListener = null
    }
    try {
      this.child.kill()
    } catch {
      /* best-effort */
    }
    this.child = null
  }
}

// ─── Production factory ───────────────────────────────────────────────────────

/**
 * Create a SimhostSupervisor wired to the real Electron APIs.
 * Called from src/main/index.ts after app.whenReady().
 *
 * Import is deferred (dynamic) so this file stays importable from Vitest tests
 * that run in plain Node without Electron available.
 */
export async function createProductionSupervisor(opts: {
  simhostPath: string
  onSimhostCrashed: CrashedCallback
}): Promise<SimhostSupervisor> {
  // Dynamic import keeps Electron out of the import graph for tests.
  const { utilityProcess, MessageChannelMain } = await import('electron')

  const fork: ForkFn = (modulePath: string) => {
    // stdio:'pipe' so SimHost child stdout/stderr is forwarded to the main
    // console with a prefix — invaluable for diagnosing a child that fails to
    // start or crashes (otherwise its output is invisible).
    const child = utilityProcess.fork(modulePath, [], { stdio: 'pipe' })
    child.stdout?.on('data', (d: Buffer) => process.stdout.write('[simhost] ' + d.toString()))
    child.stderr?.on('data', (d: Buffer) => process.stderr.write('[simhost] ' + d.toString()))
    return {
      // Transfer the RAW MessagePortMain, not the PortHandle wrapper — Electron's
      // transfer list rejects/ignores wrapper objects (this was the handshake bug).
      postMessage: (msg, ports) =>
        child.postMessage(msg, (ports ?? []).map(unwrapPort) as import('electron').MessagePortMain[]),
      kill: () => child.kill(),
      on: (event, listener) => { if (event === 'exit') child.on('exit', listener) },
      off: (event, listener) => { if (event === 'exit') child.off('exit', listener) }
    }
  }

  const portPairFactory: PortPairFactory = () => {
    const channel = new MessageChannelMain()
    // Wrap Electron's MessagePortMain into our PortHandle interface, keeping a
    // reference to the raw port (__raw) so it can be unwrapped for transfer.
    const wrapPort = (p: import('electron').MessagePortMain): PortHandle => ({
      __raw: p,
      start: () => p.start(),
      close: () => p.close(),
      postMessage: (msg, ports) =>
        p.postMessage(msg, (ports ?? []).map(unwrapPort) as import('electron').MessagePortMain[]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: (event, listener) => (p as any).on(event, listener),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      off: (event, listener) => (p as any).off(event, listener)
    })
    return { port1: wrapPort(channel.port1), port2: wrapPort(channel.port2) }
  }

  return new SimhostSupervisor({
    fork,
    portPairFactory,
    simhostPath: opts.simhostPath,
    onSimhostCrashed: opts.onSimhostCrashed
  })
}
