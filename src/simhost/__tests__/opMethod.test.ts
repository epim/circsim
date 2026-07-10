/**
 * opMethod.test.ts — F1: the op retry ladder reports HOW it converged.
 *
 * On a hard board the DC operating point often "succeeds" only via a fallback
 * rung (gmin stepping → source stepping → ngspice's internal transient-op
 * fallback), typically with most nets reading 0.000 V. Presenting such a solve
 * as truth is a trust bug — so `opResult` now carries an additive `method`
 * field naming the rung that produced the values:
 *
 *   'direct' | 'gmin' | 'source' | 'tran-fallback' | 'failed'
 *
 * Rung index and ngspice's own SendChar fallback narration ("gmin stepping
 * failed", "Transient op started", …) both feed the classification: ngspice
 * runs its OWN internal ladder inside a single `op`, so even the first rung can
 * secretly be a fallback solve.
 */

import { describe, it, expect } from 'vitest'
import { SimHost } from '../index'
import type { SimEvent } from '../protocol'
import type { EngineEvent, EngineEventListener, SpiceEngine } from '../engine'

/**
 * Stub engine driving the op ladder deterministically:
 *  - the Nth `op` command (1-based) is the first to yield finite plot values;
 *  - `chatter[n]` lines are emitted on the SendChar path WHILE the nth op runs
 *    (i.e. while SimHost's opInFlight is true), mimicking ngspice's internal
 *    fallback narration.
 */
class OpLadderEngine implements SpiceEngine {
  version = '46'
  opAttempts = 0
  commands: string[] = []
  private listeners: EngineEventListener[] = []

  constructor(
    private succeedOnAttempt: number,
    private chatter: Record<number, string[]> = {}
  ) {}

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
    if (cmd === 'op') {
      this.opAttempts++
      for (const line of this.chatter[this.opAttempts] ?? []) {
        this.emit({ type: 'char', text: line })
      }
    }
    return Promise.resolve()
  }
  currentPlot(): string {
    return 'op1'
  }
  allVectors(): string[] {
    return ['V(out)']
  }
  vectorData(): Float64Array | undefined {
    // Failed rungs read back NaN (no converged solution in the plot).
    return this.opAttempts >= this.succeedOnAttempt ? Float64Array.of(2.5) : Float64Array.of(NaN)
  }
  isRunning(): boolean {
    return false
  }
  dispose(): void {}
}

async function runLadder(
  succeedOnAttempt: number,
  chatter: Record<number, string[]> = {}
): Promise<{ events: SimEvent[]; engine: OpLadderEngine; values: Record<string, number> }> {
  const engine = new OpLadderEngine(succeedOnAttempt, chatter)
  const events: SimEvent[] = []
  const host = new SimHost({
    engine,
    emit: (ev) => events.push(ev),
    disableWatchdog: true,
    disableTimers: true
  })
  const values = await host.runOp()
  return { events, engine, values }
}

function opResultOf(events: SimEvent[]): Extract<SimEvent, { type: 'opResult' }> {
  const ev = events.find((e) => e.type === 'opResult')
  expect(ev, 'expected an opResult event').toBeDefined()
  return ev as Extract<SimEvent, { type: 'opResult' }>
}

describe('doRunOp — opResult.method (F1)', () => {
  it('first rung converges with no fallback chatter → method "direct"', async () => {
    const { events, engine } = await runLadder(1)
    const op = opResultOf(events)
    expect(op.method).toBe('direct')
    expect(op.values).toEqual({ out: 2.5 }) // key normalization unchanged
    expect(engine.opAttempts).toBe(1)
    expect(events.some((e) => e.type === 'convergenceFailure')).toBe(false)
  })

  it('second rung (gmin stepping) converges → method "gmin"', async () => {
    const { events, engine } = await runLadder(2)
    expect(opResultOf(events).method).toBe('gmin')
    // The gmin rung applied its option before retrying.
    expect(engine.commands).toContain('set gminsteps=10')
    expect(events.some((e) => e.type === 'convergenceFailure')).toBe(false)
  })

  it('third rung (source stepping) converges → method "source"', async () => {
    const { events, engine } = await runLadder(3)
    expect(opResultOf(events).method).toBe('source')
    expect(engine.commands).toContain('set srcsteps=10')
    expect(events.some((e) => e.type === 'convergenceFailure')).toBe(false)
  })

  it('rung 1 "succeeds" but ngspice narrated its OPTRAN fallback → method "tran-fallback"', async () => {
    // The real-board failure mode: gmin + source stepping fail INSIDE ngspice,
    // then its transient-op fallback produces a (dubious) solution — all within
    // the first `op` command.
    const { events } = await runLadder(1, {
      1: [
        'Warning: gmin stepping failed',
        'Warning: source stepping failed',
        'Transient op started',
        'Transient op finished successfully'
      ]
    })
    expect(opResultOf(events).method).toBe('tran-fallback')
  })

  it('rung 1 "succeeds" after internal source stepping chatter → method "source"', async () => {
    const { events } = await runLadder(1, {
      1: ['Warning: gmin stepping failed', 'Supplies reduced to 20% (source stepping)']
    })
    expect(opResultOf(events).method).toBe('source')
  })

  it('all rungs fail → convergenceFailure + opResult with method "failed"', async () => {
    const { events, engine } = await runLadder(99)
    expect(engine.opAttempts).toBe(3) // full ladder exhausted
    expect(events.some((e) => e.type === 'convergenceFailure')).toBe(true)
    expect(opResultOf(events).method).toBe('failed')
  })

  it('chatter flags reset between ops — a clean re-solve is "direct" again', async () => {
    const engine = new OpLadderEngine(1, {
      1: ['Transient op started'] // first op is a tran-fallback solve
    })
    const events: SimEvent[] = []
    const host = new SimHost({
      engine,
      emit: (ev) => events.push(ev),
      disableWatchdog: true,
      disableTimers: true
    })
    await host.runOp()
    await host.runOp() // second op: no chatter → must not inherit tran-fallback
    const ops = events.filter((e) => e.type === 'opResult') as Extract<
      SimEvent,
      { type: 'opResult' }
    >[]
    expect(ops.map((o) => o.method)).toEqual(['tran-fallback', 'direct'])
  })
})
