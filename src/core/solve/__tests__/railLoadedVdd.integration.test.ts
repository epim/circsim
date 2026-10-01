/**
 * Issue #44: rail sensing must not commit a pass-1 rail that an output biased.
 *
 * The rail-sensing fixture (CD40106 whose VDD is the mid-point of a 7k/5k
 * divider from 12 V, so the self-consistent rail is 5.0 V) plus R4 = 10k from
 * the chip's own output 1Y to /VGATED, the shape of an LED pull-up or a feedback
 * resistor. Pass 1 drives 1Y at the 12 V family default, so R4 injects current
 * into the soft rail and pass 1 reads about 6.6 V. Committing that value
 * simulates a 5 V part at a 6.6 V swing for the whole session. The plan has to
 * keep reconciling until the sensed rail stops moving.
 *
 * Runs against real ngspice through the in-process engine; skipped when
 * resources/ngspice/<platform> is missing.
 */

import { describe, expect, it } from 'vitest'

import { buildSolveInputs } from '../inputs'
import { runSolvePlan } from '../plan'
import type { SolveEngine, SolveResult } from '../types'
import { LOGIC4000, VGATED_NET, switchedRailFixture } from './switchedRail.fixture'

// src/core is typechecked by the renderer project, which cannot see src/simhost, so
// the real engine is loaded by a runtime path rather than a static import.
const SIMHOST = '../../../simhost/'
const ffi = (await import(/* @vite-ignore */ SIMHOST + 'ngspiceFfi')) as { ngspiceResourcesAvailable(): boolean }
const haveNgspice = ffi.ngspiceResourcesAvailable()

const OUT_NET = 4

async function solveFixture(pullUp: boolean): Promise<SolveResult> {
  const f = switchedRailFixture(12)
  if (pullUp) {
    f.circuit.parts.push({
      ref: 'R4', value: '10k', libId: 'R', layer: 'F',
      padNet: new Map([['1', OUT_NET], ['2', VGATED_NET]]), properties: {},
    })
    f.resolutions.push({
      ref: 'R4', status: 'ok', tier: 2, warnings: [],
      model: { kind: 'primitive', card: 'r_r4 out vgated 10000' },
    })
  }
  const inputs = buildSolveInputs(null, f.circuit, f.resolutions, f.instruments, f.groundNetId, {
    title: pullUp ? 'rail-loaded-vdd' : 'rail-unloaded-vdd',
    modelTexts: { 'logic4000.json': LOGIC4000 },
  })
  const { createInProcessSolveEngine } = (await import(
    /* @vite-ignore */ SIMHOST + 'solveEngine'
  )) as {
    createInProcessSolveEngine(): Promise<SolveEngine & { dispose(): Promise<void> }>
  }
  const engine = await createInProcessSolveEngine()
  try {
    return await runSolvePlan(inputs, engine)
  } finally {
    await engine.dispose()
  }
}

describe.skipIf(!haveNgspice)('rail sensing with an output loading its own VDD (real ngspice)', () => {
  it('commits the self-consistent rail, not the pass-1 rail biased by the 12 V output', async () => {
    const result = await solveFixture(true)

    const committed = result.measuredRails.get(VGATED_NET)
    expect(committed).toBeDefined()
    // True fixpoint is 5.0 V (the output sits at the rail, so R4 carries no
    // current). The pass-1 commit was 6.58 V.
    expect(committed!).toBeGreaterThan(4.9)
    expect(committed!).toBeLessThan(5.15)
    expect(result.pass2).toBe('solved')
    // The deck the result reports carries that swing, not the 6.6 V one.
    const deck = result.deck.join('\n')
    expect(deck).not.toContain('12.0000')
    const m = /\? 0 : (\d+\.\d+)/.exec(deck)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThan(5.15)
  }, 90_000)

  it('still solves the unloaded fixture in a single correction', async () => {
    const result = await solveFixture(false)

    expect(result.measuredRails.get(VGATED_NET)).toBeCloseTo(5, 1)
    expect(result.pass2).toBe('solved')
    expect(result.passes).toBe(2) // one correction, then the reconcile sense agrees: no third solve
  }, 90_000)
})
