/**
 * src/simhost/__tests__/tvs-smaj24a-deck.integration.test.ts
 *
 * Issue #86: the SMAJ24A TVS forward path used to inherit the 1.16 ohm series
 * resistance that shaped its reverse clamp (1.87 V at 1 A). The card is now a
 * two-branch subcircuit. This drives the REAL deck generator with the real
 * bundled diodes.lib for a TVS that is (a) forward biased by a reverse-polarity
 * input and (b) reverse biased past its breakdown, and solves both in the real
 * libngspice, so the subcircuit path (x_<ref>, positions 1 = anode, 2 = cathode)
 * is covered end to end and not only through the characterization harness.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Resolution } from '../../core/models/types'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import { generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'

const haveNgspice = ngspiceResourcesAvailable()
const DIODES_LIB = readFileSync(join(process.cwd(), 'resources', 'models', 'diodes.lib'), 'utf8')

/**
 * VIN -> R1 -> NODE -> D1 -> GND when anodeAtNode (TVS forward biased from VIN),
 * or VIN -> R1 -> NODE with D1 anode at GND and cathode at NODE (reverse biased).
 */
function build(rOhms: number, anodeAtNode: boolean): { circuit: Circuit; resolutions: Resolution[] } {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
    { id: 2, kicadName: 'NODE', spiceNode: 'node', padRefs: [] },
    { id: 3, kicadName: 'GND', spiceNode: '0', padRefs: [] }
  ]
  const r1: Part = {
    ref: 'R1',
    value: String(rOhms),
    libId: 'Resistor_SMD:R_0805_2012Metric',
    layer: 'F',
    padNet: new Map([
      ['1', 1],
      ['2', 2]
    ]),
    properties: {}
  }
  const d1: Part = {
    ref: 'D1',
    value: 'SMAJ24A',
    libId: 'JLC-MCP:SMA_L4.4-W2.8-LS5.4-R-RD',
    layer: 'F',
    // pinMap {1:'1',2:'2'}: pad 1 = anode, pad 2 = cathode
    padNet: anodeAtNode
      ? new Map([
          ['1', 2],
          ['2', 3]
        ])
      : new Map([
          ['1', 3],
          ['2', 2]
        ]),
    properties: {}
  }
  const resolutions: Resolution[] = [
    {
      ref: 'R1',
      status: 'ok',
      tier: 2,
      warnings: [],
      model: { kind: 'primitive', card: `r_r1 vin node ${rOhms}` }
    },
    {
      ref: 'D1',
      status: 'ok',
      tier: 3,
      warnings: [],
      model: {
        kind: 'subckt',
        libFile: 'diodes.lib',
        subcktName: 'DSMAJ24A',
        pinMap: { '1': '1', '2': '2' }
      }
    }
  ]
  return { circuit: { nets, parts: [r1, d1], warnings: [] }, resolutions }
}

async function solve(volts: number, rOhms: number, anodeAtNode: boolean) {
  const { circuit, resolutions } = build(rOhms, anodeAtNode)
  const deckBody = generateDeck({
    circuit,
    resolutions,
    instruments: [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'dc-supply', id: 'psu1', netId: 1, volts, seriesOhms: 0.01 }
    ] as Instrument[],
    groundNetId: 3,
    modelTexts: { 'diodes.lib': DIODES_LIB },
    title: 'tvs smaj24a'
  })
  const endIdx = deckBody.lastIndexOf('.end')
  const deckLines = [...deckBody.slice(0, endIdx), '.op', '.end']
  const host = new SimHost({ emit: () => {} })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines })
    return { deckBody, values: await host.runOp() }
  } finally {
    await host.dispose()
  }
}

describe.skipIf(!haveNgspice)('SMAJ24A TVS through generateDeck (real libngspice)', () => {
  it('forward biased at about 1 A: about 1 V, not the 1.87 V the clamp resistance gave', async () => {
    const { deckBody, values } = await solve(5, 4, true)
    expect(deckBody.some((l) => /^x_d1\s+node\s+0\s+DSMAJ24A$/.test(l))).toBe(true)
    const current = (values['vin'] - values['node']) / 4
    expect(current).toBeGreaterThan(0.9)
    expect(current).toBeLessThan(1.1)
    expect(values['node']).toBeGreaterThan(0.85)
    expect(values['node']).toBeLessThan(1.25)
  }, 30_000)

  it('reverse biased past breakdown: clamps near VBR, never at the old 1.16 ohm slope', async () => {
    // 35 V through 500 ohm: about 14 mA into the clamp branch.
    const { values } = await solve(35, 500, false)
    expect(values['node']).toBeGreaterThan(26.7)
    expect(values['node']).toBeLessThan(31)
  }, 30_000)

  it('reverse biased at standoff: leaks less than 1 uA at 24 V', async () => {
    const { values } = await solve(24, 1000, false)
    const leakage = (values['vin'] - values['node']) / 1000
    expect(Math.abs(leakage)).toBeLessThan(1e-6)
    expect(values['node']).toBeGreaterThan(23.99)
  }, 30_000)
})
