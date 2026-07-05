/**
 * watchdog.test.ts — SimHost stall watchdog threshold.
 *
 * The watchdog's job (Spec §7.4 gotcha 7) is to catch a WEDGED engine so the
 * supervisor can respawn it. It must NOT kill a busy one: ngspice's op retry
 * ladder (gmin/source stepping → transient op) can grind silently — no
 * SendChar/SendData callbacks — for well over 10 s on a slow machine. CI
 * caught exactly that: GitHub's shared Windows runners tripped a 10 s
 * threshold mid-op and the app showed "Simulator restarted" (exit 86) while
 * the solve was making progress. The threshold is 60 s: long enough for any
 * legitimate silent solve phase, short enough that a truly wedged engine
 * still recovers.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { SimHost } from '../index'
import type {
  SpiceEngine,
  EngineEvent,
  EngineEventListener
} from '../engine'

/** Stub engine whose command() never resolves — models a silent, grinding solve. */
class HangingEngine implements SpiceEngine {
  version = '46'
  private listeners: EngineEventListener[] = []

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
  command(): Promise<void> {
    return new Promise(() => {}) // never settles
  }
  currentPlot(): string {
    return 'tran1'
  }
  allVectors(): string[] {
    return []
  }
  vectorData(): Float64Array | undefined {
    return undefined
  }
  isRunning(): boolean {
    return false
  }
  dispose(): void {}
}

describe('SimHost watchdog', () => {
  let exitSpy: MockInstance<[code?: string | number | null | undefined], never>

  beforeEach(() => {
    vi.useFakeTimers()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // don't actually exit the test worker
    }) as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    vi.useRealTimers()
  })

  function startHangingCommand(): { engine: HangingEngine; host: SimHost } {
    const engine = new HangingEngine()
    const host = new SimHost({ engine, emit: () => {}, disableTimers: true })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-5, tstopSeconds: 1 })
    return { engine, host }
  }

  it('does NOT kill the process during a 30 s silent stretch (slow-but-live solve)', () => {
    startHangingCommand()
    vi.advanceTimersByTime(30_000)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('kills the process (exit 86) after 60 s with no progress', () => {
    startHangingCommand()
    vi.advanceTimersByTime(61_000)
    expect(exitSpy).toHaveBeenCalledWith(86)
  })

  it('engine callback traffic counts as progress and defers the kill', () => {
    const { engine } = startHangingCommand()
    // Every 20 s the engine emits a char event (e.g. a gmin-step progress line):
    // the watchdog must never fire even though each gap exceeds 10 s.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20_000)
      engine.emit({ type: 'char', text: 'stderr Note: still stepping' })
    }
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
