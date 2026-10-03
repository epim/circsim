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
 *  - runTransient via `bg_tran <tstep> <tstop> uic`; samples are READ from the
 *    plot vectors every 16 ms (no per-timepoint callback, issue #25) → `samples`
 *  - bounded bench windows: tstop = W (default 30 s), shorter when one window's
 *    samples would exceed TRAN_MEMORY_BUDGET_BYTES; on window end OR RSS>1.5 GB,
 *    halt → destroy all → reload → restart at t=0 → emit `benchRestarted` (Spec §7.5)
 *  - `set no_mem_check` at start: SimHost, not ngspice's free-memory check, sizes runs
 *  - pacing: 50 ms loop holding realtimeFactor ≈ 1 (or 'max'); report achieved
 *    factor every 250 ms (Spec §7.5); the 16 ms sample tick runs on its own timer
 *  - alter batching: bg_halt → alters → bg_resume, 30 ms coalesce window (Spec §7.4.3)
 *  - convergence pattern-match on SendChar text → convergenceFailure (Spec §7.4.6)
 *  - the XSPICE `.cm` startup smoke deck (Spec §7.2)
 */

import { DeckRejectedError, sanitizeDeck } from '../core/spicegen/sanitize'
import { HaltCoordinator } from './haltCoordinator'
import { NgspiceFfiEngine, ngspiceResourcesAvailable } from './ngspiceFfi'
import { transientMaxStep } from '../core/spicegen/transientStep'
import type { EngineEvent, SpiceEngine } from './engine'
import {
  isScaleVectorName,
  normalizeVectorKey,
  type LatestSnapshot,
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
/**
 * The most one transient's saved samples may take. At its first saved point
 * ngspice-46 allocates room for the whole run: `tstop/tstep + 100` doubles for
 * every saved vector (outitf.c vlength2delta), and an allocation it cannot make
 * ends in a ControlledExit. SimHost does that sum before it starts a run and
 * keeps it within this budget: the bench shortens its window (and restarts at
 * the shorter boundary), runTran refuses. The budget is the RSS guard's: a
 * window whose samples outgrow it would be cut by the guard before its end
 * anyway. The default bench on the 555 sample (26 vectors, 10 us over 30 s) is
 * 624 MB; at the 5 us a 1 kHz function generator sets, 1.25 GB. Both fit.
 */
export const TRAN_MEMORY_BUDGET_BYTES = RSS_GUARD_BYTES
/**
 * Turns off ngspice-46's own memory check, sent once at start. At every saved
 * point (outitf.c OUTpD_memory) ngspice compares the up-front size above with
 * the free memory the OS reports at that moment; above it, it prints "Error:
 * memory required ... is more than memory available" and ControlledExits,
 * which leaves the shared library unusable until it is reset. On macOS "free"
 * is vm_stat free_count alone (get_avail_mem_size.c), without the inactive and
 * purgeable pages the OS hands back on demand, so it is often tens of MB on a
 * busy machine: the check refused a 58 MB transient on the macOS CI runners, and
 * it refuses the default bench (624 MB) whenever free_count is lower. A run that
 * passes at its start can also fail mid-way when free memory dips.
 * TRAN_MEMORY_BUDGET_BYTES bounds every run instead, the same way on every OS.
 */
const NGSPICE_NO_MEM_CHECK = 'set no_mem_check'
/** A memory-bound window is never shorter than this many steps. */
const TRAN_MIN_WINDOW_POINTS = 1000
/** Pacing loop interval (Spec §7.5). */
const PACING_INTERVAL_MS = 50
/** Achieved-factor status report cadence (Spec §7.5). */
const STATUS_REPORT_MS = 250
/** Alter coalesce window so a knob drag batches into one halt/resume (Spec §7.4.3). */
const ALTER_COALESCE_MS = 30
/**
 * Sample tick (Spec §6.1, issue #78): how often new plot points are read and
 * flushed to the renderer. Its own timer, NOT the 50 ms pacing tick. 15 rather
 * than 16 on purpose: the Windows timer grid is 15.6 ms, so a 16 ms interval
 * lands on every second grid point (31 ms, measured) while 15 ms lands on every
 * one (15.6 ms), keeping the documented "flushed within 16 ms".
 */
const SAMPLE_INTERVAL_MS = 15
/** Cadence of the `latest` snapshot of unwatched vectors (the copper tint and LED glow rate). */
const BULK_INTERVAL_MS = 33
/** Most plot points one `samples` batch carries (Spec §6.1: 4096 points). */
const MAX_ROWS_PER_BATCH = 4096
/**
 * Least time a started or resumed background run is left alone before the next
 * bg_halt. A thread halted while it is still starting up (a pause, an alter
 * batch or a pacing halt right behind a bg_resume or bg_tran) never settles:
 * ngspice either hangs in bg_halt (seconds, observed 6 s) or crashes on the
 * resume after it. With the first run each bg_tran also waits for the run's
 * SendInitData, the signal that the thread is going.
 */
const MIN_RUN_AFTER_START_MS = 50
/**
 * Settle time between a completed bg_halt and the next bg_resume. bg_halt
 * returns once ngspice's running flag drops, which is a little BEFORE the
 * background thread has finished unwinding; a bg_resume issued straight away
 * starts the next thread on top of the dying one and crashes ngspice (a
 * segfault in a few percent to most halt/resume cycles once the simulation is
 * fast, measured with a 10 us RC deck; at 100 ms and more it did not occur in
 * 20 runs). Slow simulations never hit it, which is why it only shows now.
 */
const RESUME_GAP_MS = 120
/** Longest the sample tick waits for a bg_resume to announce itself (SendInitData) before reading again. */
const RESUME_SETTLE_MAX_MS = 500
/** Back-to-back batches one tick may emit to catch up when the plot is far ahead. */
const MAX_BATCHES_PER_TICK = 8
/**
 * Real-time pacing holds the SIM back only to bound how far it runs ahead of
 * what has been delivered: pacing halts the background thread once the plot is
 * this many wall-seconds ahead, and releases it below the low mark. (A halt
 * takes ngspice about 100 ms to complete, so halting at every tick could not
 * pace smoothly; instead the points are RELEASED to the renderer on the wall
 * clock, see pollSamples.) A knob turned now lands in the sim at the head of
 * the plot, so this lead is also the latency before the board shows it.
 */
const PACING_LEAD_HIGH_S = 0.3
const PACING_LEAD_LOW_S = 0.15

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
  /** False for the commands in CHAIN_ONLY_COMMANDS. */
  touchesPlot: boolean
}

/**
 * Queue items that reach ngspice only through engineChain (a halt, a resume,
 * an alter batch, a stop) or not at all, and never rebuild or replace the
 * plot. Every other item (a reload, an op, a foreground tran, a run start, a
 * bench restart) sends commands to ngspice directly: it waits for the halts,
 * resumes and alters already ordered on engineChain before it runs, and the
 * sample tick does not read while it is queued or running.
 */
const CHAIN_ONLY_COMMANDS = new Set(['alterBatch', 'halt', 'resume', 'stop', 'setPace', 'watch'])

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
  /** Settle time between a completed bg_halt and the next bg_resume, ms (see runResume). */
  resumeGapMs?: number
  /** Memory budget for one transient's saved samples (tests). Default TRAN_MEMORY_BUDGET_BYTES. */
  tranMemoryBudgetBytes?: number
}

/**
 * The memory ngspice-46 allocates up front for a transient that saves
 * `vectorCount` vectors (the scale included): `vectors x (ceil(tstop/tstep) +
 * 100) x 8 B`.
 */
export function ngspiceTranMemoryBytes(vectorCount: number, tstep: number, tstop: number): number {
  return vectorCount * (Math.ceil(tstop / tstep) + 100) * 8
}

/**
 * The longest stop at or below `tstop` whose estimate stays within
 * `budgetBytes`, but never fewer than TRAN_MIN_WINDOW_POINTS steps.
 */
export function fitTranStop(vectorCount: number, tstep: number, tstop: number, budgetBytes: number): number {
  const points = Math.floor(budgetBytes / (vectorCount * 8)) - 101
  // 12 digits keep the stop a clean token for the command line; the 101 above leaves room for the rounding.
  return Math.min(tstop, Number((Math.max(points, TRAN_MIN_WINDOW_POINTS) * tstep).toPrecision(12)))
}

export class SimHost {
  private engine: SpiceEngine
  private closing = false
  private transientGeneration = 0
  private readonly emit: (ev: SimEvent, transfer?: ArrayBuffer[]) => void
  private readonly disableWatchdog: boolean
  private readonly disableTimers: boolean
  private readonly benchWindowSeconds: number
  private readonly rssBytes: () => number
  private readonly now: () => number
  private readonly tranMemoryBudgetBytes: number

  /**
   * Vectors (scale included) a transient of the loaded deck saves, counted by
   * a few-step probe run; 0 until known or when the probe could not tell.
   * Reset when a deck is loaded.
   */
  private vectorCount = 0
  /** The last memory-bound window already logged, so a restart does not repeat it. */
  private clampNoted = ''

  private queue: QueueItem[] = []
  private draining = false
  /** Queued or running items that may rebuild the plot (sampleTick does not read meanwhile). */
  private plotItems = 0
  private watchdogTimer: NodeJS.Timeout | null = null
  private lastProgress = Date.now()

  private currentDeck: string[] = []
  private deckLoaded = false
  private engineNeedsReset = false
  private failedLoad: string | null = null

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

  /** Transient sampling state (null until SendInitData says the plot exists). */
  private sampler: {
    /** The scale vector of the run, e.g. "time". */
    scale: string
    /** Every other vector of the run, in ngspice's order. */
    names: string[]
    /** Plot points already delivered (index of the next point to read). */
    cursor: number
    /** this.now() of the last `latest` snapshot (-Infinity: none yet). */
    lastBulkAt: number
    /** Plot index of the point the last `latest` snapshot was read at (-1: none yet). */
    bulkRow: number
    /** watchVersion the two lists below were resolved against. */
    watchVersion: number
    /** Names delivered as full series, and the rest as `latest` values. */
    watched: string[]
    bulk: string[]
  } | null = null
  /**
   * Lower-cased vector names the renderer wants as full series (the `watch`
   * command); null means every vector (the default until the first `watch`).
   */
  private watch: Set<string> | null = null
  private watchVersion = 0
  /** The pace the next run starts at (the last setPace; 1x until one arrives). */
  private paceSetting: number | 'max' = 1
  /**
   * this.now() of the last bg_resume while its SendInitData has not arrived yet
   * (null: none pending). A resume starts ngspice's thread afresh, which
   * re-initializes the analysis (it announces itself with SendInitData), and
   * the plot must not be read until that has happened.
   */
  private bgSettlingSince: number | null = null
  /** A thread started while bgSettlingSince was set has reported itself running. */
  private settlingThreadUp = false
  /**
   * The background run of this window is over by itself: it reached its stop
   * time or ngspice gave up on it. Nothing is left to resume, and a bg_resume
   * would only make ngspice try a fresh `run` ("run simulation not started")
   * that never announces itself.
   */
  private runEnded = false
  /** A bg_halt was issued since the thread was last started or resumed. */
  private haltedSinceStart = false
  /** this.now() when the background thread was last started (bg_tran) or resumed. */
  private lastBgStartAt = -Infinity
  private readonly resumeGapMs: number
  /** Serializes the bg_halt / bg_resume commands the halt coordinator asks for. */
  private engineChain: Promise<void> = Promise.resolve()
  /** this.now() when the last bg_halt command completed. */
  private haltDoneAt = -Infinity
  /** bg_halt / bg_resume commands queued or running on engineChain. */
  private chainPending = 0
  private vectorsEmitted = false

  /** Active transient run parameters (null when not running a tran). */
  private tran: {
    tstep: number
    tstop: number
    /** sim-time of the newest point DELIVERED to the renderer this window. */
    simTime: number
    /** sim-time of the newest point ngspice has computed (>= simTime under pacing). */
    head: number
    /**
     * Pacing anchor: the delivered sim-time `sim` at wall-clock `wall` (ms).
     * Points are released while their time <= sim + (now - wall) * pace, so a
     * pause, a pace change or a slow stretch never builds a debt that would
     * later be repaid as a burst.
     */
    anchor: { wall: number; sim: number }
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
  /**
   * An alter batch is ordered and has not applied its alters yet: it takes
   * every alter pending when it gets to them, so no new batch is needed.
   */
  private alterStepPending = false

  /** Periodic timers (pacing + status report, and the separate sample tick). */
  private pacingTimer: NodeJS.Timeout | null = null
  private sampleTimer: NodeJS.Timeout | null = null
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
    this.tranMemoryBudgetBytes = opts.tranMemoryBudgetBytes ?? TRAN_MEMORY_BUDGET_BYTES

    this.resumeGapMs = opts.resumeGapMs ?? RESUME_GAP_MS

    // The coordinator flips its state synchronously; the matching ngspice
    // commands run strictly in request order on engineChain, and a resume
    // waits for the old thread to be gone (see runResume).
    this.halt = new HaltCoordinator({
      halt: () => {
        void this.chain(() => this.runHalt())
      },
      resume: () => {
        void this.chain(() => this.runResume())
      }
    })

    // Wire the engine event stream now (registration only — no init required), so
    // unit tests that drive a stub engine without start() still receive char/stat/
    // initData events.
    this.engineUnsub = this.engine.on((ev: EngineEvent) => this.onEngineEvent(ev))
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Initialize the engine, run the startup smoke check. */
  async start(): Promise<void> {
    this.engine.init()
    // Before any analysis: SimHost sizes every transient itself (see NGSPICE_NO_MEM_CHECK).
    await this.engine.command(NGSPICE_NO_MEM_CHECK, false)
    this.emit({ type: 'ready', ngspiceVersion: this.engine.version })
    await this.runStartupSmokeCheck()
  }

  /**
   * Handle one EngineEvent. Runs on the FFI callback frame for char/stat/
   * initData — must stay cheap and never call back into ngspice (Spec §7.4 #2).
   * Samples are not delivered here: the sample tick reads them from the plot
   * once initData has said the plot exists.
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
        this.engineNeedsReset = true
        this.emit({
          type: 'log',
          level: 'error',
          text: `ngspice ControlledExit status=${ev.status} immediate=${ev.immediate}`
        })
        break
      case 'bgRunning':
        this.bgThreadRunning = ev.running
        if (ev.running) {
          this.bgEverRan = true
          if (this.bgSettlingSince !== null) this.settlingThreadUp = true
        } else if (this.bgSettlingSince !== null && this.settlingThreadUp) {
          // The thread a bg_tran / bg_resume started has ended without
          // announcing a plot: ngspice had nothing to run (a resume after the
          // run completed or failed answers "run simulation not started").
          // No announcement is coming, so stop waiting for one, and resume
          // nothing more in this window.
          this.bgSettlingSince = null
          this.settlingThreadUp = false
          if (this.tran) this.runEnded = true
        }
        this.noteProgress()
        break
      case 'initData':
        // ngspice repeats SendInitData on every bg_resume (an alter batch, a
        // pacing halt) although the run continues in the SAME plot: only the
        // first one after the run starts (sampler still null) opens a plot.
        // Restarting the read cursor on a resume would replay the whole history.
        this.bgSettlingSince = null
        this.settlingThreadUp = false
        if (this.tran && !this.sampler) {
          const scale = ev.names.find(isScaleVectorName) ?? 'time'
          const names = ev.names.filter((n) => n !== scale)
          this.sampler = {
            scale,
            names,
            cursor: 0,
            lastBulkAt: -Infinity,
            bulkRow: -1,
            watchVersion: -1,
            watched: [],
            bulk: []
          }
          if (!this.vectorsEmitted) {
            this.emit({ type: 'vectors', names })
            this.vectorsEmitted = true
          }
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
    this.closing = true
    this.stopWatchdog()
    this.stopPeriodicTimers()
    if (this.alterTimer) {
      clearTimeout(this.alterTimer)
      this.alterTimer = null
    }
    this.tran = null
    try {
      // A queued window restart can still be awaiting its native command.
      // Drain the command queue as well as the halt/resume chain before unload.
      await this.whenIdle()
      // Let the halt / resume commands already ordered finish first: a bg_halt
      // issued here while one of them is mid-flight (a bg_resume still starting
      // its thread) is the teardown crash seen under load (ngspice dies in the
      // worker after the file's tests passed). A queued resume sees tran gone
      // and skips itself.
      await this.engineChain
      await this.waitBgSettled()
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
    if (this.closing) return
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
          // The time spent paused must not be repaid as a burst.
          this.reanchorPacing()
          this.halt.requestResume('user')
        })
        break
      case 'stop':
        this.enqueue('stop', () => this.stopTransient())
        break
      case 'setPace':
        this.enqueue('setPace', async () => {
          // Remembered even with no run active: the app sends setPace BEFORE
          // runTransient, and the run must start at the pace the user chose.
          this.paceSetting = cmd.realtimeFactor
          if (this.tran) {
            this.tran.pace = cmd.realtimeFactor
            this.reanchorPacing()
          }
        })
        break
      case 'watch':
        this.enqueue('watch', async () => {
          this.watch = new Set(cmd.vectors.map((v) => v.toLowerCase()))
          this.watchVersion++
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
    if (this.failedLoad !== null) {
      this.emit({ type: 'opResult', values: {}, method: 'failed' })
      return {}
    }
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
          const method = this.opMethodForRung(rung)
          if (method !== 'direct') this.engineNeedsReset = true
          this.emit({ type: 'opResult', values: lastValues, method })
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
    this.engineNeedsReset = true
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
    pace: number | 'max' = this.paceSetting
  ): Promise<void> {
    if (this.closing) return
    if (this.failedLoad !== null) {
      this.emit({ type: 'convergenceFailure', detail: `Circuit was not loaded: ${this.failedLoad}` })
      this.emit({ type: 'status', running: false, simTimeSeconds: 0, realtimeFactor: 0 })
      return
    }
    this.transientGeneration++
    tstep = transientMaxStep(tstep, this.currentDeck)
    // Bench window: the effective tstop is the smaller of the request and W,
    // and of the longest stop whose samples fit TRAN_MEMORY_BUDGET_BYTES. When
    // the request exceeds the window the run is "continuous" and restarts at the
    // window boundary, as the RSS guard already does for a window that outgrows
    // memory; otherwise it is a finite run that completes at windowStop.
    const windowStop = await this.memoryBoundStop(tstep, Math.min(tstop, this.benchWindowSeconds))
    if (this.closing) return
    const continuous = tstop > windowStop

    // No sampling until this run's SendInitData arrives: the previous plot
    // (or none) is not the one bg_tran is about to create, and reading a plot
    // that is being built or torn down is unsafe.
    this.sampler = null
    this.vectorsEmitted = false
    this.halt.clear()
    this.runEnded = false
    this.haltedSinceStart = false
    this.settlingThreadUp = false

    this.tran = {
      tstep,
      tstop,
      simTime: 0,
      head: 0,
      anchor: { wall: wallNow, sim: 0 },
      windowStartWall: wallNow,
      windowStop,
      continuous,
      finished: false,
      pace
    }

    // bg_tran returns immediately (background thread) — non-blocking is correct.
    this.bgSettlingSince = this.lastBgStartAt = this.now()
    await this.engine.command(`bg_tran ${formatNum(tstep)} ${formatNum(windowStop)} uic`, false)

    this.lastStatusAt = wallNow
    this.startPeriodicTimers()
  }

  /**
   * One sample tick (Spec §6.1, issue #78): read the plot points added since
   * the last tick and emit them as `samples` batches. Runs on its own 16 ms
   * timer, so the renderer sees samples at the documented cadence whatever the
   * 50 ms pacing tick is doing. Public so unit tests can step it.
   */
  sampleTick(): void {
    // A queue item (loadCircuit's `destroy all`, an op, a bench restart) may be
    // rebuilding the plot on another thread, and a bg_resume is still starting
    // the simulation thread: never read while either is in progress. (An alter
    // batch does neither: reads go on through a knob drag.)
    if (!this.tran || !this.sampler || this.plotItems > 0) return
    if (this.bgSettlingSince !== null) {
      // Bounded: a resume that never announces itself (nothing left to run)
      // must not silence the stream for good.
      if (this.now() - this.bgSettlingSince < RESUME_SETTLE_MAX_MS) return
      this.bgSettlingSince = null
    }
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      if (this.pollSamples(false) < MAX_ROWS_PER_BATCH) break
    }
  }

  /**
   * Emit everything still unread, however much there is, ignoring pacing (a
   * run's tail before it finishes, restarts or stops). Callers are the
   * end-of-run paths, which are not rebuilding the plot, so unlike sampleTick
   * there is no queue check.
   */
  private drainSamples(): void {
    if (!this.tran || !this.sampler) return
    // Always refresh the snapshot: the last point of the run is what the tint settles on.
    this.sampler.lastBulkAt = -Infinity
    while (this.pollSamples(true) >= MAX_ROWS_PER_BATCH) {
      /* keep reading while full batches come back */
    }
    this.emitFinalSnapshot()
  }

  /**
   * Restart the pacing clock from the delivered sim-time, now. Called when the
   * pace changes or the user resumes, so the new rate applies from here.
   */
  private reanchorPacing(): void {
    if (this.tran) this.tran.anchor = { wall: this.now(), sim: this.tran.simTime }
  }

  /**
   * Read the new points from the plot and emit one `samples` event: full series
   * for the watched vectors, and (when due) the values of every other vector at
   * the newest delivered point. Returns the number of points delivered (0:
   * nothing emitted).
   *
   * Pacing (`all` false, pace not 'max'): ngspice may run ahead of real time, but
   * points are delivered only up to the pacing clock, so the renderer sees a
   * steady stream at `pace` x real time however bursty the simulation is. While
   * the user has paused, nothing is delivered. `all` ignores both (see
   * drainSamples).
   *
   * The reads happen under ngSpice_LockRealloc so the background thread cannot
   * move a vector while it is copied. Points are only taken up to the shortest
   * watched vector, since ngspice appends the vectors of one timepoint one after
   * the other and a read can land between two of them.
   */
  private pollSamples(all: boolean): number {
    const t = this.tran
    const s = this.sampler
    if (!t || !s) return 0
    const paced = !all && t.pace !== 'max'
    if (paced && this.halt.isUserPaused()) return 0
    this.resolveWatched(s)

    const engine = this.engine
    const now = this.now()
    let simTime: Float64Array
    let columns: Float64Array[]
    let latest: LatestSnapshot | undefined
    let rows: number
    let behind = false
    engine.lockVectors()
    try {
      const headRead = engine.readVector(s.scale, -1, 1)
      if (!headRead) return 0
      if (headRead.length < s.cursor) {
        // The plot is shorter than what was already delivered: ngspice started
        // a new one under the same run. Read it from its beginning.
        s.cursor = 0
        s.bulkRow = -1
      }
      if (Number.isFinite(headRead.data[0])) t.head = headRead.data[0]
      const available = headRead.length - s.cursor
      if (available <= 0) return 0
      const time = engine.readVector(s.scale, s.cursor, Math.min(available, MAX_ROWS_PER_BATCH))
      if (!time || time.data.length === 0) return 0
      rows = time.data.length
      if (paced) {
        const limit = t.anchor.sim + ((now - t.anchor.wall) / 1000) * (t.pace as number)
        rows = countAtMost(time.data, rows, limit)
        // Everything computed so far is already due: the sim is the slow side.
        behind = rows === available
        if (rows === 0) return 0
      }
      const reads = s.watched.map((name) => engine.readVector(name, s.cursor, rows))
      for (const r of reads) if (r) rows = Math.min(rows, r.data.length)
      if (rows === 0) return 0
      simTime = rows === time.data.length ? time.data : time.data.slice(0, rows)
      columns = reads.map((r) => {
        if (!r) return new Float64Array(rows).fill(NaN) // unreadable vector: NaN, like a missing value
        return r.data.length === rows ? r.data : r.data.slice(0, rows)
      })
      if (s.bulk.length > 0 && now - s.lastBulkAt >= BULK_INTERVAL_MS) {
        // Each unwatched vector at the newest DELIVERED point, so the tint and
        // the scope trace show the same instant.
        latest = this.readLatest(s, s.cursor + rows - 1)
        s.lastBulkAt = now
        s.bulkRow = s.cursor + rows - 1
      }
    } finally {
      engine.unlockVectors()
    }

    s.cursor += rows
    const last = simTime[rows - 1]
    if (Number.isFinite(last)) {
      t.simTime = last
      // Behind real time: restart the pacing clock here, so catching up later
      // never releases a burst.
      if (behind) t.anchor = { wall: now, sim: last }
    }
    this.noteProgress()
    const transfer: ArrayBuffer[] = [simTime.buffer as ArrayBuffer, ...columns.map((c) => c.buffer as ArrayBuffer)]
    if (latest) transfer.push(latest.values.buffer as ArrayBuffer)
    this.emit(
      { type: 'samples', vectorNames: s.watched, columns, simTime, ...(latest ? { latest } : {}) },
      transfer
    )
    return rows
  }

  /** The unwatched vectors at plot point `at`; the caller holds the vector lock. */
  private readLatest(s: NonNullable<SimHost['sampler']>, at: number): LatestSnapshot {
    const values = new Float64Array(s.bulk.length)
    for (let i = 0; i < s.bulk.length; i++) {
      const r = this.engine.readVector(s.bulk[i], at, 1) ?? this.engine.readVector(s.bulk[i], -1, 1)
      values[i] = r && r.data.length > 0 ? r.data[0] : NaN
    }
    return { vectorNames: s.bulk, values }
  }

  /**
   * End of a run: when the last snapshot is older than the last delivered
   * point, take one now and emit it as a batch of zero rows (issue #157). The
   * ticks that delivered the run's final rows can fall inside the snapshot
   * interval, and the drain that follows then finds no new rows to carry one.
   */
  private emitFinalSnapshot(): void {
    const s = this.sampler
    if (!this.tran || !s) return
    this.resolveWatched(s)
    if (s.bulk.length === 0 || s.cursor === 0 || s.bulkRow >= s.cursor - 1) return
    let latest: LatestSnapshot
    this.engine.lockVectors()
    try {
      latest = this.readLatest(s, s.cursor - 1)
    } finally {
      this.engine.unlockVectors()
    }
    s.lastBulkAt = this.now()
    s.bulkRow = s.cursor - 1
    this.emit(
      { type: 'samples', vectorNames: s.watched, columns: s.watched.map(() => new Float64Array(0)), simTime: new Float64Array(0), latest },
      [latest.values.buffer as ArrayBuffer]
    )
  }

  /** Split the run's vectors into watched (full series) and bulk (latest only). */
  private resolveWatched(s: NonNullable<SimHost['sampler']>): void {
    if (s.watchVersion === this.watchVersion) return
    s.watchVersion = this.watchVersion
    if (this.watch === null) {
      s.watched = s.names
      s.bulk = []
      return
    }
    const watch = this.watch
    s.watched = s.names.filter((n) => watch.has(n.toLowerCase()))
    s.bulk = s.names.filter((n) => !watch.has(n.toLowerCase()))
  }

  /**
   * Count the vectors a transient of the loaded deck saves (the scale
   * included) by running a few steps of it, once per deck load. 0 when it
   * cannot be told (the probe failed, or the engine saved nothing).
   */
  private async countTranVectors(tstep: number): Promise<number> {
    if (this.vectorCount > 0) return this.vectorCount
    // The probe's data callbacks must not reach a run that is being replaced.
    const live = this.tran
    this.tran = null
    try {
      await this.engine.command(`tran ${formatNum(tstep)} ${formatNum(Number((tstep * 3).toPrecision(12)))} uic`, true)
      this.vectorCount = this.engine.allVectors(this.engine.currentPlot()).length
    } catch {
      this.vectorCount = 0
    } finally {
      this.tran = live
    }
    return this.vectorCount
  }

  /**
   * `tstop`, or the longest stop below it whose samples fit
   * TRAN_MEMORY_BUDGET_BYTES for this deck. The bench restarts at each window
   * boundary anyway, so a shorter window costs only more restarts.
   */
  private async memoryBoundStop(tstep: number, tstop: number): Promise<number> {
    const budget = this.tranMemoryBudgetBytes
    const vectors = await this.countTranVectors(tstep)
    if (vectors === 0) return tstop
    const stop = fitTranStop(vectors, tstep, tstop, budget)
    if (stop < tstop) {
      const note = `${tstep}:${stop}`
      if (note !== this.clampNoted) {
        this.clampNoted = note
        this.emit({
          type: 'log',
          level: 'warn',
          text:
            `Transient windows are limited to ${formatNum(stop)} s: ${vectors} saved vectors at ${formatNum(tstep)} s steps ` +
            `over ${formatNum(tstop)} s would need ${Math.round(ngspiceTranMemoryBytes(vectors, tstep, tstop) / 1048576)} MB, ` +
            `over the ${Math.round(budget / 1048576)} MB budget.`
        })
      }
    }
    return stop
  }

  /**
   * One pacing tick (Spec §7.5). Drives: real-time pacing (halt/resume to hold
   * realtimeFactor), bench-window restart on window end or RSS guard, and the
   * periodic achieved-factor status report. Sample flushing is the separate
   * sampleTick.
   *
   * Public + parameterless-by-clock so unit tests can step it deterministically.
   */
  pacingTick(): void {
    if (!this.tran) return
    const t = this.tran

    // (2) Bench-window handling (§7.5).
    //   - RSS guard always forces a restart of the (continuous) window.
    //   - Reaching windowStop: restart for a continuous run; for a finite run it
    //     simply means the requested transient has completed → finalize.
    const memoryHit = this.rssBytes() > RSS_GUARD_BYTES
    const windowHit = t.simTime >= t.windowStop && t.windowStop > 0
    if (memoryHit) {
      this.drainSamples()
      void this.restartBenchWindow('memory')
      return
    }
    if (windowHit) {
      if (t.continuous) {
        this.drainSamples()
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

    // (3) Real-time pacing. Points are released to the renderer on the wall
    // clock by pollSamples; here the sim is only held back (halt, owner 'pacing')
    // while it is more than PACING_LEAD_HIGH_S of wall time ahead of what has
    // been delivered, and let go again below PACING_LEAD_LOW_S. A user pause
    // outranks all of it.
    if (!this.halt.isUserPaused() && t.pace !== 'max') {
      const leadWallS = (t.head - t.simTime) / t.pace
      if (leadWallS > PACING_LEAD_HIGH_S) {
        this.halt.requestHalt('pacing')
      } else if (leadWallS < PACING_LEAD_LOW_S && this.halt.getOwner() === 'pacing') {
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

  /**
   * Whether the run is live from the user's side, which is what `status.running`
   * tells the renderer (it maps false to Paused). Not the raw ngspice thread
   * flag: with pacing the thread is halted and resumed all the time (at pace 1x
   * it is halted most of the wall clock), and an alter batch halts it too.
   * Those halts are the engine's own scheduling, the run is still going. Not
   * live: finished, paused by the user, or the thread stopped with nothing
   * ordered to restart it (the run ended or failed on its own). A continuous
   * run whose window ran to its stop is live: the next window is due.
   */
  private runIsLive(t: NonNullable<SimHost['tran']>): boolean {
    if (t.finished || this.halt.isUserPaused()) return false
    if (this.engine.isRunning()) return true
    if (t.continuous && t.head >= t.windowStop) return true
    // Over by itself: halts and resumes still on their way (a knob being
    // turned) do not bring it back, see runResume.
    if (this.runEnded) return false
    return this.halt.getOwner() !== 'none' || this.chainPending > 0 || this.bgSettlingSince !== null
  }

  private reportStatus(): void {
    if (!this.tran) return
    const wallElapsedS = (this.now() - this.tran.windowStartWall) / 1000
    const achieved = wallElapsedS > 0 ? this.tran.simTime / wallElapsedS : 0
    this.emit({
      type: 'status',
      running: this.runIsLive(this.tran),
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
    const generation = this.transientGeneration
    const { tstep, tstop, pace } = this.tran
    // Suspend the windowed run so the timers don't re-trigger mid-restart.
    this.tran = null
    this.sampler = null
    this.stopPeriodicTimers()

    this.enqueue('benchRestart', async () => {
      // Stop or a new load/run may have been queued before this timer's
      // restart. It must not resurrect the run those commands replaced.
      if (this.closing || generation !== this.transientGeneration) return
      // The halts, resumes and alters already ordered have run (see drain; a
      // resume sees tran gone and skips itself), and none can be added while
      // tran is null, so the bg_halt below is the last word on the old thread.
      await this.waitBgSettled()
      await this.engine.command('bg_halt', false)
      await this.waitForHalt()
      await this.waitThreadGone()
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
    this.drainSamples()
    this.reportStatus()
    this.halt.clear()
    this.stopPeriodicTimers()
  }

  private async stopTransient(): Promise<void> {
    this.transientGeneration++
    // Through the chain: a resume still waiting out its settle gap must not run
    // after this halt (runResume also sees tran gone).
    const halted = this.chain(() => this.runHalt())
    this.halt.clear()
    // Flush whatever remains so the renderer sees the tail. Reading a halting
    // plot is safe: the reads hold the realloc lock and the vectors only grow.
    this.drainSamples()
    this.tran = null
    this.sampler = null
    this.stopPeriodicTimers()
    // The next command (a reload's `destroy all`, a new bg_tran) must not
    // reach ngspice before this halt has.
    await halted
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
    this.enqueue('loadCircuit', () => this.doLoadCircuit(deckLines))
  }

  private async doLoadCircuit(deckLines: string[]): Promise<void> {
    this.transientGeneration++
    if (this.tran) {
      await this.stopTransient()
      await this.waitThreadGone()
    }
    // ngSpice_Circ treats every array entry as exactly ONE card and never splits
    // on embedded newlines, so a multi-line entry (a pasted .subckt block, a
    // joined run of resistors) would reach the parser as a single malformed
    // card. Split here so no caller can regress it (issue #18). The split comes
    // BEFORE the gate: the gate must judge exactly the cards the engine will be
    // handed, so a control block hidden behind a newline is seen as its own card
    // and rejected, while a legitimate multi-line .subckt entry still loads. Any
    // line break the split leaves behind (a lone CR, a NUL) still fails the gate.
    const cards = deckLines.flatMap((line) => String(line).split(/\r?\n/))
    // The deck gate (issue #35): ngspice runs .control blocks found anywhere in
    // a deck, so nothing reaches the engine until sanitizeDeck passes. A refused
    // deck also drops the previously loaded circuit, so a later runOp/runTransient
    // cannot silently simulate a stale circuit as if the new one had loaded.
    const gate = sanitizeDeck(cards)
    if (!gate.ok) {
      if (this.deckLoaded && !this.engineNeedsReset) {
        await this.engine.command('destroy all', false)
      }
      this.deckLoaded = false
      this.currentDeck = []
      this.failedLoad = new DeckRejectedError(gate.violations).message
      this.emit({ type: 'loadFailed', detail: this.failedLoad })
      throw new DeckRejectedError(gate.violations)
    }
    // A watch belongs to the deck it was sent for: a new deck starts with every
    // vector watched again, so a consumer that never sends one (the finite-run
    // SolveEngine.runTran) gets full series whatever the bench did before.
    this.watch = null
    this.watchVersion++
    try {
      if (this.engineNeedsReset) await this.resetEngineBeforeLoad()
      else if (this.deckLoaded) await this.engine.command('destroy all', false)
      this.engine.loadCircuit(cards)
      this.currentDeck = cards
      this.deckLoaded = true
      this.failedLoad = null
      this.vectorCount = 0
      this.clampNoted = ''
    } catch (error) {
      this.engineNeedsReset = true
      this.deckLoaded = false
      this.currentDeck = []
      this.failedLoad = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'loadFailed', detail: this.failedLoad })
      throw error
    }
  }

  /** A partial parse or OP fallback must never be followed by another Circ call. */
  private async resetEngineBeforeLoad(): Promise<void> {
    this.stopPeriodicTimers()
    if (this.alterTimer) clearTimeout(this.alterTimer)
    this.alterTimer = null
    this.pendingAlters = []
    this.tran = null
    this.sampler = null
    this.halt.clear()
    await this.engineChain
    await this.waitBgSettled()
    await this.engine.command('bg_halt', false)
    await this.waitForHalt()
    const deadline = Date.now() + 500
    while (this.bgThreadRunning && Date.now() < deadline) await sleep(5)
    // Unlike best-effort final disposal, recovery must not unload a library
    // whose thread is still alive. A failed drain rejects this load cleanly.
    if (this.bgThreadRunning || this.engine.isRunning()) throw new Error('Cannot reset ngspice while its background thread is running')
    if (this.bgEverRan) await sleep(150)
    this.engine.dispose()
    this.engine.init()
    await this.engine.command(NGSPICE_NO_MEM_CHECK, false)
    this.bgEverRan = false
    this.bgThreadRunning = false
    this.bgSettlingSince = null
    this.settlingThreadUp = false
    this.lastBgStartAt = -Infinity
    this.deckLoaded = false
    this.engineNeedsReset = false
  }

  // ── promise API for the in-process SolveEngine (src/simhost/solveEngine.ts) ──

  /** loadCircuit as a promise: settles once the deck is loaded (queued like the command). */
  loadCircuit(deckLines: string[]): Promise<void> {
    return this.enqueueAwaitable('loadCircuit', () => this.doLoadCircuit(deckLines))
  }

  /**
   * A finite transient in the foreground, to completion: `tran <tstep> <tstop>
   * uic`, the same initial-condition start the live bench uses. No streaming,
   * pacing or bench windows; returns every saved vector, keyed like opResult
   * (the scale vector comes back as `time`).
   *
   * With `tstart` the run still starts at t=0 and takes the same steps (the
   * points it keeps are identical to the same span of the full run), but ngspice
   * keeps only the points from `tstart` on. Every kept point is also a SendData
   * callback that blocks the solver thread until the JS thread has taken it,
   * which is most of the wall time of a long fine-step run: the 555 sample over
   * 0.7 s at 2 us steps takes 14.6 s keeping all 350k points and 3.8 s keeping
   * the last 500. A caller that reads only the end of a run should pass `tstart`.
   */
  runTran(
    tstep: number,
    tstop: number,
    tstart = 0
  ): Promise<{ time: Float64Array; vectors: Record<string, Float64Array> }> {
    return this.enqueueAwaitable('runTran', async () => {
      if (this.failedLoad !== null) throw new Error(`Circuit was not loaded: ${this.failedLoad}`)
      tstep = transientMaxStep(tstep, this.currentDeck)
      if (!(tstart >= 0 && tstart < tstop)) {
        throw new RangeError(`runTran needs 0 <= tstart < tstop; got tstart=${tstart}, tstop=${tstop}`)
      }
      // ngspice allocates the whole run at its first saved point (from tstop,
      // whatever tstart is), and an allocation it cannot make ends in a
      // ControlledExit, so refuse a run over the budget before ngspice sees it.
      const budget = this.tranMemoryBudgetBytes
      const saved = await this.countTranVectors(tstep)
      if (saved > 0) {
        const need = ngspiceTranMemoryBytes(saved, tstep, tstop)
        if (need > budget) {
          throw new RangeError(
            `runTran: ${saved} saved vectors at ${formatNum(tstep)} s steps over ${formatNum(tstop)} s need ` +
              `${Math.round(need / 1048576)} MB, over the ${Math.round(budget / 1048576)} MB budget; ` +
              `save fewer vectors or run a shorter stop`
          )
        }
      }
      // ngspice's step limit is tstep, or (tstop - tstart)/50 when that is
      // smaller (traninit.c). Pin it to what the run from 0 uses, min(tstep,
      // tstop/50), so tstart changes only which points are kept.
      const from = tstart > 0 ? ` ${formatNum(tstart)} ${formatNum(Math.min(tstep, tstop / 50))}` : ''
      await this.engine.command(`tran ${formatNum(tstep)} ${formatNum(tstop)}${from} uic`, true)
      const plot = this.engine.currentPlot()
      let time: Float64Array = new Float64Array(0)
      const vectors: Record<string, Float64Array> = {}
      for (const raw of this.engine.allVectors(plot)) {
        const data = this.engine.vectorData(raw)
        if (!data) continue
        if (isScaleVectorName(raw)) time = data
        else vectors[normalizeVectorKey(raw)] = data
      }
      return { time, vectors }
    })
  }

  /** Queue `run` like any command; the promise carries its outcome. */
  private enqueueAwaitable<T>(label: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueue(label, async () => {
        try {
          resolve(await run())
        } catch (e) {
          reject(e)
          throw e // still logged by drain(), like every failed command
        }
      })
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

  /**
   * Drain pending alters inside one halt/resume window, respecting haltOwner.
   * The alters are applied on engineChain, behind the halt that precedes them
   * (this batch's own, or the user's / pacing's that already holds the
   * thread) and ahead of the resume, which is ordered after them. Issued
   * straight from the queue, they overtook a bg_resume still waiting out its
   * settle gap and landed on a thread that was starting: ngspice aborted the
   * run (PR #129 review).
   *
   * At most one batch is waiting to apply its alters, and it takes every alter
   * pending when it gets to them: a knob dragged faster than one halt/resume
   * cycle is applied a batch at a time instead of piling up a cycle per alter,
   * and the queue is never held up by a batch, so a pause or a stop during a
   * drag is not either.
   */
  flushAlters(): void {
    if (this.pendingAlters.length === 0 || this.alterStepPending) return
    this.alterStepPending = true
    this.enqueue('alterBatch', async () => {
      const tookHalt = this.halt.requestHalt('alter')
      this.chain(() => this.runAlters()).catch((e: unknown) => {
        this.emit({ type: 'log', level: 'error', text: `alter failed: ${(e as Error).message}` })
      })
      // If the user paused, we keep their pause (a non-owner resume is a no-op
      // in the coordinator); otherwise the alter batch resumes the run.
      if (tookHalt) this.halt.requestResume('alter')
    })
  }

  /**
   * Apply the pending alters, as ordered on engineChain. WAIT for the bg thread
   * to actually stop first: bg_halt only requests the background thread to
   * pause, and an alter issued before the thread has stopped races and is
   * silently dropped (verified against ngspice 46: the alter must land while
   * the engine is halted).
   */
  private async runAlters(): Promise<void> {
    let alters: string[] = []
    try {
      await this.waitForHalt()
      await this.waitThreadGone()
    } finally {
      // From here on a new alter needs a batch of its own.
      this.alterStepPending = false
      alters = this.pendingAlters
      this.pendingAlters = []
    }
    for (const a of alters) {
      await this.engine.command(a, false)
    }
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

  /**
   * Wait until the background run started last is going (it announced itself
   * with SendInitData) and has been left alone MIN_RUN_AFTER_START_MS, so a halt
   * never lands on a thread that is still starting. Bounded; no-op when the
   * settle gap is disabled (unit tests).
   */
  private async waitBgSettled(): Promise<void> {
    if (this.resumeGapMs <= 0) return
    const deadline = this.now() + RESUME_SETTLE_MAX_MS
    while (this.bgSettlingSince !== null && this.now() < deadline) await sleep(5)
    const wait = this.lastBgStartAt + MIN_RUN_AFTER_START_MS - this.now()
    if (wait > 0) await sleep(wait)
  }

  /**
   * Append a step (bg_halt, bg_resume, an alter batch) to engineChain: it runs
   * after every step ordered before it. The returned promise settles with the
   * step; a step that fails does not stop the ones after it.
   */
  private chain(run: () => Promise<void>): Promise<void> {
    this.chainPending++
    const step = this.engineChain.then(run)
    this.engineChain = step
      .catch(() => {
        /* reported to the step's own caller */
      })
      .finally(() => {
        this.chainPending--
      })
    return step
  }

  /**
   * Wait (bounded) for the halted thread's final BGThreadRunning: bg_halt
   * returns, and ngSpice_running() drops, a little before the thread has
   * finished unwinding. No-op when the settle gap is disabled (unit tests).
   */
  private async waitThreadGone(): Promise<void> {
    if (this.resumeGapMs <= 0) return
    const deadline = this.now() + 500
    while (this.bgThreadRunning && this.now() < deadline) await sleep(5)
  }

  /** bg_halt, as ordered on engineChain. Never rejects: the chain must keep going. */
  private async runHalt(): Promise<void> {
    await this.waitBgSettled()
    try {
      // A thread that announced itself, was not halted since, and is no longer
      // running ended by itself: the run reached its stop time or failed.
      if (
        this.tran &&
        !this.haltedSinceStart &&
        this.bgSettlingSince === null &&
        !this.engine.isRunning()
      ) {
        this.runEnded = true
      }
      this.haltedSinceStart = true
      await this.engine.command('bg_halt', false)
    } catch {
      /* engine gone: nothing left to halt */
    }
    this.haltDoneAt = this.now()
  }

  /**
   * bg_resume, as ordered on engineChain: wait until the thread that was halted
   * has reported itself stopped and RESUME_GAP_MS have passed since bg_halt
   * completed (see RESUME_GAP_MS), then resume. Skipped if the run was stopped,
   * replaced or finished in the meantime, or has ended by itself (see runEnded):
   * a resume then never announces itself, and the sample tick would wait for
   * it.
   */
  private async runResume(): Promise<void> {
    if (!this.resumable()) return
    if (this.resumeGapMs > 0) {
      await this.waitThreadGone()
      const wait = this.haltDoneAt + this.resumeGapMs - this.now()
      if (wait > 0) await sleep(wait)
      if (!this.resumable()) return
    }
    this.bgSettlingSince = this.lastBgStartAt = this.now()
    this.settlingThreadUp = false
    this.haltedSinceStart = false
    try {
      await this.engine.command('bg_resume', false)
    } catch {
      this.bgSettlingSince = null
    }
  }

  /**
   * Whether a resume ordered earlier should still reach ngspice. Not when the
   * run is gone, finished or over by itself, and not when a halt has been
   * requested since (a pause pressed during a knob drag): that halt is behind
   * this resume on engineChain, and starting the thread only to halt it again
   * would cost a whole halt / resume cycle.
   */
  private resumable(): boolean {
    return this.tran !== null && !this.tran.finished && !this.runEnded && !this.halt.isHalted()
  }

  // ── haltOwner accessors (tests) ────────────────────────────────────────────

  getHaltOwner(): import('./haltCoordinator').HaltOwner {
    return this.halt.getOwner()
  }

  // ── queue + watchdog ────────────────────────────────────────────────────

  private enqueue(label: string, run: () => Promise<void>): void {
    const touchesPlot = !CHAIN_ONLY_COMMANDS.has(label)
    if (touchesPlot) this.plotItems++
    this.queue.push({ label, run, touchesPlot })
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
          // Commands sent to ngspice directly never overlap a halt, resume or
          // alter batch ordered before them (CHAIN_ONLY_COMMANDS).
          if (item.touchesPlot) await this.engineChain
          await item.run()
        } catch (e) {
          this.emit({
            type: 'log',
            level: 'error',
            text: `command "${item.label}" failed: ${(e as Error).message}`
          })
        } finally {
          if (item.touchesPlot) this.plotItems--
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
    if (this.closing || this.disableTimers || this.pacingTimer) return
    this.pacingTimer = setInterval(() => this.pacingTick(), PACING_INTERVAL_MS)
    if (typeof this.pacingTimer.unref === 'function') this.pacingTimer.unref()
    this.sampleTimer = setInterval(() => this.sampleTick(), SAMPLE_INTERVAL_MS)
    if (typeof this.sampleTimer.unref === 'function') this.sampleTimer.unref()
  }

  private stopPeriodicTimers(): void {
    if (this.pacingTimer) {
      clearInterval(this.pacingTimer)
      this.pacingTimer = null
    }
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer)
      this.sampleTimer = null
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * How many leading elements (of the first `n`) of the ascending `times` are
 * <= `limit`. Sim time only moves forward, so this is a binary search.
 */
export function countAtMost(times: Float64Array, n: number, limit: number): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] <= limit) lo = mid + 1
    else hi = mid
  }
  return lo
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
