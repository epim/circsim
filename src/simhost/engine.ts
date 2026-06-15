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

/** Events the engine emits up to the SimHost orchestration layer. */
export type EngineEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  /** Raw ngspice text line from SendChar — used by the watchdog as "progress". */
  | { type: 'char'; text: string }
  /** Raw ngspice status line from SendStat. */
  | { type: 'stat'; text: string }
  /** ControlledExit callback fired (ngspice wants to terminate). */
  | { type: 'controlledExit'; status: number; immediate: boolean; quitOnExit: boolean }
  /** SendInitData: vector names for a starting run. */
  | { type: 'initData'; names: string[] }
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

  /** ngSpice_running() — true while a (bg) analysis is active. */
  isRunning(): boolean

  /** Free FFI resources (best-effort). */
  dispose(): void
}

/** Helper: build a `samples`/`vectors`/`opResult` SimEvent — re-exported for callers. */
export type { SimEvent }
