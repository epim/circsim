/**
 * src/simhost/__tests__/solveEngine.integration.test.ts
 *
 * The in-process SolveEngine (issue #53) against REAL bundled ngspice-46: the
 * engine tests and the CLI use to run src/core/solve without Electron. One
 * engine per file (libngspice is process-global; vitest forks isolate files).
 * Skipped automatically when resources/ngspice/<platform> is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'
import { createInProcessSolveEngine, type InProcessSolveEngine } from '../solveEngine'

const haveNgspice = ngspiceResourcesAvailable()

describe.skipIf(!haveNgspice)('in-process SolveEngine (real ngspice)', () => {
  let engine: InProcessSolveEngine
  const events: SimEvent[] = []

  beforeAll(async () => {
    engine = await createInProcessSolveEngine({ onEvent: e => events.push(e) })
  }, 60_000)

  afterAll(async () => {
    await engine?.dispose()
  })

  it('solves an operating point and reports how it converged', async () => {
    await engine.loadCircuit(['* divider', 'v1 in 0 dc 5', 'r1 in out 1k', 'r2 out 0 1k', '.end'])
    const op = await engine.runOp()
    expect(op.values.out).toBeCloseTo(2.5, 6)
    expect(op.values.in).toBeCloseTo(5, 6)
    expect(op.values['i(v1)']).toBeCloseTo(-2.5e-3, 9)
    expect(op.method).toBe('direct')
  }, 60_000)

  it('runs a finite transient from initial conditions and returns whole vectors', async () => {
    // Same RC as transient.integration.test.ts: tau = 1 ms, starting at 0 V (uic),
    // exactly as the live bench starts a run.
    await engine.loadCircuit(['* rc charge', 'v1 in 0 dc 5', 'r1 in out 1k', 'c1 out 0 1u ic=0', '.end'])
    const tran = await engine.runTran(10e-6, 5e-3)

    expect(tran.time.length).toBeGreaterThan(100)
    // Under `uic` the plot starts at ngspice's first internal step, not t = 0.
    expect(tran.time[0]).toBeGreaterThan(0)
    expect(tran.time[0]).toBeLessThan(10e-6)
    expect(tran.time[tran.time.length - 1]).toBeCloseTo(5e-3, 9)
    const out = tran.vectors.out
    expect(out).toBeInstanceOf(Float64Array)
    expect(out.length).toBe(tran.time.length)
    expect(out[0]).toBeLessThan(0.01) // charging from the 0 V initial condition
    expect(tran.vectors.time).toBeUndefined() // the scale vector is `time`, not a value column

    const at = (t: number): number => {
      let best = 0
      for (let i = 1; i < tran.time.length; i++) {
        if (Math.abs(tran.time[i] - t) < Math.abs(tran.time[best] - t)) best = i
      }
      return out[best]
    }
    for (const t of [1e-3, 2e-3, 5e-3]) {
      const expected = 5 * (1 - Math.exp(-t / 1e-3))
      expect(Math.abs(at(t) - expected) / expected).toBeLessThan(0.02)
    }
  }, 60_000)

  it('keeps working after a transient: reload and solve an op again', async () => {
    await engine.loadCircuit(['* divider 2', 'v1 in 0 dc 9', 'r1 in out 2k', 'r2 out 0 1k', '.end'])
    const op = await engine.runOp()
    expect(op.values.out).toBeCloseTo(3, 6)
    expect(events.some(e => e.type === 'log' && e.level === 'error')).toBe(false)
  }, 60_000)

  it('refuses a transient with a non-positive step or stop time', async () => {
    await expect(engine.runTran(0, 1e-3)).rejects.toThrow(RangeError)
    await expect(engine.runTran(1e-6, -1)).rejects.toThrow(RangeError)
  })
})
