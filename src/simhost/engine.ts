/**
 * src/simhost/engine.ts
 *
 * The internal SpiceEngine abstraction (Spec §7.6). SimHost is written against
 * this interface; the koffi/libngspice adapter (ngspiceFfi.ts) is the primary
 * implementation. A pipe-mode adapter (`ngspice -p`) could be substituted behind
 * the same interface if FFI proves unstable on some platform — design for it,
 * don't build it in v1.
 *
 * The engine surfaces low-level ngspice operations; the higher-level command
 * queue / watchdog / pacing / haltOwner state machine (Spec §7.4) lives in
 * index.ts and consumes this interface.
 */

import type { SimEvent } from './protocol'

/** Result of a DC operating-point analysis, keys normalized per Spec §6.1. */
export interface OpResult {
  /** Bare lowercase node names → voltage; "i(<dev>)" → current. */
  values: Record<string, number>
}

/** A window of a real vector, see SpiceEngine.readVector. */
export interface VectorRead {
  /** Total number of points the vector holds right now. */
  length: number
  /** The requested elements, oldest first. */
  data: Float64Array
}

/** Events the engine emits up to the SimHost orchestration layer. */
export type EngineEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  /** Raw ngspice text line from SendChar — used by the watchdog as "progress". */
  | { type: 'char'; text: string }
  /** Raw ngspice status line from SendStat. */
  | { type: 'stat'; text: string }
  /** ControlledExit callback fired (ngspice wants to terminate). */
  | { type: 'controlledExit'; status: number; immediate: boolean; quitOnExit: boolean }
  /**
   * SendInitData: the full vector list for a starting run (includes the scale
   * vector, e.g. "time"). Decoded from `vecinfoall`. Fires once per run, after
   * the plot's vectors exist, so it is the signal that live reads are safe.
   * (There is deliberately no per-timepoint SendData event: an FFI callback per
   * accepted timepoint caps the bench well below real time, issue #25. Samples
   * are read from the plot vectors instead, see readVector.)
   */
  | { type: 'initData'; plot: string; analysisType: string; names: string[] }
  /** Background thread running state changed (true = NOT running). */
  | { type: 'bgRunning'; running: boolean }

export type EngineEventListener = (ev: EngineEvent) => void

export interface SpiceEngine {
  /** ngspice library version string (e.g. "46"), available after init(). */
  readonly version: string

  /**
   * Load the platform library, register callbacks, bootstrap the `.cm` code
   * models (spinit + SPICE_SCRIPTS, Spec §7.2), and call ngSpice_Init.
   * Idempotent: a second call is a no-op.
   */
  init(): void

  /** Subscribe to engine events. Returns an unsubscribe function. */
  on(listener: EngineEventListener): () => void

  /**
   * Load a deck from memory via ngSpice_Circ. Callers MUST issue `destroy all`
   * (via command()) before each reload — Spec §7.4 gotcha 5.
   * Throws when native parsing fails, including errors with a zero return code.
   * A failed load can leave a partial circuit; reset the engine before reloading.
   */
  loadCircuit(deckLines: string[]): void

  /**
   * Issue a raw ngspice command. `blocking` selects koffi's async call form
   * (Spec §7.4 gotcha 4): potentially-long commands (op, tran, run) must be
   * invoked async so the event loop + watchdog stay alive; bg_* commands return
   * immediately and may stay sync (blocking=false).
   */
  command(cmd: string, blocking: boolean): Promise<void>

  /** Current plot name (ngSpice_CurPlot). */
  currentPlot(): string

  /** All vector names of the given plot (ngSpice_AllVecs), null-terminated walk. */
  allVectors(plot: string): string[]

  /**
   * Read a single real-valued vector by name (ngGet_Vec_Info). Returns the full
   * data array, or undefined if the vector is missing / has no real data.
   */
  vectorData(name: string): Float64Array | undefined

  /**
   * Read part of a real vector of the current plot while a run may be in
   * progress: elements `[from, min(length, from + maxCount))` as a typed array,
   * plus the vector's current `length`. A negative `from` counts from the end
   * (-1 is the newest element). Returns undefined when the vector is missing or
   * has no real data. Call only for names that exist (ngspice reports a missing
   * vector on stderr) and only between lockVectors() and unlockVectors() while
   * the background thread runs.
   */
  readVector(name: string, from: number, maxCount: number): VectorRead | undefined

  /**
   * Block the background thread's vector reallocation (ngSpice_LockRealloc).
   * Hold it only for the duration of a batch of readVector calls; the
   * background thread stalls if it needs to grow a vector meanwhile.
   */
  lockVectors(): void
  unlockVectors(): void

  /** ngSpice_running() — true while a (bg) analysis is active. */
  isRunning(): boolean

  /** Free FFI resources (best-effort). */
  dispose(): void
}

/** Helper: build a `samples`/`vectors`/`opResult` SimEvent — re-exported for callers. */
export type { SimEvent }
