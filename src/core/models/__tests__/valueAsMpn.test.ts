/**
 * Issue #51: value-as-MPN matching respects the entry's refdes prefixes, and an
 * LED whose value is not one of the five color tokens is not a six-way
 * ambiguity.
 */

import { describe, it, expect } from 'vitest'

import { resolveAll, type BomData } from '../resolve'
import { matchLibraryEntry } from '../libraryMatch'
import { bundledLibrary, makeCircuit, makePart } from './p2-helpers'

const lib = bundledLibrary()

function resolveOne(ref: string, value: string, libId: string, bom?: BomData) {
  return resolveAll(makeCircuit([makePart(ref, value, libId)]), undefined, bom, lib)[0]
}

describe('value-as-MPN is gated by refdes prefix (issue #51)', () => {
  it.each([
    ['BT1', '3V0', 'Battery:BatteryHolder_Keystone_1058'],
    ['TP1', '5V1', 'TestPoint:TestPoint_Pad_D1.0mm'],
    ['SW1', '555', 'Button_Switch_SMD:SW_SPST_PTS645'],
    ['J1', '7805', 'MyLib:Header_1x03'],
  ])('%s with value "%s" does not become a zener, NE555 or 7805', (ref, value, libId) => {
    const res = resolveOne(ref, value, libId)
    expect(res.status).not.toBe('ok')
    expect(res.model).toBeUndefined()
  })

  it('the same value on the right refdes class still resolves (control)', () => {
    expect(resolveOne('D3', '3V0', 'Diode_SMD:D_SOD-123').model).toMatchObject({ subcktName: 'DZ3V0' })
    expect(resolveOne('U1', '555', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm').status).toBe('ok')
    expect(resolveOne('U2', '7805', 'Package_TO_SOT_THT:TO-220-3_Vertical').status).toBe('ok')
  })

  it('a zener refdes convention (DZ1, ZD1) passes the gate', () => {
    expect(resolveOne('DZ1', '5V1', 'Diode_SMD:D_SOD-123').status).toBe('ok')
    expect(resolveOne('ZD1', '5V1', 'Diode_SMD:D_SOD-123').status).toBe('ok')
  })

  it('an explicit BOM MPN is the user saying what the part is: not gated', () => {
    const bom: BomData = new Map([['TP1', { mpn: '1N4148W' }]])
    expect(resolveOne('TP1', 'TP', 'TestPoint:TestPoint_Pad_D1.0mm', bom).status).toBe('ok')
  })
})

describe('LED fallback tier is not a six-way ambiguity (issue #51)', () => {
  it.each([
    ['Yellow', 'LED_SMD:LED_0805_2012Metric'],
    ['Amber', 'LED_SMD:LED_0603_1608Metric'],
    ['LED 0805', 'LED_SMD:LED_0805_2012Metric'],
    ['LCSC 0805 light emitting diode', 'LED_SMD:LED_0805_2012Metric'],
  ])('value "%s" on %s resolves to the generic LED, not ambiguous', (value, libId) => {
    const res = resolveOne('D5', value, libId)
    expect(res.status).toBe('ok')
    expect(res.model).toMatchObject({ subcktName: 'LED_RED' })
    expect(res.warnings.join(' ')).toMatch(/color|generic|footprint/i)
  })

  it.each([
    ['RED LED', 'LED_RED'],
    ['Green LED', 'LED_GREEN'],
    ['blue led', 'LED_BLUE'],
    ['White', 'LED_WHITE'],
    ['led_red', 'LED_RED'],
  ])('value "%s" still picks the named color', (value, modelName) => {
    const res = resolveOne('D4', value, 'LED_SMD:LED_0805_2012Metric')
    expect(res.status).toBe('ok')
    expect(res.model).toMatchObject({ subcktName: modelName })
  })

  it('the unanchored D_ diode regex no longer matches an LED footprint', () => {
    const r = matchLibraryEntry(
      { mpn: undefined, libId: 'LED_SMD:LED_0805_2012Metric', value: 'Yellow', ref: 'D5' },
      lib,
    )
    expect(r.kind).toBe('match')
  })

  it('a real diode footprint still reaches the diode fallback candidates', () => {
    const r = matchLibraryEntry(
      { mpn: undefined, libId: 'Diode_SMD:D_SOD-123', value: 'Mystery', ref: 'D5' },
      lib,
    )
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.candidates).toContain('diode-1n4148')
  })
})
