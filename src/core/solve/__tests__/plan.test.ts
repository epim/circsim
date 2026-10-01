/**
 * runSolvePlan: the two-pass operating-point plan (issue #53), driven through a
 * scripted SolveEngine so every branch of the loop is reachable without the
 * renderer store or ngspice. The real-ngspice run of the same plan lives in
 * src/simhost/__tests__/rail-sensing.integration.test.ts.
 */

import { describe, expect, it } from 'vitest'

import { buildDeck, buildSolveInputs } from '../inputs'
import { mapOpResultToNetVoltages, runSolvePlan, SolveFailedError } from '../plan'
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

  it('settles an op-amp left balanced mid-rail before sensing rails, on both passes', async () => {
    // xu9 is a Schmitt inside its band: the bare op balances it at 4 V and reads
    // /VGATED at the family default; its power-up (low) state switches the rail
    // to 5 V. Sensing must read the settled op, so pass 2 runs with 5 V.
    const pole = (v: number) => ({ 'xu9.xa.vpole': v, 'xu9.xa.clo': 0.005, 'xu9.xa.chi': 10.5, 'xu9.xa.vmid': 5.25 })
    let current: string[] = []
    const engine: SolveEngine = {
      loadCircuit(deck) {
        current = deck
        return Promise.resolve()
      },
      runOp() {
        const t = text(current)
        if (t.includes('vcircsim_probe')) {
          return Promise.resolve({ values: { ...pole(4.01), 'i(vcircsim_probe)': 0.01 }, method: 'direct' })
        }
        if (t.includes('.nodeset')) {
          return Promise.resolve({ values: { vin: 12, vgated: 5, out: 0.01, ...pole(-0.01) }, method: 'direct' })
        }
        return Promise.resolve({ values: { vin: 12, vgated: 12, out: 4, ...pole(4) }, method: 'direct' })
      },
      runTran: () => Promise.reject(new Error('not used')),
    }

    const result = await runSolvePlan(inputs(), engine)

    expect(result.measuredRails.get(VGATED_NET)).toBeCloseTo(5)
    expect(result.pass2).toBe('solved')
    expect(text(result.deck)).toContain(SWING_5V)
    expect(text(result.deck)).toContain('.nodeset v(xu9.xa.vpole)=0.005000')
    expect(text(result.pass1Deck)).not.toContain('.nodeset')
    expect(result.op.values.out).toBe(0.01)
    expect(result.latched).toEqual([{ instance: 'xu9.xa', unstableVolts: 4, settledVolts: -0.01 }])
  })

  it('reports no latched op-amps on a board without any', async () => {
    const engine = scriptedEngine(() => ({ values: { vin: 12, vgated: 12, out: 0 } }))
    expect((await runSolvePlan(inputs(), engine)).latched).toEqual([])
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

describe('runSolvePlan: undriven islands (issue #43)', () => {
  /** The switched-rail fixture with R3 removed: IN reaches only U1's sense-only input pad. */
  function undrivenInputInputs(): SolveInputs {
    const f = switchedRailFixture()
    const resolutions = f.resolutions.filter(r => r.ref !== 'R3')
    const circuit = { ...f.circuit, parts: f.circuit.parts.filter(p => p.ref !== 'R3') }
    return buildSolveInputs(null, circuit, resolutions, f.instruments, f.groundNetId, {
      title: 'plan-test',
      modelTexts: { 'logic4000.json': LOGIC4000 },
    })
  }

  const okOp = (): OpResult => ({ values: { vin: 12, vgated: 5, in: 0, out: 5 }, method: 'direct' })

  it('reports a net with no path to ground, by KiCad name, with its bleed', async () => {
    const engine = scriptedEngine(() => okOp())
    const result = await runSolvePlan(undrivenInputInputs(), engine)

    expect(result.undrivenNets).toEqual([{ netId: 3, kicadName: 'IN', spiceNode: 'in' }])
    // The deck really bled it, so the 0 V reading is a bleed and not a measurement.
    expect(text(result.deck)).toContain('r_float_1 in 0 1e9')
  })

  it('reports nothing when every net has a path to ground', async () => {
    const engine = scriptedEngine(() => okOp())
    const result = await runSolvePlan(inputs(), engine)
    expect(result.undrivenNets).toEqual([])
  })

  it('reports the islands of the deck that produced the committed op', async () => {
    const engine = scriptedEngine(pass => (pass === 1 ? okOp() : { ...okOp(), values: { ...okOp().values, out: 4.9 } }))
    const result = await runSolvePlan(undrivenInputInputs(), engine)
    expect(result.pass2).toBe('solved')
    expect(result.undrivenNets.map(n => n.kicadName)).toEqual(['IN'])
  })
})

describe('mapOpResultToNetVoltages', () => {
  it('skips currents and unknown nodes', () => {
    const { circuit } = switchedRailFixture()
    const v = mapOpResultToNetVoltages({ vin: 5, 'i(v1)': 1, nowhere: 3 }, circuit)
    expect([...v.entries()].sort()).toEqual([[1, 5], [GROUND_NET, 0]])
  })
})
