/**
 * src/simhost/index.ts
 *
 * SimHost orchestrator — runs as an Electron utilityProcess (Spec §6, §7).
 *
 * Owns:
 *  - the serial command queue (drained from a setImmediate loop; FFI callbacks
 *    only ever enqueue — Spec §7.4 gotcha 2)
 *  - the 10 s watchdog (process.exit(86) on stall — Spec §7.4 gotcha 7); viable
 *    only because blocking commands use koffi's async form so the event loop runs
 *  - `destroy all` before every loadCircuit (Spec §7.4 gotcha 5)
 *  - device-token lowercasing before alter (Spec §7.4 gotcha 1)
 *  - the haltOwner state machine scaffold (Spec §7.4.3 — fully exercised in Task 10)
 *  - runOp + opResult key normalization (Spec §6.1)
 *  - the XSPICE `.cm` startup smoke deck (Spec §7.2)
 *
 * Transient streaming, pacing, alter batching and bounded bench windows land in
 * Task 10; this module exposes the engine + runOp + smoke check that Task 10 and
 * the integration test build on.
 */

import { NgspiceFfiEngine, ngspiceResourcesAvailable } from './ngspiceFfi'
import type { SpiceEngine } from './engine'
import {
  isScaleVectorName,
  normalizeVectorKey,
  type SimCommand,
  type SimEvent
} from './protocol'

// ─── tunables ────────────────────────────────────────────────────────────────

const WATCHDOG_MS = 10_000
const WATCHDOG_EXIT_CODE = 86

export type HaltOwner = 'none' | 'user' | 'alter' | 'pacing'

// ─── queued work item ────────────────────────────────────────────────────────

interface QueueItem {
  run: () => Promise<void>
  label: string
}

// ─── SimHost orchestrator ────────────────────────────────────────────────────

export interface SimHostOptions {
  engine?: SpiceEngine
  /** Sink for SimEvents — the MessagePort in production, a spy in tests. */
  emit?: (ev: SimEvent) => void
  /** Override resources base dir (tests). */
  resourcesBaseDir?: string
  /** Disable the watchdog (unit tests with stub engines). */
  disableWatchdog?: boolean
}

export class SimHost {
  private engine: SpiceEngine
  private readonly emit: (ev: SimEvent) => void
  private readonly disableWatchdog: boolean

  private queue: QueueItem[] = []
  private draining = false
  private watchdogTimer: NodeJS.Timeout | null = null
  private lastProgress = Date.now()

  private currentDeck: string[] = []
  private deckLoaded = false

  /** Halt-ownership state machine (Spec §7.4.3). */
  private haltOwner: HaltOwner = 'none'

  private engineUnsub: (() => void) | null = null

  constructor(opts: SimHostOptions = {}) {
    this.engine =
      opts.engine ?? new NgspiceFfiEngine({ resourcesBaseDir: opts.resourcesBaseDir })
    this.emit = opts.emit ?? (() => {})
    this.disableWatchdog = opts.disableWatchdog ?? false
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Initialize the engine, wire events, run the startup smoke check. */
  async start(): Promise<void> {
    this.engine.init()

    // Any FFI callback that reports text/stat is "progress" — feed the watchdog
    // and relay logs. Callbacks ONLY enqueue/emit; they never call into ngspice.
    this.engineUnsub = this.engine.on((ev) => {
      switch (ev.type) {
        case 'char':
        case 'stat':
          this.noteProgress()
          break
        case 'log':
          this.emit({ type: 'log', level: ev.level, text: ev.text })
          this.noteProgress()
          break
        case 'controlledExit':
          // ngspice asked to exit — surface it; Main will respawn (Task 11).
          this.emit({
            type: 'log',
            level: 'error',
            text: `ngspice ControlledExit status=${ev.status} immediate=${ev.immediate}`
          })
          break
        default:
          break
      }
    })

    this.emit({ type: 'ready', ngspiceVersion: this.engine.version })

    await this.runStartupSmokeCheck()
  }

  /** Tear down (best effort). */
  dispose(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    if (this.engineUnsub) {
      this.engineUnsub()
      this.engineUnsub = null
    }
    this.engine.dispose()
  }

  // ── command intake ───────────────────────────────────────────────────────

  /** Handle a SimCommand from the renderer. Returns when the command is enqueued. */
  handleCommand(cmd: SimCommand): void {
    switch (cmd.type) {
      case 'loadCircuit':
        this.enqueueLoadCircuit(cmd.deckLines)
        break
      case 'runOp':
        this.enqueue('runOp', async () => {
          await this.doRunOp()
        })
        break
      case 'alter':
        this.enqueueAlter(cmd)
        break
      case 'halt':
        this.setHaltOwner('user')
        this.enqueue('halt', () => this.engine.command('bg_halt', false))
        break
      case 'resume':
        // Only the 'user' owner may clear a user halt (Spec §7.4.3).
        if (this.haltOwner === 'user') {
          this.haltOwner = 'none'
          this.enqueue('resume', () => this.engine.command('bg_resume', false))
        }
        break
      case 'stop':
        this.enqueue('stop', () => this.engine.command('bg_halt', false))
        break
      case 'runTransient':
      case 'runAc':
      case 'setPace':
        // Implemented in Task 10. Acknowledge with a log so nothing silently drops.
        this.emit({
          type: 'log',
          level: 'info',
          text: `command "${cmd.type}" not yet implemented (Task 10)`
        })
        break
      default: {
        // exhaustiveness guard
        const _never: never = cmd
        void _never
      }
    }
  }

  // ── op analysis ────────────────────────────────────────────────────────────

  /**
   * Run a DC operating point and emit a normalized opResult (Spec §6.1).
   * Public so the integration test can await it directly.
   */
  async runOp(): Promise<Record<string, number>> {
    return new Promise<Record<string, number>>((resolve, reject) => {
      this.enqueue('runOp', async () => {
        try {
          const values = await this.doRunOp()
          resolve(values)
        } catch (e) {
          reject(e)
          throw e
        }
      })
    })
  }

  private async doRunOp(): Promise<Record<string, number>> {
    // op is a potentially-blocking command → async FFI (Spec §7.4 #4).
    await this.engine.command('op', true)
    const values = this.readPlotValues()
    this.emit({ type: 'opResult', values })
    return values
  }

  /**
   * Read every real vector of the current plot, normalize keys per Spec §6.1:
   *  - bare lowercase node names for voltages ("out", not "v(out)"/"OUT")
   *  - "i(<dev>)" for source/device branch currents
   *  - scale vectors (time/frequency) dropped
   * Each vector's *last* sample is taken (op plots are length 1; this is also
   * correct for reading a settled value off a tran plot).
   */
  private readPlotValues(): Record<string, number> {
    const plot = this.engine.currentPlot()
    const names = this.engine.allVectors(plot)
    const values: Record<string, number> = {}
    for (const raw of names) {
      if (isScaleVectorName(raw)) continue
      const data = this.engine.vectorData(raw)
      if (!data || data.length === 0) continue
      const key = normalizeVectorKey(raw)
      values[key] = data[data.length - 1]
    }
    return values
  }

  // ── loadCircuit ──────────────────────────────────────────────────────────

  private enqueueLoadCircuit(deckLines: string[]): void {
    this.enqueue('loadCircuit', async () => {
      // Spec §7.4 gotcha 5: free retained vectors before each reload.
      if (this.deckLoaded) {
        await this.engine.command('destroy all', false)
      }
      this.currentDeck = [...deckLines]
      this.engine.loadCircuit(this.currentDeck)
      this.deckLoaded = true
    })
  }

  // ── alter ──────────────────────────────────────────────────────────────────

  private enqueueAlter(cmd: Extract<SimCommand, { type: 'alter' }>): void {
    // Spec §7.4 gotcha 1: device tokens must be lowercased or the alter silently
    // no-ops through the shared-library API.
    const device = cmd.device.toLowerCase()
    const value = cmd.value
    const alterCmd =
      cmd.param !== undefined
        ? `alter ${device} ${cmd.param} = ${value}`
        : `alter ${device} = ${value}`
    this.enqueue('alter', async () => {
      await this.engine.command(alterCmd, false)
    })
  }

  // ── haltOwner state machine (Spec §7.4.3) ──────────────────────────────────

  /**
   * Request a halt on behalf of `owner`. `user` outranks alter/pacing; an alter
   * or pacing halt during a user-pause is recorded but must not later resume.
   * (Resume logic for non-user owners lands fully in Task 10's pacing/alter loop.)
   */
  setHaltOwner(owner: Exclude<HaltOwner, 'none'>): void {
    if (this.haltOwner === 'user' && owner !== 'user') {
      // user pause outranks: keep user ownership.
      return
    }
    this.haltOwner = owner
  }

  getHaltOwner(): HaltOwner {
    return this.haltOwner
  }

  // ── queue + watchdog ────────────────────────────────────────────────────

  private enqueue(label: string, run: () => Promise<void>): void {
    this.queue.push({ label, run })
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = true
    // Drain from a JS-thread frame (setImmediate), NEVER from an FFI callback
    // (Spec §7.4 gotcha 2).
    setImmediate(() => void this.drain())
  }

  private async drain(): Promise<void> {
    this.startWatchdog()
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!
        this.noteProgress()
        try {
          await item.run()
        } catch (e) {
          this.emit({
            type: 'log',
            level: 'error',
            text: `command "${item.label}" failed: ${(e as Error).message}`
          })
        }
        this.noteProgress()
      }
    } finally {
      this.draining = false
      this.stopWatchdog()
    }
  }

  private noteProgress(): void {
    this.lastProgress = Date.now()
  }

  private startWatchdog(): void {
    if (this.disableWatchdog || this.watchdogTimer) return
    this.lastProgress = Date.now()
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastProgress > WATCHDOG_MS) {
        // No progress for 10 s while work is queued → ngspice is wedged.
        // Respawn is the only reliable reset (Spec §7.4 gotcha 7).
        // eslint-disable-next-line no-console
        console.error(
          `[simhost] watchdog: no progress for ${WATCHDOG_MS} ms — exiting ${WATCHDOG_EXIT_CODE}`
        )
        process.exit(WATCHDOG_EXIT_CODE)
      }
    }, 1_000)
    if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref()
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  // ── startup smoke check (Spec §7.2) ────────────────────────────────────────

  /**
   * Load + run the XSPICE adc_bridge→d_inverter→dac_bridge deck once at init.
   * Pass = final v(out) ≥ 4.5 (proves the `.cm` code models loaded). On failure,
   * emit a loud error naming the `.cm` files.
   *
   * NOTE (verified against ngspice 46, deviation from plan/spec text): the
   * inverter code model is named `d_inverter`, not `d_inv` — `d_inv` does not
   * exist in ngspice's digital.cm (confirmed via `devhelp`). The chain itself is
   * exactly the spec's adc_bridge→inverter→dac_bridge structure.
   */
  async runStartupSmokeCheck(): Promise<boolean> {
    const deck = [
      '* cm smoke: 0V in -> adc -> d_inverter -> dac -> expect ~5V out',
      'v1 in 0 dc 0',
      'abr_in [in] [din] adcm',
      '.model adcm adc_bridge(in_low=1.0 in_high=2.0)',
      'ainv din dout invm',
      '.model invm d_inverter(rise_delay=1n fall_delay=1n)',
      'abr_out [dout] [out] dacm',
      '.model dacm dac_bridge(out_low=0 out_high=5)',
      '.tran 1n 20n',
      '.end'
    ]
    try {
      this.engine.loadCircuit(deck)
      await this.engine.command('run', true)
      const out = this.engine.vectorData('out')
      const finalOut = out && out.length > 0 ? out[out.length - 1] : NaN
      const passed = Number.isFinite(finalOut) && finalOut >= 4.5
      if (!passed) {
        this.emit({
          type: 'log',
          level: 'error',
          text:
            `XSPICE code-model smoke check FAILED (v(out)=${finalOut}). The .cm code ` +
            `models (digital.cm, analog.cm, xtradev.cm, xtraevt.cm, spice2poly.cm) did ` +
            `not load. Check resources/ngspice/<platform>/lib/ngspice and SPICE_SCRIPTS.`
        })
      }
      // Clean up the smoke plot so it doesn't pollute later loads.
      await this.engine.command('destroy all', false)
      this.deckLoaded = false
      return passed
    } catch (e) {
      this.emit({
        type: 'log',
        level: 'error',
        text: `XSPICE code-model smoke check threw: ${(e as Error).message}`
      })
      return false
    }
  }

  // ── test accessors ──────────────────────────────────────────────────────

  /** For integration tests: drain the queue and resolve when idle. */
  async whenIdle(): Promise<void> {
    while (this.queue.length > 0 || this.draining) {
      await new Promise((r) => setImmediate(r))
    }
  }
}

// ─── MessagePort wiring (runs only inside the utilityProcess) ─────────────────

/**
 * Bootstrap SimHost when launched as an Electron utilityProcess. The renderer↔
 * SimHost MessagePort arrives via process.parentPort (Electron). Guarded so that
 * importing this module from tests does NOT spin up a real engine.
 */
function bootstrapUtilityProcess(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parentPort = (process as any).parentPort
  if (!parentPort) return // not running as a utilityProcess (e.g. unit tests)

  if (!ngspiceResourcesAvailable()) {
    // No engine available; report and idle. Main's watchdog/respawn handles the rest.
    parentPort.on('message', () => {})
    try {
      parentPort.postMessage({
        type: 'log',
        level: 'error',
        text: 'ngspice resources not found for this platform'
      } satisfies SimEvent)
    } catch {
      /* ignore */
    }
    return
  }

  const host = new SimHost({
    emit: (ev: SimEvent) => {
      try {
        parentPort.postMessage(ev)
      } catch {
        /* port may have closed during shutdown */
      }
    }
  })

  parentPort.on('message', (e: { data: SimCommand }) => {
    try {
      host.handleCommand(e.data)
    } catch (err) {
      try {
        parentPort.postMessage({
          type: 'log',
          level: 'error',
          text: `handleCommand error: ${(err as Error).message}`
        } satisfies SimEvent)
      } catch {
        /* ignore */
      }
    }
  })

  host.start().catch((err) => {
    try {
      parentPort.postMessage({
        type: 'log',
        level: 'error',
        text: `SimHost start failed: ${(err as Error).message}`
      } satisfies SimEvent)
    } catch {
      /* ignore */
    }
  })
}

bootstrapUtilityProcess()
