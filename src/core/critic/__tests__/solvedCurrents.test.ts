/**
 * core/critic/__tests__/solvedCurrents.test.ts
 *
 * deriveSolvedCurrents turns a solve (op values + deck) into signed pad currents
 * for every part, not only LEDs (issues #9 and #45). These tests hand-build the
 * circuit, resolutions, deck and op values so every expected number is exact;
 * src/simhost/__tests__/solvedCurrents.integration.test.ts runs the same derivation on the shipped
 * samples against real ngspice.
 */

import { describe, it, expect } from 'vitest'
import type { Circuit, CircuitNet, Part } from '../../netlist/extract'
import type { Resolution } from '../../models/types'
import { deriveSolvedCurrents, parseSpiceNumber } from '../solvedCurrents'

function net(id: number, name: string, node: string, pads: [string, string][]): CircuitNet {
  return { id, kicadName: name, spiceNode: node, padRefs: pads.map(([ref, pad]) => ({ ref, pad })) }
}
function part(ref: string, pads: Record<string, number>): Part {
  return { ref, value: '', libId: '', layer: 'F', padNet: new Map(Object.entries(pads)), properties: {} }
}
const prim = (ref: string, card: string): Resolution => ({
  ref,
  status: 'ok',
  tier: 2,
  warnings: [],
  model: { kind: 'primitive', card },
})
const sub = (ref: string): Resolution => ({
  ref,
  status: 'ok',
  tier: 3,
  warnings: [],
  model: { kind: 'subckt', libFile: 'x.lib', subcktName: 'X', pinMap: {} },
})

describe('parseSpiceNumber', () => {
  it('reads plain, exponent and suffixed SPICE numbers', () => {
    expect(parseSpiceNumber('10000')).toBe(10000)
    expect(parseSpiceNumber('1e-06')).toBeCloseTo(1e-6, 12)
    expect(parseSpiceNumber('4.7k')).toBeCloseTo(4700, 6)
    expect(parseSpiceNumber('10meg')).toBe(1e7)
    expect(parseSpiceNumber('2m')).toBeCloseTo(2e-3, 12)
    expect(parseSpiceNumber('abc')).toBeNaN()
    expect(parseSpiceNumber(undefined)).toBeNaN()
  })
})

// A 5 V bench supply (0.1 ohm series) feeds VCC. R1 (1k) runs VCC to MID, an
// LED through R2 (330) from MID to GND, and an IC U1 (a subckt, unmeasured) sits
// across VCC and GND and draws the rest. C1 bypasses VCC.
//   I(R1) = 4 mA, which all goes through R2 and the LED (LED 4 mA), plus U1.
// Numbers are chosen so each node voltage is exact:
//   vpsu_int = 5, bench supplies 14 mA: 10 mA into U1, 4 mA into R1.
//   vcc = 5 - 0.1 * 0.014 = 4.9986
//   mid = vcc - 4 mA * 1000 = 0.9986 V
const circuit: Circuit = {
  nets: [
    net(1, 'VCC', 'vcc', [['R1', '1'], ['U1', '8'], ['C1', '1']]),
    net(2, 'GND', '0', [['D1', '1'], ['U1', '4'], ['C1', '2']]),
    net(3, 'MID', 'mid', [['R1', '2'], ['R2', '1']]),
    net(4, 'LEDA', 'leda', [['R2', '2'], ['D1', '2']]),
  ],
  parts: [
    part('R1', { '1': 1, '2': 3 }),
    part('R2', { '1': 3, '2': 4 }),
    part('D1', { '1': 2, '2': 4 }),
    part('U1', { '8': 1, '4': 2 }),
    part('C1', { '1': 1, '2': 2 }),
  ],
  warnings: [],
}
const resolutions: Resolution[] = [
  prim('R1', 'r_r1 vcc mid 1000'),
  prim('R2', 'r_r2 mid leda 330'),
  sub('D1'),
  sub('U1'),
  prim('C1', 'c_c1 vcc 0 1e-07'),
]
const deck = [
  '* deck',
  'vpsu_bench vpsu_bench_int 0 DC 5',
  'rpsu_bench vpsu_bench_int vcc 0.1',
  'r_r1 vcc mid 1000',
  'r_r2 mid leda 330',
  'c_c1 vcc 0 1e-07',
  'x_u1 0 vcc NE555',
  'vsense_d1 leda leda__ledsense_d1 DC 0',
  'd_d1 leda__ledsense_d1 0 LED_RED',
  '.subckt NE555 gnd vcc',
  'rdiv_a vcc gnd 5k',
  '.ends NE555',
  '.save all',
  '.end',
]
const values: Record<string, number> = {
  vpsu_bench_int: 5,
  vcc: 4.9986,
  mid: 0.9986,
  leda: 0.9986 - 0.004 * 330, // a 4 mA current down R2 (not physically consistent with mid, fine)
  'i(vpsu_bench)': -0.014,
  'i(vsense_d1)': 0.004,
}

describe('deriveSolvedCurrents', () => {
  const out = deriveSolvedCurrents({ circuit, resolutions }, { op: { values }, deck })

  it('reads a resistor from its node voltages (Ohm) and a capacitor as zero at DC', () => {
    expect(out.padCurrents.R1['1']).toBeCloseTo((4.9986 - 0.9986) / 1000, 9) // 4 mA out of VCC
    expect(out.padCurrents.R1['2']).toBeCloseTo(-0.004, 9)
    expect(out.padCurrents.C1).toEqual({ '1': 0, '2': 0 })
    expect(out.partCurrents.R1).toBeCloseTo(0.004, 9)
  })

  it('reads an LED from its sense ammeter: anode draws, cathode returns', () => {
    // the vsense line names leda as the anode node
    expect(out.padCurrents.D1['2']).toBeCloseTo(0.004, 9)
    expect(out.padCurrents.D1['1']).toBeCloseTo(-0.004, 9)
  })

  it('gives an unmeasured IC the current KCL leaves on its nets', () => {
    // The bench supplies 14 mA into VCC (from rpsu: (5 - 4.9986) / 0.1). R1 takes
    // 4 mA and C1 none, so U1's VCC pad draws 10 mA and its GND pad returns it.
    expect(out.padCurrents.U1['8']).toBeCloseTo(0.01, 9)
    expect(out.padCurrents.U1['4']).toBeCloseTo(-0.01, 9)
    expect(out.unresolvedRefs).toEqual([])
  })
})

describe('deriveSolvedCurrents: what it cannot resolve', () => {
  it('names two unmeasured parts that share all their nets instead of calling them zero', () => {
    const c: Circuit = {
      nets: [
        net(1, 'VCC', 'vcc', [['U1', '8'], ['U2', '8']]),
        net(2, 'GND', '0', [['U1', '4'], ['U2', '4']]),
      ],
      parts: [part('U1', { '8': 1, '4': 2 }), part('U2', { '8': 1, '4': 2 })],
      warnings: [],
    }
    const res = [sub('U1'), sub('U2')]
    const d = ['* d', 'vpsu_b vpsu_b_int 0 DC 5', 'rpsu_b vpsu_b_int vcc 0.1', 'x_u1 0 vcc A', 'x_u2 0 vcc A', '.end']
    const out = deriveSolvedCurrents(
      { circuit: c, resolutions: res },
      { op: { values: { vpsu_b_int: 5, vcc: 4.99, 'i(vpsu_b)': -0.1 } }, deck: d },
    )
    expect(out.unresolvedRefs).toEqual(['U1', 'U2'])
    expect(out.padCurrents.U1 ?? {}).toEqual({})
    expect(out.partCurrents.U1).toBeUndefined()
  })

  it('does not treat an open stub or a documented-open part as a current carrier', () => {
    const c: Circuit = {
      nets: [net(1, 'VCC', 'vcc', [['J1', '1'], ['U1', '8']]), net(2, 'GND', '0', [['J1', '2'], ['U1', '4']])],
      parts: [part('J1', { '1': 1, '2': 2 }), part('U1', { '8': 1, '4': 2 })],
      warnings: [],
    }
    const res: Resolution[] = [
      { ref: 'J1', status: 'stubbed', tier: 4, warnings: [], model: { kind: 'stub', mode: 'open' } },
      sub('U1'),
    ]
    const d = ['* d', 'vpsu_b vpsu_b_int 0 DC 5', 'rpsu_b vpsu_b_int vcc 0.1', 'x_u1 0 vcc A', '.end']
    const out = deriveSolvedCurrents(
      { circuit: c, resolutions: res },
      { op: { values: { vpsu_b_int: 5, vcc: 4.99, 'i(vpsu_b)': -0.1 } }, deck: d },
    )
    expect(out.unresolvedRefs).toEqual([])
    expect(out.padCurrents.U1['8']).toBeCloseTo(0.1, 9) // all of the bench's 100 mA
    expect(out.padCurrents.J1).toBeUndefined()
  })

  it('leaves a net alone when an element on it cannot be read (a zero-ohm bench resistor)', () => {
    const c: Circuit = {
      nets: [net(1, 'VCC', 'vcc', [['U1', '8']]), net(2, 'GND', '0', [['U1', '4']])],
      parts: [part('U1', { '8': 1, '4': 2 })],
      warnings: [],
    }
    const d = ['* d', 'vpsu_b vpsu_b_int 0 DC 5', 'rpsu_b vpsu_b_int vcc 0', 'x_u1 0 vcc A', '.end']
    const out = deriveSolvedCurrents(
      { circuit: c, resolutions: [sub('U1')] },
      { op: { values: { vpsu_b_int: 5, vcc: 5, 'i(vpsu_b)': -0.1 } }, deck: d },
    )
    expect(out.unresolvedRefs).toEqual(['U1'])
  })
})
