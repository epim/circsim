/**
 * src/simhost/__tests__/stubEngine.ts
 *
 * A scriptable SpiceEngine for the SimHost unit tests: records commands, plays
 * back engine events, and holds a fake plot whose vectors the test grows with
 * pushPoint(). The vector reads follow the real adapter's contract (typed
 * windows, negative `from` counts from the end, undefined for unknown names) and
 * record lock/unlock calls so tests can assert every read is under the lock.
 */

import type { EngineEvent, EngineEventListener, SpiceEngine, VectorRead } from '../engine'

export class StubEngine implements SpiceEngine {
  version = '46'
  commands: string[] = []
  private listeners: EngineEventListener[] = []
  running = false

  /** The fake plot: vector name to its points so far. */
  plot: Record<string, number[]> = {}
  /** Names reported by SendInitData when the run starts. */
  initNames: string[] = ['time', 'out']
  /** True while a lockVectors() is open. */
  locked = false
  /** readVector calls made outside a lock (must stay 0). */
  unlockedReads = 0
  /** Total readVector calls (tests assert the poll cost). */
  reads = 0
  /** Vector names that exist in the plot but have no readable data. */
  unreadable = new Set<string>()
  private initSent = false

  init(): void {}
  on(l: EngineEventListener): () => void {
    this.listeners.push(l)
    return () => {
      const i = this.listeners.indexOf(l)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }
  emit(ev: EngineEvent): void {
    for (const l of this.listeners) l(ev)
  }
  loadCircuit(): void {}
  command(cmd: string): Promise<void> {
    this.commands.push(cmd)
    if (cmd.startsWith('bg_tran')) {
      this.running = true
      this.initSent = false
      this.plot = {}
    }
    if (cmd === 'bg_halt') this.running = false
    if (cmd === 'bg_resume') {
      this.running = true
      // ngspice re-announces the (continuing) plot on every resume.
      this.emit({ type: 'initData', plot: 'tran1', analysisType: 'transient', names: this.initNames })
    }
    return Promise.resolve()
  }
  currentPlot(): string {
    return 'tran1'
  }
  allVectors(): string[] {
    return Object.keys(this.plot)
  }
  vectorData(name: string): Float64Array | undefined {
    const v = this.plot[name]
    return v ? Float64Array.from(v) : undefined
  }
  readVector(name: string, from: number, maxCount: number): VectorRead | undefined {
    this.reads++
    if (!this.locked) this.unlockedReads++
    const v = this.plot[name]
    if (!v || v.length === 0 || this.unreadable.has(name)) return undefined
    const start = from < 0 ? Math.max(0, v.length + from) : Math.min(from, v.length)
    const end = Math.min(v.length, start + maxCount)
    return { length: v.length, data: Float64Array.from(v.slice(start, end)) }
  }
  lockVectors(): void {
    this.locked = true
  }
  unlockVectors(): void {
    this.locked = false
  }
  isRunning(): boolean {
    return this.running
  }
  dispose(): void {}

  /**
   * Append one timepoint to the plot. The first call of a run also delivers
   * SendInitData (listing `initNames`), as ngspice does before the first point.
   * `row` must carry `time` and may carry any other vector of initNames.
   */
  pushPoint(row: Record<string, number>): void {
    if (!this.initSent) {
      this.initSent = true
      this.emit({ type: 'initData', plot: 'tran1', analysisType: 'transient', names: this.initNames })
    }
    for (const [name, value] of Object.entries(row)) (this.plot[name] ??= []).push(value)
  }
}
