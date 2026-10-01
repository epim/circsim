/**
 * Shared fixture for the solve-seam unit tests: a CD40106 whose VDD pad sits on
 * `/VGATED` (net 2), the mid-point of a divider from a bench supply on VIN
 * (net 1). No supply sits directly on the VDD net, so tier 1 cannot own the
 * chip and pass 1 falls back to the CD4000 family default (12 V). The same
 * topology as src/simhost/__tests__/rail-sensing.integration.test.ts, fed with
 * the real bundled logic4000.json so deck text assertions match the shipped
 * family numbers.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Resolution } from '../../models/types'
import type { Circuit, CircuitNet, Part } from '../../netlist/extract'
import type { Instrument } from '../../spicegen/instruments'

export const LOGIC4000 = readFileSync(
  join(process.cwd(), 'resources', 'models', 'logic4000.json'),
  'utf8',
)

export const VGATED_NET = 2
export const GROUND_NET = 5

/** Pass-1 (12 V family default) Schmitt swing, as it appears in the B-source. */
export const SWING_12V = '(v(u1_o_1y) > 6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000'
/** The swing a measured 5 V rail produces. */
export const SWING_5V = '(v(u1_o_1y) > 2.5000 ? 3.0000 : 2.0000)) ? 0 : 5.0000'

export function switchedRailFixture(supplyV = 12): {
  circuit: Circuit
  resolutions: Resolution[]
  instruments: Instrument[]
  groundNetId: number
} {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
    { id: VGATED_NET, kicadName: '/VGATED', spiceNode: 'vgated', padRefs: [] },
    { id: 3, kicadName: 'IN', spiceNode: 'in', padRefs: [] },
    { id: 4, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
    { id: GROUND_NET, kicadName: 'GND', spiceNode: '0', padRefs: [] },
  ]
  const parts: Part[] = [
    {
      ref: 'U1', value: 'CD40106', libId: 'Logic:CD40106', layer: 'F',
      padNet: new Map([['1', 3], ['2', 4], ['7', GROUND_NET], ['14', VGATED_NET]]),
      properties: {},
    },
    { ref: 'R1', value: '7k', libId: 'R', layer: 'F', padNet: new Map([['1', 1], ['2', 2]]), properties: {} },
    { ref: 'R2', value: '5k', libId: 'R', layer: 'F', padNet: new Map([['1', 2], ['2', 5]]), properties: {} },
    { ref: 'R3', value: '100k', libId: 'R', layer: 'F', padNet: new Map([['1', 3], ['2', 5]]), properties: {} },
  ]
  const resolutions: Resolution[] = [
    {
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: 'CD40106',
        pinMap: { '1': '1A', '2': '1Y', '7': 'GND', '14': 'VCC' },
      },
    },
    { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 vin vgated 7000' } },
    { ref: 'R2', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r2 vgated 0 5000' } },
    { ref: 'R3', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r3 in 0 100000' } },
  ]
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: GROUND_NET },
    { kind: 'dc-supply', id: 'bench', netId: 1, volts: supplyV, seriesOhms: 0.1 },
  ]
  return { circuit: { nets, parts, warnings: [] }, resolutions, instruments, groundNetId: GROUND_NET }
}
