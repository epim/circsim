/**
 * settleBistableOpAmps driven through a scripted SolveEngine, so every branch
 * (stable, unstable, a re-solve that does not move, a failed probe, an engine
 * error) is reachable without ngspice. The real-ngspice run is
 * src/simhost/__tests__/bistable-settle.integration.test.ts.
 */

import { describe, expect, it } from 'vitest'

import {
  findOpAmpPoles,
  isLinear,
  nodesetLine,
  probeLine,
  probeStep,
  PROBE_SOURCE,
  settleBistableOpAmps,
  withLines,
} from '../bistable'
import type { OpResult, SolveEngine, TranResult } from '../types'

const DECK = ['* test', 'vcc vcc 0 dc 12', 'x1 p in out vcc 0 LM358', '.end']

/** Op values for one opamp_core instance at `xu1.xa` with limits 0.005 V and 10.5 V. */
function pole(vpole: number, instance = 'xu1.xa'): Record<string, number> {
  return {
    [`${instance}.vpole`]: vpole,
    [`${instance}.clo`]: 0.005,
    [`${instance}.chi`]: 10.5,
    [`${instance}.vmid`]: 5.2525,
  }
}

type Reply = OpResult | Error

/** A SolveEngine whose op reply is computed from the deck last loaded. */
function scripted(reply: (deck: string[]) => Reply): SolveEngine & { loads: string[][]; ops: number } {
  let current: string[] = []
  const engine = {
    loads: [] as string[][],
    ops: 0,
    loadCircuit(deck: string[]) {
      engine.loads.push(deck)
      current = deck
      return Promise.resolve()
    },
    runOp() {
      engine.ops += 1
      const r = reply(current)
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
    },
    runTran(): Promise<TranResult> {
      return Promise.reject(new Error('not used'))
    },
  }
  return engine
}

const has = (deck: string[], prefix: string): boolean => deck.some(l => l.startsWith(prefix))

describe('op-amp pole discovery', () => {
  it('finds every opamp_core instance, sorted, and nothing else', () => {
    const values = {
      ...pole(4, 'xu2.xa'),
      ...pole(6, 'xu1.x3.xc'),
      out: 4,
      // The NE555 has comparator nodes named chi and clo but no pole node.
      'xu3.chi': 1,
      'xu3.clo': 0,
      // A pole node without the rest of the core is not ours.
      'xuser.vpole': 3,
    }
    expect(findOpAmpPoles(values)).toEqual([
      { instance: 'xu1.x3.xc', vpole: 6, lo: 0.005, hi: 10.5 },
      { instance: 'xu2.xa', vpole: 4, lo: 0.005, hi: 10.5 },
    ])
  })

  it('reads a pole within 20 mV of a limit, or beyond it, as parked', () => {
    const at = (v: number) => isLinear({ instance: 'x', vpole: v, lo: 0, hi: 10 })
    expect(at(5)).toBe(true)
    expect(at(0.021)).toBe(true)
    expect(at(0.02)).toBe(false)
    expect(at(-0.03)).toBe(false)
    expect(at(9.98)).toBe(false)
    expect(at(10.03)).toBe(false)
  })

  it('probes 10 mV away from the nearer limit', () => {
    expect(probeStep({ instance: 'x', vpole: 2, lo: 0, hi: 10 })).toBe(0.01)
    expect(probeStep({ instance: 'x', vpole: 8, lo: 0, hi: 10 })).toBe(-0.01)
    expect(probeLine({ instance: 'xu1.xa', vpole: 4, lo: 0, hi: 10 }, 0.01)).toBe(
      `${PROBE_SOURCE} xu1.xa.vpole 0 dc 4.010000`,
    )
    expect(nodesetLine('xu1.xa', 0.005)).toBe('.nodeset v(xu1.xa.vpole)=0.005000')
  })

  it('inserts deck lines before the final .end, or appends without one', () => {
    expect(withLines(['a', '.end'], ['x'])).toEqual(['a', 'x', '.end'])
    expect(withLines(['a', '.END '], ['x'])).toEqual(['a', 'x', '.END '])
    expect(withLines(['a'], ['x'])).toEqual(['a', 'x'])
  })
})

describe('settleBistableOpAmps', () => {
  it('runs no probe when no op-amp is in its linear region', async () => {
    const engine = scripted(() => new Error('no solve expected'))
    const op: OpResult = { values: { ...pole(10.52), out: 10.5 }, method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(r.op).toBe(op)
    expect(r.deck).toBe(DECK)
    expect(r.latched).toEqual([])
    expect(engine.loads).toEqual([])
  })

  it('keeps a stable op, then reloads the real deck', async () => {
    // Negative feedback: pinned 10 mV high, the circuit pulls current back out.
    const engine = scripted(() => ({ values: { ...pole(4.01), [`i(${PROBE_SOURCE})`]: -0.01 }, method: 'direct' }))
    const op: OpResult = { values: { ...pole(4), out: 4 }, method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(r.op).toBe(op)
    expect(r.deck).toBe(DECK)
    expect(r.latched).toEqual([])
    expect(engine.loads).toHaveLength(2)
    expect(engine.loads[0]).toContain(`${PROBE_SOURCE} xu1.xa.vpole 0 dc 4.010000`)
    expect(engine.loads[0][engine.loads[0].length - 1]).toBe('.end')
    expect(engine.loads[1]).toBe(DECK)
  })

  it('reads the probe current against the step direction', async () => {
    // Near the high limit the probe steps down; current pulled out is then "with" the step.
    const engine = scripted(deck =>
      has(deck, PROBE_SOURCE)
        ? { values: { ...pole(8.99), [`i(${PROBE_SOURCE})`]: -0.005 }, method: 'direct' }
        : { values: { ...pole(-0.01), out: 0.01 }, method: 'direct' },
    )
    const op: OpResult = { values: { ...pole(9), out: 9 }, method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(engine.loads[0]).toContain(`${PROBE_SOURCE} xu1.xa.vpole 0 dc 8.990000`)
    expect(r.latched).toEqual([{ instance: 'xu1.xa', unstableVolts: 9, settledVolts: -0.01 }])
  })

  it('re-solves an unstable op-amp from its low limit and commits that op', async () => {
    const settledOp: OpResult = { values: { ...pole(-0.016), out: 0.014 }, method: 'direct' }
    const engine = scripted(deck =>
      has(deck, PROBE_SOURCE)
        ? { values: { ...pole(3.996), [`i(${PROBE_SOURCE})`]: 0.0099 }, method: 'direct' }
        : has(deck, '.nodeset')
          ? settledOp
          : new Error('unexpected deck'),
    )
    const op: OpResult = { values: { ...pole(3.986), out: 3.996 }, method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(r.op).toBe(settledOp)
    expect(r.deck).toEqual(['* test', 'vcc vcc 0 dc 12', 'x1 p in out vcc 0 LM358', '.nodeset v(xu1.xa.vpole)=0.005000', '.end'])
    expect(r.latched).toEqual([{ instance: 'xu1.xa', unstableVolts: 3.986, settledVolts: -0.016 }])
    // probe, re-solve; nothing linear is left, and the engine already holds r.deck.
    expect(engine.loads).toHaveLength(2)
    expect(engine.loads[1]).toBe(r.deck)
  })

  it('falls back to the high limit when Newton returns from the low one', async () => {
    const engine = scripted(deck => {
      if (has(deck, PROBE_SOURCE)) return { values: { ...pole(5.01), [`i(${PROBE_SOURCE})`]: 0.004 }, method: 'direct' }
      if (deck.includes('.nodeset v(xu1.xa.vpole)=0.005000')) return { values: { ...pole(5) }, method: 'gmin' }
      if (deck.includes('.nodeset v(xu1.xa.vpole)=10.500000')) return { values: { ...pole(10.51) }, method: 'direct' }
      return new Error('unexpected deck')
    })
    const op: OpResult = { values: { ...pole(5) }, method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(r.op.values['xu1.xa.vpole']).toBe(10.51)
    expect(r.deck).toContain('.nodeset v(xu1.xa.vpole)=10.500000')
    expect(r.latched).toEqual([{ instance: 'xu1.xa', unstableVolts: 5, settledVolts: 10.51 }])
  })

  it('keeps the op and reports the op-amp unsettled when no re-solve moves it', async () => {
    const engine = scripted(deck =>
      has(deck, PROBE_SOURCE)
        ? { values: { ...pole(5.01), [`i(${PROBE_SOURCE})`]: 0.004 }, method: 'direct' }
        : { values: { ...pole(5.001) }, method: 'gmin' },
    )
    const op: OpResult = { values: { ...pole(5) }, method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(r.op).toBe(op)
    expect(r.deck).toBe(DECK)
    expect(r.latched).toEqual([{ instance: 'xu1.xa', unstableVolts: 5, settledVolts: null }])
    // probe, low re-solve, high re-solve, then the real deck again; never probed twice.
    expect(engine.loads).toHaveLength(4)
    expect(engine.loads[3]).toBe(DECK)
  })

  it('settles one op-amp at a time and probes the rest again on the new op', async () => {
    // Two coupled stages: once xu1 settles low, xu2 is driven to its high limit.
    const both = (a: number, b: number) => ({ ...pole(a, 'xu1.xa'), ...pole(b, 'xu2.xa') })
    const engine = scripted(deck => {
      if (has(deck, PROBE_SOURCE)) return { values: { ...both(6, 6), [`i(${PROBE_SOURCE})`]: -0.0097 }, method: 'direct' }
      if (deck.includes('.nodeset v(xu1.xa.vpole)=0.005000')) return { values: both(0.003, 10.49), method: 'direct' }
      return new Error('unexpected deck')
    })
    const op: OpResult = { values: both(6, 6), method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(r.latched).toEqual([{ instance: 'xu1.xa', unstableVolts: 6, settledVolts: 0.003 }])
    expect(r.op.values['xu2.xa.vpole']).toBe(10.49)
    expect(r.deck.filter(l => l.startsWith('.nodeset'))).toEqual(['.nodeset v(xu1.xa.vpole)=0.005000'])
    // One probe (xu1, unstable), one re-solve; xu2 is parked on the new op, so not probed.
    expect(engine.loads).toHaveLength(2)
  })

  it('treats a probe that did not converge as no evidence', async () => {
    const engine = scripted(() => ({ values: { ...pole(4), [`i(${PROBE_SOURCE})`]: 1 }, method: 'failed' }))
    const op: OpResult = { values: pole(4), method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(r.op).toBe(op)
    expect(r.latched).toEqual([])
  })

  it('never throws: an engine error keeps the best op so far', async () => {
    const engine = scripted(() => new Error('op timed out'))
    const op: OpResult = { values: pole(4), method: 'direct' }

    const r = await settleBistableOpAmps(engine, DECK, op)

    expect(r.op).toBe(op)
    expect(r.deck).toBe(DECK)
    expect(engine.loads[engine.loads.length - 1]).toBe(DECK)
  })
})
