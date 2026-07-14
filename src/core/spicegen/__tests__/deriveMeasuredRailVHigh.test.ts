import { expect, test } from 'vitest'
import { deriveMeasuredRailVHigh, RAIL_FLOOR_V } from '../generate'
import type { Circuit } from '../../netlist/extract'
import type { Resolution } from '../../models/types'

const LOGIC4000_JSON = JSON.stringify({
  family: { vHighDefault: 12.0, adc: { inLowFrac: 0.3, inHighFrac: 0.7 }, schmittAdc: { inLowFrac: 0.4, inHighFrac: 0.6 } },
  templates: { CD40106: { schmitt: true, gates: [{ prim: 'd_inverter', in: ['1A'], out: '1Y' }],
    inputs: ['1A'], outputs: ['1Y'], power: { vcc: 'VCC', gnd: 'GND' }, delaysNs: 80 } },
})

function digitalCircuit(vddNode: string): Circuit {
  return {
    nets: [
      { id: 1, kicadName: 'IN', spiceNode: 'a', padRefs: [] },
      { id: 2, kicadName: 'OUT', spiceNode: 'b', padRefs: [] },
      { id: 4, kicadName: '/VGATED', spiceNode: vddNode, padRefs: [] },
      { id: 5, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ],
    parts: [{ ref: 'U1', value: 'CD40106', libId: 'Logic:CD40106', layer: 'F',
      padNet: new Map([['1', 1], ['2', 2], ['14', 4], ['7', 5]]), properties: {} }],
    warnings: [],
  } as unknown as Circuit
}
const RES: Resolution[] = [{ ref: 'U1', status: 'ok', tier: 3, warnings: [],
  model: { kind: 'xspice-digital', templateId: 'CD40106',
    pinMap: { '1': '1A', '2': '1Y', '14': 'VCC', '7': 'GND' } } }]
const base = (opValues: Record<string, number>, extra = {}) => deriveMeasuredRailVHigh({
  opValues, circuit: digitalCircuit('vgated'), resolutions: RES,
  instruments: [{ kind: 'ground-ref', netId: 5 } as any], groundNetId: 5,
  modelTexts: { 'logic4000.json': LOGIC4000_JSON }, ...extra,
})

test('FET-fed VDD measuring 12.6 V → rails has netId 4 = 12.6', () => {
  const r = base({ vgated: 12.6 })
  expect(r.rails.get(4)).toBeCloseTo(12.6)
  expect(r.gatedOff).toEqual([])
})

test('gated-off VDD (~0 V) → not in rails, present in gatedOff', () => {
  const r = base({ vgated: 0.01 })
  expect(r.rails.has(4)).toBe(false)
  expect(r.gatedOff).toEqual([{ ref: 'U1', netId: 4, kicadName: '/VGATED' }])
})

test('chip with a direct dc-supply on VDD is skipped (tier 1 owns it)', () => {
  const r = deriveMeasuredRailVHigh({
    opValues: { vgated: 12.6 }, circuit: digitalCircuit('vgated'), resolutions: RES,
    instruments: [{ kind: 'dc-supply', netId: 4, volts: 12 } as any, { kind: 'ground-ref', netId: 5 } as any],
    groundNetId: 5, modelTexts: { 'logic4000.json': LOGIC4000_JSON },
  })
  expect(r.rails.has(4)).toBe(false)
  expect(r.gatedOff).toEqual([])
})

test('chip with a manual override is skipped', () => {
  const r = base({ vgated: 12.6 }, { railOverrides: new Map([[4, 3.3]]) })
  expect(r.rails.has(4)).toBe(false)
})

test('floor constant is 2 V', () => { expect(RAIL_FLOOR_V).toBe(2) })
