/**
 * src/simhost/__tests__/bistable-settle.integration.test.ts
 *
 * settleBistableOpAmps (src/core/solve/bistable.ts) against the REAL bundled
 * ngspice and the shipped op-amp library, both directly on hand-written decks
 * and through runSolvePlan on a generated deck. An op-amp Schmitt trigger with
 * its input inside the hysteresis band
 * has three DC solutions, and ngspice's direct op lands on the unstable middle
 * one (a mid-rail output). The settled op must sit on a rail, at the state the
 * live bench's power-up run (a `uic` transient from 0 V) settles to, while every
 * negative-feedback circuit keeps the op it had, untouched.
 *
 * One engine for the whole file (libngspice is process-global; vitest forks
 * isolate files). Skipped when resources/ngspice/<platform> is missing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Resolution } from '../../core/models/types'
import type { CircuitNet, Part } from '../../core/netlist/extract'
import { settleBistableOpAmps } from '../../core/solve/bistable'
import { buildDeck, buildSolveInputs } from '../../core/solve/inputs'
import { runSolvePlan } from '../../core/solve/plan'
import type { OpResult, SolveEngine } from '../../core/solve/types'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { createInProcessSolveEngine, type InProcessSolveEngine } from '../solveEngine'

const haveNgspice = ngspiceResourcesAvailable()
const OPAMP_LIB = haveNgspice
  ? readFileSync(join(process.cwd(), 'resources', 'models', 'opamp.lib'), 'utf8')
  : ''

/** The engine, recording every deck it is handed. */
function recording(engine: SolveEngine): SolveEngine & { loads: string[][] } {
  const loads: string[][] = []
  return {
    loads,
    loadCircuit(deck) {
      loads.push(deck)
      return engine.loadCircuit(deck)
    },
    runOp: () => engine.runOp(),
    runTran: (tstep, tstop) => engine.runTran(tstep, tstop),
  }
}

function deckOf(name: string, body: string[]): string[] {
  return [`* ${name}`, ...body, ...OPAMP_LIB.split(/\r?\n/), '.end']
}

// LM358 inverting Schmitt on 12 V: input on -IN, 10k/10k positive feedback from
// the output to a 6 V reference on +IN. The band is 3 V to 8.25 V.
const invSchmitt = (vin: number): string[] => [
  'vcc vcc 0 dc 12', 'vref ref 0 dc 6', `vin in 0 dc ${vin}`, 'r1 ref p 10k', 'r2 p out 10k', 'x1 p in out vcc 0 LM358',
]

const LATCHES: Array<{ name: string; body: string[]; out: number }> = [
  { name: 'LM358 inverting Schmitt, input 5 V (inside the 3 V to 8.25 V band)', body: invSchmitt(5), out: 0.014 },
  {
    name: 'LM358 non-inverting Schmitt, input at the band centre',
    body: ['vcc vcc 0 dc 12', 'vref ref 0 dc 6', 'vin in 0 dc 6', 'r1 in p 10k', 'r2 p out 10k', 'x1 p ref out vcc 0 LM358'],
    out: 0.014,
  },
  {
    name: 'thermostat shape: reference divided from the supply, 10k/100k hysteresis',
    body: ['vcc vcc 0 dc 12', 'ra vcc ref 10k', 'rb ref 0 10k', 'vin in 0 dc 5.5', 'r1 ref p 10k', 'r2 p out 100k', 'x1 p in out vcc 0 LM358'],
    out: 0.008,
  },
  {
    name: 'narrow hysteresis (1k/1M), input at the band centre',
    body: ['vcc vcc 0 dc 12', 'vref ref 0 dc 6', 'vin in 0 dc 6', 'r1 ref p 1k', 'r2 p out 1meg', 'x1 p in out vcc 0 LM358'],
    out: -0.023,
  },
  {
    name: 'TL072 inverting Schmitt on a +/-12 V split supply',
    body: ['vcc vcc 0 dc 12', 'vee vee 0 dc -12', 'vin in 0 dc 0.5', 'r1 0 p 10k', 'r2 p out 10k', 'x1 p in out vcc vee TL072'],
    out: -10.44,
  },
]

let ngspice: InProcessSolveEngine

beforeAll(async () => {
  if (haveNgspice) ngspice = await createInProcessSolveEngine()
}, 60_000)

afterAll(async () => {
  await ngspice?.dispose()
})

describe.skipIf(!haveNgspice)('settleBistableOpAmps (real ngspice)', () => {
  async function rawOp(engine: SolveEngine, deck: string[]): Promise<OpResult> {
    await engine.loadCircuit(deck)
    return engine.runOp()
  }

  for (const c of LATCHES) {
    it(`${c.name}: moves the unstable mid-rail op to the power-up rail`, async () => {
      const deck = deckOf(c.name, c.body)
      const engine = recording(ngspice)
      const raw = await rawOp(engine, deck)
      const [pole] = Object.keys(raw.values).filter(k => k.endsWith('.vpole'))
      const instance = pole.slice(0, -'.vpole'.length)
      // The reproduction: a direct op with the output between the rails.
      expect(raw.method).toBe('direct')
      expect(raw.values[pole]).toBeGreaterThan(raw.values[`${instance}.clo`] + 0.5)
      expect(raw.values[pole]).toBeLessThan(raw.values[`${instance}.chi`] - 0.5)

      const settled = await settleBistableOpAmps(engine, deck, raw)

      expect(settled.op.method).toBe('direct')
      expect(Math.abs(settled.op.values.out - c.out), `out=${settled.op.values.out}`).toBeLessThan(0.02)
      expect(settled.latched).toEqual([
        { instance, unstableVolts: raw.values[pole], settledVolts: settled.op.values[pole] },
      ])
      expect(settled.deck.some(l => l.startsWith(`.nodeset v(${instance}.vpole)=`))).toBe(true)
      // The engine is left holding the deck that produced the committed op.
      expect(engine.loads[engine.loads.length - 1]).toBe(settled.deck)

      // Energize agrees with Run: the bench's power-up transient settles there too.
      await engine.loadCircuit(deck)
      const tran = await engine.runTran(1e-6, 2e-3)
      const benchOut = tran.vectors.out[tran.vectors.out.length - 1]
      expect(Math.abs(benchOut - settled.op.values.out)).toBeLessThan(0.02)
    }, 60_000)
  }

  it('a two-op-amp ring of inverting stages (a latch through both) is settled too', async () => {
    // Each stage alone has negative feedback (gain -2 about 6 V); round the ring
    // the loop gain is +4, so the all-6 V point is unstable.
    const deck = deckOf('ring latch', [
      'vcc vcc 0 dc 12', 'vb b 0 dc 6',
      'ra1 outb na 10k', 'rf1 na outa 20k', 'x1 b na outa vcc 0 LM358',
      'ra2 outa nb 10k', 'rf2 nb outb 20k', 'x2 b nb outb vcc 0 LM358',
    ])
    const engine = recording(ngspice)
    const raw = await rawOp(engine, deck)
    expect(Math.abs(raw.values.outa - raw.values.outb)).toBeLessThan(0.5) // both balanced mid-rail

    const settled = await settleBistableOpAmps(engine, deck, raw)

    const { outa, outb } = settled.op.values
    expect(settled.latched.length).toBeGreaterThan(0)
    expect(Math.min(outa, outb)).toBeLessThan(0.1)
    expect(Math.max(outa, outb)).toBeGreaterThan(10)
  }, 60_000)

  for (const [name, vin, want] of [
    ['below the band', 2, 10.52],
    ['above the band', 9, 0.014],
  ] as const) {
    it(`a Schmitt with its input ${name} is left alone, with no probe solves`, async () => {
      const deck = deckOf(name, invSchmitt(vin))
      const engine = recording(ngspice)
      const raw = await rawOp(engine, deck)
      const settled = await settleBistableOpAmps(engine, deck, raw)
      expect(settled.op).toBe(raw)
      expect(settled.deck).toBe(deck)
      expect(settled.latched).toEqual([])
      expect(engine.loads).toEqual([deck])
      expect(Math.abs(settled.op.values.out - want)).toBeLessThan(0.02)
    }, 60_000)
  }

  const STABLE: Array<{ name: string; body: string[] }> = [
    { name: 'LM358 follower', body: ['vcc vcc 0 dc 12', 'vin in 0 dc 4.2', 'x1 in out out vcc 0 LM358'] },
    { name: 'LM358 follower into 100 ohm', body: ['vcc vcc 0 dc 12', 'vin in 0 dc 4', 'x1 in out out vcc 0 LM358', 'rl out 0 100'] },
    { name: 'non-inverting gain of 2', body: ['vcc vcc 0 dc 12', 'vin in 0 dc 1', 'x1 in fb out vcc 0 LM358', 'rf out fb 10k', 'rg fb 0 10k'] },
    {
      name: 'inverting gain of -2 about 6 V',
      body: ['vcc vcc 0 dc 12', 'vb b 0 dc 6', 'vin in 0 dc 5', 'x1 b fb out vcc 0 LM358', 'r1 in fb 10k', 'rf fb out 20k'],
    },
    { name: 'TL072 split-supply follower', body: ['vcc vcc 0 dc 12', 'vee vee 0 dc -12', 'vin in 0 dc -3', 'x1 in out out vcc vee TL072'] },
    {
      // Positive feedback with a loop gain below 1 has one solution and it is stable.
      name: 'gain stage with weak positive feedback alongside the negative',
      body: ['vcc vcc 0 dc 12', 'vin in 0 dc 2', 'x1 p fb out vcc 0 LM358', 'rin in p 10k', 'rpf out p 1meg', 'rf out fb 10k', 'rg fb 0 10k'],
    },
  ]

  for (const c of STABLE) {
    it(`${c.name}: probed, found stable, op and deck untouched`, async () => {
      const deck = deckOf(c.name, c.body)
      const engine = recording(ngspice)
      const raw = await rawOp(engine, deck)
      const settled = await settleBistableOpAmps(engine, deck, raw)
      expect(settled.op).toBe(raw)
      expect(settled.deck).toBe(deck)
      expect(settled.latched).toEqual([])
      expect(engine.loads.length).toBeGreaterThan(1) // it did probe
      expect(engine.loads[engine.loads.length - 1]).toBe(deck) // and reloaded the real deck after
    }, 60_000)
  }
})

// ─── through the production plan, on a generated deck ─────────────────────────

/**
 * A thermostat-style comparator board: an LM358 inverting Schmitt on a 12 V
 * bench supply, its reference divided from the supply, its input set by a
 * divider inside the hysteresis band.
 */
function thermostatInputs(): Parameters<typeof runSolvePlan>[0] {
  const net = (id: number, name: string, node: string): CircuitNet => ({ id, kicadName: name, spiceNode: node, padRefs: [] })
  const nets: CircuitNet[] = [
    net(1, 'VCC', 'vcc'), net(2, 'REF', 'ref'), net(3, 'P', 'p'), net(4, 'IN', 'in'), net(5, 'OUT', 'out'), net(6, 'GND', '0'),
  ]
  const r = (ref: string, a: number, b: number): Part => ({
    ref, value: '', libId: 'R', layer: 'F', padNet: new Map([['1', a], ['2', b]]), properties: {},
  })
  const parts: Part[] = [
    {
      ref: 'U1', value: 'LM358', libId: 'Amplifier_Operational:LM358', layer: 'F',
      padNet: new Map([['3', 3], ['2', 4], ['1', 5], ['8', 1], ['4', 6]]), properties: {},
    },
    r('R1', 1, 2), r('R2', 2, 6), r('R3', 2, 3), r('R4', 3, 5), r('R5', 1, 4), r('R6', 4, 6), r('R7', 5, 1),
  ]
  const card = (ref: string, a: string, b: string, ohms: number): Resolution => ({
    ref, status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: `r_${ref.toLowerCase()} ${a} ${b} ${ohms}` },
  })
  const resolutions: Resolution[] = [
    {
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'subckt', libFile: 'opamp.lib', subcktName: 'LM358',
        pinMap: { '3': 'inp', '2': 'inn', '1': 'out', '8': 'vcc', '4': 'vee' },
      },
    },
    card('R1', 'vcc', 'ref', 10_000), card('R2', 'ref', '0', 10_000),
    card('R3', 'ref', 'p', 10_000), card('R4', 'p', 'out', 100_000),
    card('R5', 'vcc', 'in', 13_000), card('R6', 'in', '0', 11_000), // 5.5 V
    card('R7', 'out', 'vcc', 47_000), // a pull-up load on the output
  ]
  return buildSolveInputs(
    null,
    { nets, parts, warnings: [] },
    resolutions,
    [
      { kind: 'ground-ref', netId: 6 },
      { kind: 'dc-supply', id: 'bench', netId: 1, volts: 12, seriesOhms: 0.1 },
    ],
    6,
    { title: 'thermostat', modelTexts: { 'opamp.lib': OPAMP_LIB } },
  )
}

describe.skipIf(!haveNgspice)('runSolvePlan settles a latched comparator board (real ngspice)', () => {
  it('Energize reads the comparator output at a rail, not mid-rail', async () => {
    const inputs = thermostatInputs()

    // The bare pass-1 op is the reproduction: the output balanced between the rails.
    await ngspice.loadCircuit(buildDeck(inputs))
    const raw = await ngspice.runOp()
    expect(raw.values.out).toBeGreaterThan(1)
    expect(raw.values.out).toBeLessThan(9)

    const result = await runSolvePlan(inputs, ngspice)

    expect(result.op.method).toBe('direct')
    expect(result.netVoltages.get(5)).toBeLessThan(0.1)
    expect(result.latched.map(l => l.instance)).toEqual([expect.stringMatching(/u1\.xa$/)])
    expect(result.latched[0].settledVolts).not.toBeNull()
    expect(result.deck.some(l => l.startsWith('.nodeset '))).toBe(true)
    expect(result.pass1Deck.some(l => l.startsWith('.nodeset '))).toBe(false)
  }, 60_000)
})
