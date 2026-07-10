/**
 * src/simhost/index.ts
 *
 * SimHost orchestrator — runs as an Electron utilityProcess (Spec §6, §7).
 *
 * Owns:
 *  - the serial command queue (drained from a setImmediate loop; FFI callbacks
 *    only ever enqueue — Spec §7.4 gotcha 2)
 *  - the 60 s watchdog (process.exit(86) on stall — Spec §7.4 gotcha 7); viable
 *    only because blocking commands use koffi's async form so the event loop runs
 *  - `destroy all` before every loadCircuit (Spec §7.4 gotcha 5)
 *  - device-token lowercasing before alter (Spec §7.4 gotcha 1)
 *  - the haltOwner state machine (Spec §7.4.3, HaltCoordinator)
 *  - runOp + opResult key normalization + gmin/src-step retry ladder (Spec §6.1, §8.8)
 *  - runTransient via `bg_tran <tstep> <tstop> uic` streaming → sampleBatcher → `samples`
 *  - bounded bench windows: tstop = W (default 30 s); on window end OR RSS>1.5 GB,
 *    halt → destroy all → reload → restart at t=0 → emit `benchRestarted` (Spec §7.5)
 *  - pacing: 50 ms loop holding realtimeFactor ≈ 1 (or 'max'); report achieved
 *    factor every 250 ms (Spec §7.5)
 *  - alter batching: bg_halt → alters → bg_resume, 30 ms coalesce window (Spec §7.4.3)
 *  - convergence pattern-match on SendChar text → convergenceFailure (Spec §7.4.6)
 *  - the XSPICE `.cm` startup smoke deck (Spec §7.2)
 */

import { HaltCoordinator } from './haltCoordinator'
import { NgspiceFfiEngine, ngspiceResourcesAvailable } from './ngspiceFfi'
import { SampleBatcher } from './sampleBatcher'
import type { EngineEvent, SpiceEngine } from './engine'
import {
  isScaleVectorName,
  normalizeVectorKey,
  type OpSolveMethod,
  type SimCommand,
  type SimEvent
} from './protocol'

// ─── tunables ────────────────────────────────────────────────────────────────

/**
 * Stall watchdog threshold. Catches a WEDGED engine (supervisor respawns on
 * exit 86) — it must never kill a busy one. ngspice's op retry ladder can
 * grind with NO callback traffic for >10 s on a slow machine (CI's shared
 * Windows runners hit this mid-op), so the threshold sits well above any
 * legitimate silent solve phase. Progress = queue-item boundaries + every
 * char/stat/log/data callback (see onEngineEvent).
 */
const WATCHDOG_MS = 60_000
const WATCHDOG_EXIT_CODE = 86

/** Default bench window (sim-time seconds) for a bounded transient (Spec §7.5). */
const DEFAULT_BENCH_WINDOW_S = 30
/** RSS guard: restart the bench window if SimHost memory exceeds this (Spec §7.5). */
const RSS_GUARD_BYTES = 1.5 * 1024 * 1024 * 1024
/** Pacing loop interval (Spec §7.5). */
const PACING_INTERVAL_MS = 50
/** Achieved-factor status report cadence (Spec §7.5). */
const STATUS_REPORT_MS = 250
/** Alter coalesce window so a knob drag batches into one halt/resume (Spec §7.4.3). */
const ALTER_COALESCE_MS = 30
/** Sample-flush age threshold (Spec §6.1). */
const FLUSH_AGE_MS = 16

/** ngspice convergence-failure signatures (Spec §7.4.6). */
const CONVERGENCE_PATTERNS = [
  /timestep too small/i,
  /no convergence/i,
  /singular matrix/i,
  /iteration limit reached/i,
  /gmin stepping failed/i,
  /source stepping failed/i
]

export type { HaltOwner } from './haltCoordinator'

// ─── queued work item ────────────────────────────────────────────────────────

interface QueueItem {
  run: () => Promise<void>
  label: string
}

// ─── SimHost orchestrator ────────────────────────────────────────────────────

export interface SimHostOptions {
  engine?: SpiceEngine
  /** Sink for SimEvents — the MessagePort in production, a spy in tests. */
  emit?: (ev: SimEvent, transfer?: ArrayBuffer[]) => void
  /** Override resources base dir (tests). */
  resourcesBaseDir?: string
  /** Disable the watchdog (unit tests with stub engines). */
  disableWatchdog?: boolean
  /** Bench window in sim-time seconds (Spec §7.5). Default 30. */
  benchWindowSeconds?: number
  /** Override the RSS-usage probe (tests). */
  rssBytes?: () => number
  /** Monotonic wall clock (ms). Injectable for deterministic tests. */
  now?: () => number
  /** Disable the internal pacing/flush timers (unit tests drive ticks directly). */
  disableTimers?: boolean
}

export class SimHost {
  private engine: SpiceEngine
  private readonly emit: (ev: SimEvent, transfer?: ArrayBuffer[]) => void
  private readonly disableWatchdog: boolean
  private readonly disableTimers: boolean
  private readonly benchWindowSeconds: number
  private readonly rssBytes: () => number
  private readonly now: () => number

  private queue: QueueItem[] = []
  private draining = false
  private watchdogTimer: NodeJS.Timeout | null = null
  private lastProgress = Date.now()

  private currentDeck: string[] = []
  private deckLoaded = false

  /**
   * True while the op retry ladder is running. Suppresses live convergence
   * pattern-matching on SendChar text: ngspice's own internal gmin/source
   * stepping prints "no convergence" chatter even on a run that ultimately
   * converges, which would otherwise emit spurious convergenceFailure events.
   * The ladder emits its own structured failure only after all rungs fail.
   */
  private opInFlight = false

  /**
   * ngspice fallback chatter observed while the op ladder runs (reset per op).
   * ngspice narrates its OWN internal convergence helpers on SendChar — gmin
   * stepping, source stepping, and the transient-op (OPTRAN) fallback — even
   * when the `op` command ultimately "succeeds". These flags let doRunOp report
   * an honest OpSolveMethod instead of presenting a fallback solve as direct.
   */
  private opChatter = { gminStepping: false, sourceStepping: false, tranOp: false }

  /** Halt-ownership state machine (Spec §7.4.3). */
  private halt: HaltCoordinator

  /** Transient streaming state. */
  private batcher = new SampleBatcher({ maxAgeMs: FLUSH_AGE_MS })
  private vectorsEmitted = false

  /** Active transient run parameters (null when not running a tran). */
  private tran: {
    tstep: number
    tstop: number
    /** sim-time of the latest sample seen this window. */
    simTime: number
    /** wall-clock ms when the window started. */
    windowStartWall: number
    /** sim-time at which this bg_tran's tstop sits (= min(tstop, W)). */
    windowStop: number
    /**
     * True when the requested tstop exceeds the bench window W, so reaching
     * windowStop means "restart the next window" (continuous bench). False for a
     * finite run that should simply complete when it reaches windowStop.
     */
    continuous: boolean
    /** Set once the run has reached its end (finite) — suppresses restart loop. */
    finished: boolean
    /** target realtimeFactor, or 'max' to run unthrottled. */
    pace: number | 'max'
  } | null = null

  /** Pending alters awaiting their coalesce window (Spec §7.4.3). */
  private pendingAlters: string[] = []
  private alterTimer: NodeJS.Timeout | null = null

  /** Periodic timers (pacing/flush + status report). */
  private pacingTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private lastStatusAt = 0

  private engineUnsub: (() => void) | null = null

  /**
   * Background-thread liveness as reported by ngspice's BGThreadRunning
   * callback. Distinct from engine.isRunning(): the flag flips false BEFORE
   * the final callbacks finish relaying to the JS thread, whereas observing
   * the bgRunning:false EVENT proves that relay has been serviced. Both are
   * needed by the dispose drain (see dispose()).
   */
  private bgThreadRunning = false
  /** True once any background run was started — gates the dispose settle. */
  private bgEverRan = false

  constructor(opts: SimHostOptions = {}) {
    this.engine =
      opts.engine ?? new NgspiceFfiEngine({ resourcesBaseDir: opts.resourcesBaseDir })
    this.emit = opts.emit ?? (() => {})
    this.disableWatchdog = opts.disableWatchdog ?? false
    this.disableTimers = opts.disableTimers ?? false
    this.benchWindowSeconds = opts.benchWindowSeconds ?? DEFAULT_BENCH_WINDOW_S
    this.rssBytes = opts.rssBytes ?? (() => process.memoryUsage().rss)
    this.now = opts.now ?? (() => Date.now())

    this.halt = new HaltCoordinator({
      halt: () => {
        void this.engine.command('bg_halt', false)
      },
      resume: () => {
        void this.engine.command('bg_resume', false)
      }
    })

    // Wire the engine event stream now (registration only — no init required), so
    // unit tests that drive a stub engine without start() still receive char/
    // data/initData events.
    this.engineUnsub = this.engine.on((ev: EngineEvent) => this.onEngineEvent(ev))
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Initialize the engine, run the startup smoke check. */
  async start(): Promise<void> {
    this.engine.init()
    this.emit({ type: 'ready', ngspiceVersion: this.engine.version })
    await this.runStartupSmokeCheck()
  }

  /**
   * Handle one EngineEvent. Runs on the FFI callback frame for char/stat/data/
   * initData — must stay cheap and never call back into ngspice (Spec §7.4 #2).
   * The sampleBatcher.push() here is just array appends; flushes are emitted from
   * the JS-thread pacing timer, not from here.
   */
  private onEngineEvent(ev: EngineEvent): void {
    switch (ev.type) {
      case 'char':
        this.noteProgress()
        this.detectConvergence(ev.text)
        break
      case 'stat':
        this.noteProgress()
        break
      case 'log':
        this.emit({ type: 'log', level: ev.level, text: ev.text })
        this.noteProgress()
        this.detectConvergence(ev.text)
        break
      case 'controlledExit':
        this.emit({
          type: 'log',
          level: 'error',
          text: `ngspice ControlledExit status=${ev.status} immediate=${ev.immediate}`
        })
        break
      case 'bgRunning':
        this.bgThreadRunning = ev.running
        if (ev.running) this.bgEverRan = true
        this.noteProgress()
        break
      case 'initData':
        if (this.tran) {
          const scale = ev.names.find(isScaleVectorName) ?? 'time'
          this.batcher.setVectors(ev.names, scale)
          if (!this.vectorsEmitted) {
            this.emit({ type: 'vectors', names: this.batcher.getVectorNames() })
            this.vectorsEmitted = true
          }
        }
        this.noteProgress()
        break
      case 'data':
        if (this.tran) {
          const t = ev.row[ev.scaleName]
          if (Number.isFinite(t)) this.tran.simTime = t
          const flush = this.batcher.push(ev.row)
          if (flush) this.emit(flush.event, flush.transfer)
        }
        this.noteProgress()
        break
      default:
        break
    }
  }

  /**
   * Tear down (best effort). Async because it must DRAIN the engine before
   * releasing it: engine.dispose() unloads the shared library, and koffi
   * callback relays still in flight at that point (or at Node env teardown)
   * crash the process on Linux — the flaky-CI half of the 6 h-hang bug. Order:
   *   1. bg_halt (async, serialized) and wait until ngSpice_running() is false;
   *   2. wait for the FINAL BGThreadRunning callback to be observed — the
   *      running flag flips before the last relays are serviced, so step 1
   *      alone is not enough;
   *   3. a short settle for straggler SendChar relays (only if a background
   *      run ever happened — op-only sessions have nothing in flight);
   *   4. unsubscribe + engine.dispose() (unregisters callbacks, unloads).
   * Safe on a never-started host: command() throws, which is swallowed.
   */
  async dispose(): Promise<void> {
    this.stopWatchdog()
    this.stopPeriodicTimers()
    if (this.alterTimer) {
      clearTimeout(this.alterTimer)
      this.alterTimer = null
    }
    this.tran = null
    try {
      await this.engine.command('bg_halt', false)
      await this.waitForHalt()
      const deadline = Date.now() + 500
      while (this.bgThreadRunning && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5))
      }
      if (this.bgEverRan) {
        await new Promise((r) => setTimeout(r, 150))
      }
    } catch {
      /* engine not initialized (or already torn down) — nothing to drain */
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
      case 'runTransient':
        this.enqueueRunTransient(cmd.tstepSeconds, cmd.tstopSeconds)
        break
      case 'alter':
        this.queueAlter(cmd)
        break
      case 'halt':
        // User pause outranks alter/pacing (Spec §7.4.3).
        this.enqueue('halt', async () => {
          this.halt.requestHalt('user')
        })
        break
      case 'resume':
        this.enqueue('resume', async () => {
          this.halt.requestResume('user')
        })
        break
      case 'stop':
        this.enqueue('stop', async () => {
          this.stopTransient()
        })
        break
      case 'setPace':
        this.enqueue('setPace', async () => {
          if (this.tran) this.tran.pace = cmd.realtimeFactor
        })
        break
      case 'runAc':
        // AC analysis is specced in the protocol but deferred (post-v1 backlog).
        this.emit({
          type: 'log',
          level: 'info',
          text: 'runAc is not implemented in v1 (protocol reserved for post-v1)'
        })
        break
      default: {
        const _never: never = cmd
        void _never
      }
    }
  }

  // ── op analysis + convergence retry ladder (Spec §8.8) ─────────────────────

  /** Run a DC operating point with the gmin/src-step retry ladder. */
  async runOp(): Promise<Record<string, number>> {
    return new Promise<Record<string, number>>((resolve, reject) => {
      this.enqueue('runOp', async () => {
        try {
          resolve(await this.doRunOp())
        } catch (e) {
          reject(e)
          throw e
        }
      })
    })
  }

  /**
   * op with a convergence retry ladder (Spec §8.8): plain op → gmin stepping →
   * source stepping. Each rung re-checks for a usable result; on exhaustion emit
   * a structured convergenceFailure.
   */
  private async doRunOp(): Promise<Record<string, number>> {
    const ladder = [
      { cmd: 'op', label: 'op' },
      { cmd: 'setplot new\nop', label: 'op (retry)', options: 'set gminsteps=10' },
      { cmd: 'op', label: 'op (source-step)', options: 'set srcsteps=10' }
    ]
    let lastValues: Record<string, number> = {}
    // Suppress live convergence-pattern detection WHILE the op ladder runs: as
    // ngspice applies its OWN internal gmin/source stepping it prints
    // "no convergence"/"gmin stepping" chatter on SendChar EVEN WHEN it ultimately
    // converges. Treating that chatter as a hard failure spammed the renderer with
    // false convergenceFailure events (and a misleading "didn't converge" card)
    // for a circuit that actually solved fine (e.g. the bundled NE555). The ladder
    // emits its OWN structured failure below only if every rung truly fails.
    this.opInFlight = true
    this.opChatter = { gminStepping: false, sourceStepping: false, tranOp: false }
    try {
      for (let rung = 0; rung < ladder.length; rung++) {
        const step = ladder[rung]
        if (step.options) {
          await this.engine.command(step.options, false)
        }
        // op is potentially-blocking → async FFI (Spec §7.4 #4).
        await this.engine.command('op', true)
        lastValues = this.readPlotValues()
        // A converged op yields finite node voltages.
        const finite = Object.values(lastValues).some((v) => Number.isFinite(v))
        if (finite && Object.keys(lastValues).length > 0) {
          // Name the rung that actually produced the solution so the renderer
          // can caveat fallback solves (F1 — a fallback op frequently reports
          // 0.000 V on nets it could not really resolve).
          this.emit({ type: 'opResult', values: lastValues, method: this.opMethodForRung(rung) })
          return lastValues
        }
      }
    } finally {
      this.opInFlight = false
    }
    this.emit({
      type: 'convergenceFailure',
      detail:
        'DC operating point did not converge after gmin stepping and source ' +
        'stepping. Common causes: missing DC path to ground, a floating node, or ' +
        'an unstable feedback loop.'
    })
    this.emit({ type: 'opResult', values: lastValues, method: 'failed' })
    return lastValues
  }

  /**
   * Read every real vector of the current plot, normalize keys per Spec §6.1.
   * Takes each vector's last sample (op plots are length 1).
   */
  private readPlotValues(): Record<string, number> {
    const plot = this.engine.currentPlot()
    const names = this.engine.allVectors(plot)
    const values: Record<string, number> = {}
    for (const raw of names) {
      if (isScaleVectorName(raw)) continue
      const data = this.engine.vectorData(raw)
      if (!data || data.length === 0) continue
      values[normalizeVectorKey(raw)] = data[data.length - 1]
    }
    return values
  }

  // ── transient streaming + bounded bench windows (Spec §7.5) ────────────────

  private enqueueRunTransient(tstep: number, tstop: number): void {
    this.enqueue('runTransient', async () => {
      await this.startTransientWindow(tstep, tstop, this.now())
    })
  }

  /**
   * Begin (or restart) a bounded bench window. The requested `tstopSeconds` is
   * capped to the bench window W so ngspice never retains an unbounded plot in
   * RAM (Spec §7.5). `uic` is used so the circuit charges from its initial
   * conditions (the "power on and watch it come alive" bench semantics — without
   * uic ngspice solves the DC operating point first and the run starts settled;
   * verified against ngspice 46).
   */
  private async startTransientWindow(
    tstep: number,
    tstop: number,
    wallNow: number,
    pace: number | 'max' = 1
  ): Promise<void> {
    // Bench window: the effective tstop is the smaller of the request and W.
    // When the request exceeds W the run is "continuous" and restarts at the
    // window boundary; otherwise it is a finite run that completes at windowStop.
    const windowStop = Math.min(tstop, this.benchWindowSeconds)
    const continuous = tstop > this.benchWindowSeconds

    this.batcher.reset()
    this.vectorsEmitted = false
    this.halt.clear()

    this.tran = {
      tstep,
      tstop,
      simTime: 0,
      windowStartWall: wallNow,
      windowStop,
      continuous,
      finished: false,
      pace
    }

    // bg_tran returns immediately (background thread) — non-blocking is correct.
    await this.engine.command(`bg_tran ${formatNum(tstep)} ${formatNum(windowStop)} uic`, false)

    this.lastStatusAt = wallNow
    this.startPeriodicTimers()
  }

  /**
   * One pacing/flush tick (Spec §7.5). Drives: time-based sample flush, real-time
   * pacing (halt/resume to hold realtimeFactor), bench-window restart on window
   * end or RSS guard, and the periodic achieved-factor status report.
   *
   * Public + parameterless-by-clock so unit tests can step it deterministically.
   */
  pacingTick(): void {
    if (!this.tran) return
    const t = this.tran

    // (1) Time-based sample flush (size-based flushes happen inline on push).
    if (this.batcher.shouldFlushByAge()) {
      const flush = this.batcher.flush()
      if (flush) this.emit(flush.event, flush.transfer)
    }

    // (2) Bench-window handling (§7.5).
    //   - RSS guard always forces a restart of the (continuous) window.
    //   - Reaching windowStop: restart for a continuous run; for a finite run it
    //     simply means the requested transient has completed → finalize.
    const memoryHit = this.rssBytes() > RSS_GUARD_BYTES
    const windowHit = t.simTime >= t.windowStop && t.windowStop > 0
    if (memoryHit) {
      void this.restartBenchWindow('memory')
      return
    }
    if (windowHit) {
      if (t.continuous) {
        void this.restartBenchWindow('window-elapsed')
      } else if (!t.finished && !this.engine.isRunning()) {
        // Finite run reached its tstop and the bg thread has stopped → finalize:
        // flush the tail and tear down the pacing loop. Keep `tran` so a late
        // pacingTick (e.g. from a test) is a no-op rather than a crash.
        t.finished = true
        this.finalizeFiniteRun()
      }
      return
    }

    // (3) Real-time pacing. Skip while the user has paused (their pause outranks).
    if (!this.halt.isUserPaused() && t.pace !== 'max') {
      const wallElapsedS = (this.now() - t.windowStartWall) / 1000
      const targetSimTime = wallElapsedS * (t.pace as number)
      if (t.simTime > targetSimTime) {
        // Sim is ahead of wall-clock → throttle by halting (owner 'pacing').
        this.halt.requestHalt('pacing')
      } else if (this.halt.getOwner() === 'pacing') {
        // Sim has fallen back to/behind target → release the pacing halt.
        this.halt.requestResume('pacing')
      }
    } else if (t.pace === 'max' && this.halt.getOwner() === 'pacing') {
      // Switched to 'max' while pacing-halted → release.
      this.halt.requestResume('pacing')
    }

    // (4) Periodic achieved-factor status report (§7.5).
    if (this.now() - this.lastStatusAt >= STATUS_REPORT_MS) {
      this.reportStatus()
      this.lastStatusAt = this.now()
    }
  }

  private reportStatus(): void {
    if (!this.tran) return
    const wallElapsedS = (this.now() - this.tran.windowStartWall) / 1000
    const achieved = wallElapsedS > 0 ? this.tran.simTime / wallElapsedS : 0
    this.emit({
      type: 'status',
      running: this.engine.isRunning(),
      simTimeSeconds: this.tran.simTime,
      realtimeFactor: achieved
    })
  }

  /**
   * Bench-window restart (Spec §7.5): halt → destroy all → reload deck → restart
   * the transient from t=0 → emit benchRestarted. Scope history lives in the
   * renderer ring buffers, so nothing is lost visually.
   */
  private async restartBenchWindow(reason: 'window-elapsed' | 'memory'): Promise<void> {
    if (!this.tran) return
    const { tstep, tstop, pace } = this.tran
    // Suspend the windowed run so the timers don't re-trigger mid-restart.
    this.tran = null
    this.stopPeriodicTimers()

    this.enqueue('benchRestart', async () => {
      await this.engine.command('bg_halt', false)
      await this.waitForHalt()
      await this.engine.command('destroy all', false)
      this.halt.clear()
      // Reload the deck so the plot is fresh (frees retained timepoints).
      this.engine.loadCircuit(this.currentDeck)
      this.deckLoaded = true
      this.emit({ type: 'benchRestarted', reason })
      await this.startTransientWindow(tstep, tstop, this.now(), pace)
    })
  }

  /**
   * A finite (non-continuous) transient reached its requested tstop on its own.
   * Flush the tail, emit a final status, and tear down the pacing loop without a
   * restart. `tran` is retained (marked finished) so stray ticks no-op.
   */
  private finalizeFiniteRun(): void {
    const flush = this.batcher.flush()
    if (flush) this.emit(flush.event, flush.transfer)
    this.reportStatus()
    this.halt.clear()
    this.stopPeriodicTimers()
  }

  private stopTransient(): void {
    void this.engine.command('bg_halt', false)
    this.halt.clear()
    this.tran = null
    this.stopPeriodicTimers()
    // Flush whatever remains so the renderer sees the tail.
    const flush = this.batcher.flush()
    if (flush) this.emit(flush.event, flush.transfer)
  }

  // ── convergence detection (Spec §7.4.6) ────────────────────────────────────

  private detectConvergence(text: string): void {
    // While the op retry ladder runs, ngspice's internal gmin/source-stepping
    // emits "no convergence"-style chatter even when it ultimately solves. The
    // ladder reports its own structured failure; don't double-report from
    // chatter — but DO record which fallbacks ngspice reached for, so the
    // opResult can carry an honest `method` (F1 trust fix).
    if (this.opInFlight) {
      this.trackOpChatter(text)
      return
    }
    for (const re of CONVERGENCE_PATTERNS) {
      if (re.test(text)) {
        this.emit({ type: 'convergenceFailure', detail: text.trim() })
        return
      }
    }
  }

  /**
   * Record ngspice's internal fallback narration during an op solve (verified
   * strings from ngspice 39–46: "gmin stepping completed/failed", "source
   * stepping completed/failed", "Supplies reduced to …%", and the OPTRAN
   * fallback's "Transient op started/finished successfully").
   */
  private trackOpChatter(text: string): void {
    if (/gmin\s+step/i.test(text)) this.opChatter.gminStepping = true
    if (/source\s+step/i.test(text) || /suppl(?:y|ies)\s+reduced/i.test(text)) {
      this.opChatter.sourceStepping = true
    }
    if (/transient\s+op\b/i.test(text) || /\boptran\b/i.test(text)) {
      this.opChatter.tranOp = true
    }
  }

  /**
   * The honest OpSolveMethod for an op that yielded values at ladder rung
   * `rung` (0 = plain op, 1 = gmin, 2 = source-step). ngspice runs its OWN
   * internal ladder inside a single `op`, so even rung 0 can secretly be a
   * fallback solve — the chatter flags take precedence over the rung index,
   * deepest fallback first.
   */
  private opMethodForRung(rung: number): OpSolveMethod {
    if (this.opChatter.tranOp) return 'tran-fallback'
    if (this.opChatter.sourceStepping || rung >= 2) return 'source'
    if (this.opChatter.gminStepping || rung >= 1) return 'gmin'
    return 'direct'
  }

  // ── loadCircuit ──────────────────────────────────────────────────────────

  private enqueueLoadCircuit(deckLines: string[]): void {
    this.enqueue('loadCircuit', async () => {
      if (this.deckLoaded) {
        await this.engine.command('destroy all', false) // Spec §7.4 gotcha 5
      }
      this.currentDeck = [...deckLines]
      this.engine.loadCircuit(this.currentDeck)
      this.deckLoaded = true
    })
  }

  // ── alter batching (Spec §7.4.3) ───────────────────────────────────────────

  /**
   * Queue an alter into the coalesce window. A knob drag fires many alters; we
   * batch them inside one bg_halt → alters → bg_resume so the bg thread isn't
   * thrashed (Spec §7.4.3). Device tokens are lowercased (gotcha 1).
   */
  private queueAlter(cmd: Extract<SimCommand, { type: 'alter' }>): void {
    this.pendingAlters.push(buildAlterCommand(cmd))
    if (this.alterTimer) return
    this.alterTimer = setTimeout(() => {
      this.alterTimer = null
      this.flushAlters()
    }, ALTER_COALESCE_MS)
    if (this.disableTimers && this.alterTimer.unref) this.alterTimer.unref()
  }

  /** Drain pending alters inside one halt/resume window, respecting haltOwner. */
  flushAlters(): void {
    if (this.pendingAlters.length === 0) return
    const alters = this.pendingAlters
    this.pendingAlters = []
    this.enqueue('alterBatch', async () => {
      // Halt, then WAIT for the bg thread to actually stop before applying alters.
      // bg_halt only requests the background thread to pause; an alter issued
      // before the thread has stopped races and is silently dropped (verified
      // against ngspice 46 — the alter must land while the engine is halted).
      const tookHalt = this.halt.requestHalt('alter')
      const wasRunning = tookHalt
      if (wasRunning) await this.waitForHalt()
      for (const a of alters) {
        await this.engine.command(a, false)
      }
      // If the user paused, we keep their pause (a non-owner resume is a no-op in
      // the coordinator); otherwise the alter batch resumes the run.
      if (tookHalt) {
        this.halt.requestResume('alter')
      }
    })
  }

  /**
   * Wait (bounded) until ngspice's background thread reports stopped after a
   * bg_halt. Returns promptly once `ngSpice_running()` is false. Bounded by the
   * watchdog window so a wedged engine still gets caught.
   */
  private async waitForHalt(timeoutMs = 2000): Promise<void> {
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      if (!this.engine.isRunning()) return
      this.noteProgress() // polling counts as progress for the watchdog
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  // ── haltOwner accessors (tests) ────────────────────────────────────────────

  getHaltOwner(): import('./haltCoordinator').HaltOwner {
    return this.halt.getOwner()
  }

  // ── queue + watchdog ────────────────────────────────────────────────────

  private enqueue(label: string, run: () => Promise<void>): void {
    this.queue.push({ label, run })
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = true
    setImmediate(() => void this.drain()) // never from an FFI callback (gotcha 2)
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
    this.lastProgress = this.now()
  }

  private startWatchdog(): void {
    if (this.disableWatchdog || this.watchdogTimer) return
    this.lastProgress = this.now()
    this.watchdogTimer = setInterval(() => {
      if (this.now() - this.lastProgress > WATCHDOG_MS) {
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

  // ── periodic pacing/flush + status timers ──────────────────────────────────

  private startPeriodicTimers(): void {
    if (this.disableTimers || this.pacingTimer) return
    this.pacingTimer = setInterval(() => this.pacingTick(), PACING_INTERVAL_MS)
    if (typeof this.pacingTimer.unref === 'function') this.pacingTimer.unref()
  }

  private stopPeriodicTimers(): void {
    if (this.pacingTimer) {
      clearInterval(this.pacingTimer)
      this.pacingTimer = null
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
  }

  // ── startup smoke check (Spec §7.2) ────────────────────────────────────────

  /**
   * Load + run the XSPICE adc_bridge→d_inverter→dac_bridge deck once at init.
   * Pass = final v(out) ≥ 4.5 (proves the `.cm` code models loaded).
   *
   * NOTE (verified against ngspice 46): the inverter code model is `d_inverter`,
   * not `d_inv` — `d_inv` does not exist in ngspice's digital.cm.
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

  /** For integration/unit tests: true while a bench window is active. */
  isTransientActive(): boolean {
    return this.tran !== null
  }
}

// ─── helpers (pure, exported for unit tests) ──────────────────────────────────

/**
 * Build the ngspice `alter` command string from a SimCommand (Spec §7.4.1, §9).
 * Device tokens are lowercased (gotcha 1). Function-gen SIN/PULSE param changes
 * use the vector form with EXACT spacing: `alter @vfgen_2[sin] [ <vo> <va> <freq> ]`.
 *
 * Conventions on the `param` field:
 *  - param undefined           → `alter <dev> = <value>`         (e.g. dc-supply via a value)
 *  - param a plain token       → `alter <dev> <param> = <value>` (e.g. `dc`, `acmag`)
 *  - value is a space-joined   → vector form, when device already names the
 *    list of numbers AND param  parameter vector (@dev[sin]); detected by `[` in device.
 *    is the vector tag
 */
export function buildAlterCommand(cmd: Extract<SimCommand, { type: 'alter' }>): string {
  const device = cmd.device.toLowerCase()
  // Vector form for SIN/PULSE: caller passes device already like "@vfgen_2[sin]"
  // and value as a space-separated number string; we wrap with exact spacing.
  if (/\[(sin|pulse|sine|exp|pwl)\]$/.test(device)) {
    return `alter ${device} [ ${String(cmd.value)} ]`
  }
  if (cmd.param !== undefined) {
    return `alter ${device} ${cmd.param} = ${cmd.value}`
  }
  return `alter ${device} = ${cmd.value}`
}

/**
 * Format a number for an ngspice `bg_tran` token. ngspice's command parser
 * accepts both plain-decimal and e-notation for tran step/stop (verified against
 * ngspice 46 — e.g. `bg_tran 1e-5 30`), and crucially it must NEVER carry a
 * letter suffix (a bare `1e-5`, not `10u`). JS `Number.prototype.toString`
 * already chooses a compact, suffix-free form, so we use it directly.
 */
export function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return String(n)
}

// ─── MessagePort wiring (runs only inside the utilityProcess) ─────────────────

/**
 * Bootstrap SimHost when launched as an Electron utilityProcess.
 *
 * The renderer↔SimHost link is a direct MessageChannel: Main creates the channel,
 * keeps Main OUT of the steady-state path (Spec §6), and delivers one end to this
 * child via `child.postMessage({type:'port'}, [port1])`. That port arrives on
 * `process.parentPort`'s first message as `e.ports[0]` — we must wire SimHost to
 * THAT port, not to parentPort itself (parentPort connects child↔Main, and Main
 * does not relay SimCommands). Guarded so importing this module from tests does
 * NOT spin up a real engine.
 */
function bootstrapUtilityProcess(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parentPort = (process as any).parentPort
  if (!parentPort) return // not running as a utilityProcess (e.g. unit tests)

  // The comm port (port1) arrives with the first parentPort message. Everything
  // else (SimCommands, SimEvents) flows over that port, directly to the renderer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parentPort.once('message', (e: any) => {
    const port = e?.ports?.[0]
    if (!port) return

    if (!ngspiceResourcesAvailable()) {
      port.start()
      try {
        port.postMessage({
          type: 'log',
          level: 'error',
          text: 'ngspice resources not found for this platform'
        } satisfies SimEvent)
      } catch {
        /* ignore */
      }
      return
    }

    // Buffer commands that arrive BEFORE host.start() finishes the startup smoke
    // check. handleCommand only enqueues (it doesn't run ngspice synchronously),
    // so a command received mid-startup would otherwise be enqueued and could
    // drain concurrently with the smoke check's engine calls (a re-entrant FFI
    // race). We gate intake until start() resolves, then flush in arrival order.
    let started = false
    const pending: SimCommand[] = []

    const host = new SimHost({
      emit: (ev: SimEvent) => {
        try {
          // Electron's MessagePortMain.postMessage clones the message (ArrayBuffers
          // included) — no explicit transfer list is needed or supported for
          // buffers here, so we send the event as-is.
          port.postMessage(ev)
        } catch {
          /* port may have closed during shutdown */
        }
      }
    })

    const dispatch = (cmd: SimCommand): void => {
      try {
        host.handleCommand(cmd)
      } catch (err) {
        try {
          port.postMessage({
            type: 'log',
            level: 'error',
            text: `handleCommand error: ${(err as Error).message}`
          } satisfies SimEvent)
        } catch {
          /* ignore */
        }
      }
    }

    // CRITICAL (Electron MessagePortMain): register the 'message' listener BEFORE
    // start(). start() flushes any already-queued messages synchronously; a
    // listener attached after start() misses everything delivered in between
    // (this dropped renderer→SimHost commands intermittently). Listen, then start.
    port.on('message', (msg: { data: SimCommand }) => {
      const cmd = msg?.data
      if (!cmd) return
      if (started) dispatch(cmd)
      else pending.push(cmd)
    })
    port.start()

    host
      .start()
      .then(() => {
        started = true
        for (const cmd of pending) dispatch(cmd)
        pending.length = 0
      })
      .catch((err) => {
        // Even on a failed start, flush so the renderer isn't left hanging — the
        // commands will surface their own errors via the queue's error path.
        started = true
        for (const cmd of pending) dispatch(cmd)
        pending.length = 0
        try {
          port.postMessage({
            type: 'log',
            level: 'error',
            text: `SimHost start failed: ${(err as Error).message}`
          } satisfies SimEvent)
        } catch {
          /* ignore */
        }
      })
  })
}

bootstrapUtilityProcess()
