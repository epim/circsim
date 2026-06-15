/**
 * src/simhost/sampleBatcher.ts
 *
 * Accumulates per-timepoint transient samples (delivered one row at a time via
 * ngspice's SendData callback) and flushes them up to the renderer as a single
 * `samples` SimEvent (Spec §6.1) carrying transferable Float64Array columns.
 *
 * Flush policy (Spec §6.1 / Task 10): flush whenever EITHER
 *   - the pending row count reaches `maxPoints` (default 4096), OR
 *   - `maxAgeMs` (default 16 ms) has elapsed since the first un-flushed row.
 *
 * The independent variable ("time") is split into its own `simTime` array; the
 * remaining vectors become `columns`, in `vectorNames` order. One Float64Array is
 * allocated per column at flush time so the buffers can be transferred (zero-copy)
 * across the MessagePort without the batcher retaining a reference.
 *
 * The batcher is engine-agnostic and synchronous: the FFI SendData callback calls
 * `push()` (cheap — just appends numbers), and a timer / the orchestrator calls
 * `flush()` from a JS-thread frame. It never calls back into ngspice.
 */

import type { SimEvent } from './protocol'

export interface SampleBatcherOptions {
  /** Flush when this many rows are pending (default 4096). */
  maxPoints?: number
  /** Flush when the oldest pending row is this old, in ms (default 16). */
  maxAgeMs?: number
  /** Monotonic clock source (ms). Injectable for deterministic tests. */
  now?: () => number
}

/** A `samples` SimEvent plus the transferable buffers it carries. */
export interface SampleFlush {
  event: Extract<SimEvent, { type: 'samples' }>
  /** ArrayBuffers to hand to postMessage's transfer list (zero-copy). */
  transfer: ArrayBuffer[]
}

const DEFAULT_MAX_POINTS = 4096
const DEFAULT_MAX_AGE_MS = 16

export class SampleBatcher {
  private readonly maxPoints: number
  private readonly maxAgeMs: number
  private readonly now: () => number

  /** Vector names for the value columns (excludes the scale/time vector). */
  private vectorNames: string[] = []
  /** Name of the scale (independent) vector, e.g. "time". */
  private scaleName = 'time'

  /** Column-major pending buffers, one array per vectorName. */
  private cols: number[][] = []
  private times: number[] = []
  /** Wall-clock ms when the current batch's first row was pushed. */
  private firstRowAt = 0

  constructor(opts: SampleBatcherOptions = {}) {
    this.maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Declare the vector layout for the run. Called when SendInitData arrives.
   * `names` is the full ngspice vector list (including the scale vector). Any
   * pending rows are discarded — a new run starts a fresh plot.
   */
  setVectors(names: string[], scaleName = 'time'): void {
    this.scaleName = scaleName
    this.vectorNames = names.filter((n) => n !== scaleName)
    this.reset()
  }

  /** Vector names that will appear in flushed `columns` (scale excluded). */
  getVectorNames(): string[] {
    return this.vectorNames
  }

  /**
   * Append one timepoint. `row` maps vector name → value (must include the scale
   * vector). Values for unknown vectors are ignored; missing vectors push NaN.
   * Returns a SampleFlush if this push triggered a size-based flush, else null.
   */
  push(row: Record<string, number>): SampleFlush | null {
    if (this.times.length === 0) {
      this.firstRowAt = this.now()
    }
    this.times.push(row[this.scaleName] ?? NaN)
    for (let i = 0; i < this.vectorNames.length; i++) {
      const v = row[this.vectorNames[i]]
      this.cols[i].push(v === undefined ? NaN : v)
    }
    if (this.times.length >= this.maxPoints) {
      return this.flush()
    }
    return null
  }

  /** True if the time-based flush threshold has elapsed and rows are pending. */
  shouldFlushByAge(): boolean {
    return this.times.length > 0 && this.now() - this.firstRowAt >= this.maxAgeMs
  }

  /** Number of rows pending (un-flushed). */
  get pending(): number {
    return this.times.length
  }

  /**
   * Build a `samples` event from the pending rows and clear them. Returns null
   * when nothing is pending. Each column is materialized into its own
   * Float64Array; those buffers are listed in `transfer` for zero-copy postMessage.
   */
  flush(): SampleFlush | null {
    if (this.times.length === 0) return null

    const simTime = Float64Array.from(this.times)
    const columns: Float64Array[] = this.cols.map((c) => Float64Array.from(c))

    // Float64Array.from always allocates a fresh, non-shared ArrayBuffer.
    const transfer: ArrayBuffer[] = [
      simTime.buffer as ArrayBuffer,
      ...columns.map((c) => c.buffer as ArrayBuffer)
    ]
    const event: Extract<SimEvent, { type: 'samples' }> = {
      type: 'samples',
      vectorNames: [...this.vectorNames],
      columns,
      simTime
    }

    this.reset()
    return { event, transfer }
  }

  /** Discard all pending rows (e.g. on bench restart / new run). */
  reset(): void {
    this.times = []
    this.cols = this.vectorNames.map(() => [])
    this.firstRowAt = 0
  }
}
