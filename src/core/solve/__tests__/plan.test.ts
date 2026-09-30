/**
 * runSolvePlan: the two-pass operating-point plan (issue #53), driven through a
 * scripted SolveEngine so every branch of the loop is reachable without the
 * renderer store or ngspice. The real-ngspice run of the same plan lives in
 * src/simhost/__tests__/rail-sensing.integration.test.ts.
 */

import { describe, expect, it } from 'vitest'

import { buildDeck, buildSolveInputs } from '../inputs'
import { MAX_SOLVE_PASSES, mapOpResultToNetVoltages, runSolvePlan, SolveFailedError } from '../plan'
import type { OpResult, SolveEngine, SolveInputs, TranResult } from '../types'
import {
  GROUND_NET,
  LOGIC4000,
  SWING_12V,
  SWING_5V,
  VGATED_NET,
  switchedRailFixture,
} from './switchedRail.fixture'

type Call = { kind: 'load'; deck: string[] } | { kind: 'op' }

/**
 * A SolveEngine whose op replies are scripted per pass (1-based). A reply of
 * `Error` rejects that pass. Calls are recorded synchronously, in call order.
 */
function scriptedEngine(reply: (pass: number) => OpResult | Error): SolveEngine & { calls: Call[] } {
  const calls: Call[] = []
  let pass = 0
  return {
    calls,
    loadCircuit(deckLines) {
      calls.push({ kind: 'load', deck: deckLines })
      return Promise.resolve()
    },
    runOp() {
      calls.push({ kind: 'op' })
      pass += 1
      const r = reply(pass)
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
    },
    runTran(): Promise<TranResult> {
      return Promise.reject(new Error('not used'))
    },
  }
}

function inputs(extra: Parameters<typeof buildSolveInputs>[5] = {}, supplyV = 12): SolveInputs {
  const f = switchedRailFixture(supplyV)
  return buildSolveInputs(null, f.circuit, f.resolutions, f.instruments, f.groundNetId, {
    title: 'plan-test',
    modelTexts: { 'logic4000.json': LOGIC4000 },
    ...extra,
  })
}

const text = (deck: string[] | undefined): string => (deck ?? []).join('\n')

describe('runSolvePlan: two-pass rail sensing', () => {
  it('re-solves once with the measured rail when it changes the deck', async () => {
    const engine = scriptedEngine(pass =>
      pass === 1
        ? { values: { vin: 12, vgated: 5, in: 0, out: 5 }, method: 'direct' }
        : { values: { vin: 12, vgated: 5, in: 0, out: 4.9 }, method: 'direct' },
    )

    const result = await runSolvePlan(inputs(), engine)

    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op', 'load', 'op'])
    expect(text(result.pass1Deck)).toContain(SWING_12V)
    expect(text(result.pass2Deck)).toContain(SWING_5V)
    expect(result.pass2).toBe('solved')
    // The committed op, and the deck that produced it, are pass 2's.
    expect(result.deck).toBe(result.pass2Deck)
    expect(result.op.values.out).toBe(4.9)
    expect(result.measuredRails.get(VGATED_NET)).toBeCloseTo(5)
    expect(result.gatedOff).toEqual([])
    // The engine was handed exactly the decks the result reports.
    expect((engine.calls[0] as { deck: string[] }).deck).toBe(result.pass1Deck)
    expect((engine.calls[2] as { deck: string[] }).deck).toBe(result.pass2Deck)
  })

  it('skips pass 2 when the measured rail equals the family default', async () => {
    const engine = scriptedEngine(() => ({ values: { vin: 12, vgated: 12, out: 0 } }))

    const result = await runSolvePlan(inputs(), engine)

    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op'])
    expect(result.pass2).toBe('not-needed')
    expect(result.pass2Deck).toBeUndefined()
    expect(result.deck).toBe(result.pass1Deck)
    // Still sensed, so a later transient deck can reuse it.
    expect(result.measuredRails.get(VGATED_NET)).toBeCloseTo(12)
  })

  it('reports a gated-off rail and keeps the family default', async () => {
    const engine = scriptedEngine(() => ({ values: { vin: 0, vgated: 0, out: 0 } }))

    const result = await runSolvePlan(inputs({}, 0), engine)

    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op'])
    expect(result.measuredRails.has(VGATED_NET)).toBe(false)
    expect(result.gatedOff).toEqual([{ ref: 'U1', netId: VGATED_NET, kicadName: '/VGATED' }])
    expect(text(result.deck)).toContain(SWING_12V)
  })

  it('does not sense a rail that a manual override owns', async () => {
    const engine = scriptedEngine(() => ({ values: { vin: 12, vgated: 5, out: 0 } }))

    const result = await runSolvePlan(
      inputs({ railOverrides: new Map([['/VGATED', 3.3]]) }),
      engine,
    )

    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op'])
    expect(result.measuredRails.size).toBe(0)
    expect(text(result.deck)).toContain('* U1 vhigh: 3.3 (user rail override; family default 12)')
  })

  it('keeps the pass-1 op when pass 2 fails', async () => {
    const engine = scriptedEngine(pass =>
      pass === 1 ? { values: { vin: 12, vgated: 5, out: 2.5 } } : new Error('op timed out'),
    )

    const result = await runSolvePlan(inputs(), engine)

    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op', 'load', 'op'])
    expect(result.pass2).toBe('failed')
    expect(result.op.values.out).toBe(2.5)
    // The deck that produced the committed op is pass 1's, even though pass 2's was attempted.
    expect(result.deck).toBe(result.pass1Deck)
    expect(text(result.pass2Deck)).toContain(SWING_5V)
    expect(result.measuredRails.get(VGATED_NET)).toBeCloseTo(5)
  })

  it('rejects with SolveFailedError when pass 1 fails', async () => {
    const cause = new Error('op timed out')
    const engine = scriptedEngine(() => cause)

    const err = await runSolvePlan(inputs(), engine).catch(e => e)

    expect(err).toBeInstanceOf(SolveFailedError)
    expect((err as SolveFailedError).cause).toBe(cause)
    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op'])
  })

  it('solves pass 1 on the family-default baseline even with cached measured rails', async () => {
    // A cached tier-3 rail from an earlier solve must not leak into pass 1: the
    // pass-2 trigger is a deck diff against the family-default baseline.
    const engine = scriptedEngine(() => ({ values: { vin: 12, vgated: 5, out: 0 } }))
    const withCache = inputs({ measuredRails: new Map([[VGATED_NET, 5]]) })
    expect(text(buildDeck(withCache))).toContain(SWING_5V) // the cache does reach buildDeck

    const result = await runSolvePlan(withCache, engine)

    expect(text(result.pass1Deck)).toContain(SWING_12V)
    expect(result.pass2).toBe('solved')
  })

  it('issues the pass-1 load and op in the same synchronous turn', () => {
    // The live bench shares one event channel between its store listener and the
    // op reply, so the reply listener must be armed before control returns.
    const engine = scriptedEngine(() => ({ values: { vgated: 12 } }))

    const pending = runSolvePlan(inputs(), engine)

    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op'])
    return pending
  })

  it('maps the committed op onto net ids', async () => {
    const engine = scriptedEngine(() => ({ values: { vin: 12, vgated: 12, in: 0.1, out: 11.9, 'i(vpsu_bench)': -0.001 } }))

    const result = await runSolvePlan(inputs(), engine)

    expect(result.netVoltages.get(1)).toBe(12)
    expect(result.netVoltages.get(4)).toBe(11.9)
    expect(result.netVoltages.get(GROUND_NET)).toBe(0) // ground reads 0 even when ngspice omits node 0
    expect([...result.netVoltages.keys()].sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe('runSolvePlan: reconciling a rail that an output biases (issue #44)', () => {
  /** An op whose /VGATED reads `rail` (the fixture's divider, plus whatever the loaded output adds). */
  const at = (rail: number): OpResult => ({ values: { vin: 12, vgated: rail, in: 0, out: rail }, method: 'direct' })
  const swing = (rail: number): string => `? 0 : ${rail.toFixed(4)}`

  it('re-senses and re-solves until the sensed rail agrees with the rail the deck used', async () => {
    // The rail walks 6.6 -> 5.4 -> 5.06 -> 5.0 as each deck swings at the previous sensed rail.
    const ops = [6.6, 5.4, 5.06, 5.0]
    const engine = scriptedEngine(pass => at(ops[pass - 1]))

    const result = await runSolvePlan(inputs(), engine)

    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op', 'load', 'op', 'load', 'op', 'load', 'op'])
    expect(result.passes).toBe(4)
    expect(text(result.pass1Deck)).toContain(SWING_12V)
    // Pass 2 swung at 6.6, pass 3 at 5.4, pass 4 at 5.06; the committed deck is pass 4's.
    expect(text((engine.calls[2] as { deck: string[] }).deck)).toContain(swing(6.6))
    expect(text((engine.calls[4] as { deck: string[] }).deck)).toContain(swing(5.4))
    expect(result.deck).toBe(result.pass2Deck)
    expect(text(result.deck)).toContain(swing(5.06))
    expect(result.measuredRails.get(VGATED_NET)).toBeCloseTo(5.06)
    expect(result.op.values.vgated).toBe(5.0)
    expect(result.pass2).toBe('solved')
  })

  it('stops at the solve cap when the rail keeps moving', async () => {
    let rail = 10
    const engine = scriptedEngine(() => at((rail -= 1)))

    const result = await runSolvePlan(inputs(), engine)

    expect(result.passes).toBe(MAX_SOLVE_PASSES)
    expect(engine.calls.filter(c => c.kind === 'op')).toHaveLength(MAX_SOLVE_PASSES)
  })

  it('stops when the sensed rail is within tolerance of the rail the deck used', async () => {
    // Pass 2 swung at 5.0; it re-senses 5.05, which is 1%: settled, no third solve.
    const engine = scriptedEngine(pass => at(pass === 1 ? 5 : 5.05))

    const result = await runSolvePlan(inputs(), engine)

    expect(result.passes).toBe(2)
    expect(text(result.deck)).toContain(swing(5))
  })

  it('keeps the last landed op and deck when a later reconcile pass fails', async () => {
    const engine = scriptedEngine(pass => {
      if (pass === 1) return at(6.6)
      if (pass === 2) return at(5.4)
      return new Error('op timed out')
    })

    const result = await runSolvePlan(inputs(), engine)

    expect(result.passes).toBe(3)
    expect(result.pass2).toBe('solved')
    expect(result.op.values.vgated).toBe(5.4)
    expect(text(result.deck)).toContain(swing(6.6))
    expect(result.deck).toBe(result.pass2Deck)
    // The committed deck used 6.6, so that is the rail a transient deck must reuse.
    expect(result.measuredRails.get(VGATED_NET)).toBeCloseTo(6.6)
  })

  it('treats a pass whose op reports method failed as failed', async () => {
    const engine = scriptedEngine(pass => (pass === 1 ? at(6.6) : { values: { vgated: 1 }, method: 'failed' }))

    const result = await runSolvePlan(inputs(), engine)

    expect(result.pass2).toBe('failed')
    expect(result.deck).toBe(result.pass1Deck)
    expect(result.op.values.vgated).toBe(6.6)
  })

  it('senses no rail from a failed pass 1 op', async () => {
    // A failed op still carries values; a plausible-looking non-zero rail read off
    // them would otherwise become the chip's swing with nothing said about it.
    const engine = scriptedEngine(() => ({ values: { vin: 12, vgated: 6.6, out: 12 }, method: 'failed' }))

    const result = await runSolvePlan(inputs(), engine)

    expect(engine.calls.map(c => c.kind)).toEqual(['load', 'op'])
    expect(result.measuredRails.size).toBe(0)
    expect(result.gatedOff).toEqual([])
    expect(result.passes).toBe(1)
    expect(text(result.deck)).toContain(SWING_12V)
  })

  it.each(['gmin', 'source', 'tran-fallback'] as const)(
    'still senses a rail from a %s op, which is the normal outcome on some boards',
    async method => {
      const engine = scriptedEngine(pass => ({ values: { vin: 12, vgated: 5, out: 5 }, method: pass === 1 ? method : 'direct' }))

      const result = await runSolvePlan(inputs(), engine)

      expect(result.measuredRails.get(VGATED_NET)).toBeCloseTo(5)
      expect(result.pass2).toBe('solved')
    },
  )
})

describe('mapOpResultToNetVoltages', () => {
  it('skips currents and unknown nodes', () => {
    const { circuit } = switchedRailFixture()
    const v = mapOpResultToNetVoltages({ vin: 5, 'i(v1)': 1, nowhere: 3 }, circuit)
    expect([...v.entries()].sort()).toEqual([[1, 5], [GROUND_NET, 0]])
  })
})
