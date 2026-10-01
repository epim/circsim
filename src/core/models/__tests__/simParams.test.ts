/**
 * Issues #6 and #7: tier 1 (schematic Sim.* fields) must never emit a card
 * ngspice cannot use, and must understand the forms KiCad itself writes.
 *
 * Reproductions (real ngspice 46, see the issues):
 *   d_d1 a 0                     -> "could not find a valid modelname", circuit not parsed
 *   v_bt1 a 0                    -> "has no value, DC 0 assumed" (a hard short)
 *   c_c1 a 0 ""                  -> "is not a valid capacitor instance line, ignored!"
 *   r_r2 a 0                     -> "is not a valid resistor instance line, ignored!"
 */

import { describe, it, expect } from 'vitest'

import { resolveAll } from '../resolve'
import { parseSchematicSimData, type SchematicSimData } from '../../kicad/schematic'
import type { LibraryEntry } from '../types'
import { bundledLibrary, makeCircuit, makePart, simInfo } from './p2-helpers'

const lib = bundledLibrary()

function one(part: ReturnType<typeof makePart>, sim: Parameters<typeof simInfo>[0], pins?: Parameters<typeof simInfo>[1], library?: LibraryEntry[]) {
  const data: SchematicSimData = new Map([[part.ref, simInfo(sim, pins)]])
  return resolveAll(makeCircuit([part]), data, undefined, library)[0]
}

function cardOf(res: ReturnType<typeof one>): string | undefined {
  return res.model?.kind === 'primitive' ? res.model.card : undefined
}

// ─── #6: D/Q/M/J need a model, V/I need a value ──────────────────────────────

describe('tier 1 never emits a model-less diode or valueless source (issue #6)', () => {
  const d1 = () => makePart('D101', '1N4148W', 'Diode_SMD:D_SOD-123')

  it('Sim.Device=D with no params falls through to the library on the Value field', () => {
    const res = one(d1(), { Device: 'D', Pins: '1=K 2=A' }, undefined, lib)
    expect(res.status).toBe('ok')
    expect(res.tier).toBe(3)
    expect(res.model).toMatchObject({ kind: 'subckt', subcktName: 'D1N4148' })
  })

  it('Sim.Device=D with KiCad params (rs=50m cjo=10p) is not emitted as a bare card', () => {
    const res = one(makePart('D101', 'D', 'Diode_SMD:D_SOD-123'), { Device: 'D', Params: 'rs=50m cjo=10p', Pins: '1=K 2=A' })
    expect(cardOf(res)).toBeUndefined()
    expect(res.status).toBe('unresolved')
  })

  it('an unmodelable D never reads as ok (no model-less card)', () => {
    const res = one(makePart('D101', 'D', 'Diode_SMD:D_SOD-123'), { Device: 'D' })
    expect(res.status).toBe('unresolved')
    expect(res.model).toBeUndefined()
    expect(res.warnings.join(' ')).toMatch(/Sim\.Device="D"/)
  })

  it.each(['Q', 'M', 'J'])('Sim.Device=%s without a model name is never a primitive card', (device) => {
    const res = one(makePart('Q1', 'X', 'Package_TO_SOT_SMD:SOT-23'), { Device: device })
    expect(cardOf(res)).toBeUndefined()
    expect(res.status).toBe('unresolved')
  })

  it('Sim.Device=V with no Sim.Params is not a valueless card', () => {
    const res = one(makePart('BT1', 'Battery_Cell', 'Battery:BatteryHolder_Keystone_1058'), { Device: 'V', Type: 'DC', Pins: '1=+ 2=-' })
    expect(cardOf(res)).toBeUndefined()
    expect(res.status).toBe('unresolved')
    expect(res.warnings.join(' ')).toMatch(/no value/i)
  })

  it('Sim.Device=I with no Sim.Params is not a valueless card', () => {
    const res = one(makePart('I1', 'ISRC', 'Connector:Conn_01x02'), { Device: 'I' })
    expect(cardOf(res)).toBeUndefined()
  })

  it('Sim.Device=V with dc="5" still emits a complete card', () => {
    const res = one(makePart('V1', 'VDC', 'Battery:Holder'), { Device: 'V', Params: 'dc="5"' })
    expect(cardOf(res)).toBe('v_v1 vin out 5')
    expect(res.status).toBe('ok')
  })

  it('Sim.Pins orders a source: 1=- 2=+ puts pad 2 on the positive terminal', () => {
    const res = one(makePart('V1', 'VDC', 'Battery:Holder'), { Device: 'V', Params: 'dc="5"', Pins: '1=- 2=+' })
    expect(cardOf(res)).toBe('v_v1 out vin 5')
  })

  it('Sim.Pins 1=+ 2=- keeps pad order', () => {
    const res = one(makePart('V1', 'VDC', 'Battery:Holder'), { Device: 'V', Params: 'dc="5"', Pins: '1=+ 2=-' })
    expect(cardOf(res)).toBe('v_v1 vin out 5')
  })

  it('Sim.Pins that do not describe this part are ignored, not trusted', () => {
    const res = one(makePart('V1', 'VDC', 'Battery:Holder'), { Device: 'V', Params: 'dc="5"', Pins: '7=+ 8=-' })
    expect(cardOf(res)).toBe('v_v1 vin out 5')
  })
})

// ─── #7: KiCad-written Sim.Params forms ──────────────────────────────────────

describe('KiCad-written Sim.Params forms (issue #7)', () => {
  const c17 = () => makePart('C17', '0.1uF 100V', 'Capacitor_SMD:C_0603_1608Metric')

  it('c="" falls back to the Value field instead of emitting an empty value', () => {
    const res = one(c17(), { Device: 'C', Params: 'c=""' })
    expect(res.status).toBe('ok')
    expect(cardOf(res)).toBe('c_c17 vin out 1e-7')
  })

  it('lowercase keys are honoured (r=10k)', () => {
    const res = one(makePart('R1', '99', 'Resistor_SMD:R_0805_2012Metric'), { Device: 'R', Params: 'r=10k' })
    expect(cardOf(res)).toBe('r_r1 vin out 10000')
  })

  it('quoted values are unquoted (r="4.7k")', () => {
    const res = one(makePart('R1', '99', 'Resistor_SMD:R_0805_2012Metric'), { Device: 'R', Params: 'r="4.7k"' })
    expect(cardOf(res)).toBe('r_r1 vin out 4700')
  })

  it('an empty Sim.Params falls back to the Value field (no bare r_r2 card)', () => {
    const res = one(makePart('R2', '4k7', 'Resistor_SMD:R_0805_2012Metric'), { Device: 'R', Params: '' })
    expect(cardOf(res)).toBe('r_r2 vin out 4700')
  })

  it('an unusable value and an unusable Value field is unresolved, never a card', () => {
    const res = one(makePart('C1', 'Cap', 'Capacitor_SMD:C_0603_1608Metric'), { Device: 'C', Params: 'c=""' })
    expect(cardOf(res)).toBeUndefined()
    expect(res.status).toBe('unresolved')
  })

  it('a behavioural expression is not truncated at the first space', () => {
    const res = one(makePart('R3', '10k', 'Resistor_SMD:R_0805_2012Metric'), { Device: 'R', Params: "r='TIME > 350m ? 8 : 89'" })
    const card = cardOf(res)
    expect(card ?? '').not.toMatch(/TIME|\?|>|'/)
    // The Value field is the honest fallback for a plain resistor.
    expect(card).toBe('r_r3 vin out 10000')
  })

  it('Sim.Device=SPICE (outside the primitive table) does not block the Value field', () => {
    const res = one(makePart('C5', '100n', 'Capacitor_SMD:C_0603_1608Metric'), { Device: 'SPICE', Params: 'type="C" model="100n" lib=""' })
    expect(res.status).toBe('ok')
    expect(res.tier).toBe(2)
    expect(cardOf(res)).toBe('c_c5 vin out 1e-7')
  })

  it('Sim.Device=NMOS does not block a library MPN in the Value field', () => {
    const entry: LibraryEntry = {
      id: 'test-irf540n',
      match: { mpn: ['IRF540N'] },
      model: { type: 'model-card', file: 'mos.lib', name: 'IRF540N' },
      pinMaps: { '.*': { '1': '1', '2': '2' } },
      defaultPinMap: { '1': '1', '2': '2' },
      provenance: 'test fixture',
    }
    const res = one(makePart('Q1', 'IRF540N', 'Package_TO_SOT_THT:TO-220-3_Vertical'), { Device: 'NMOS' }, undefined, [entry])
    expect(res.status).toBe('ok')
    expect(res.tier).toBe(3)
  })

  it('an unsupported Sim.Device with nothing else to go on is still reported, naming the device', () => {
    const res = one(makePart('U1', 'SomeIC', 'Package:SOT23'), { Device: 'KIBIS' })
    expect(res.status).toBe('unresolved')
    expect(res.warnings.some(w => w.includes('KIBIS'))).toBe(true)
  })

  it('parses a KiCad-written schematic: c="" capacitor and a Sim.Device=SPICE part', () => {
    const sch = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0")
      (lib_symbols)
      (symbol (lib_id "Device:C") (at 0 0 0) (uuid "a")
        (property "Reference" "C17" (at 0 0 0))
        (property "Value" "0.1uF 100V" (at 0 0 0))
        (property "Sim.Device" "C" (at 0 0 0))
        (property "Sim.Params" "c=\\"\\"" (at 0 0 0)))
      (symbol (lib_id "Device:C") (at 0 0 0) (uuid "b")
        (property "Reference" "C18" (at 0 0 0))
        (property "Value" "100n" (at 0 0 0))
        (property "Sim.Device" "SPICE" (at 0 0 0))
        (property "Sim.Params" "type=\\"C\\" model=\\"100n\\" lib=\\"\\"" (at 0 0 0))))`
    const data = parseSchematicSimData(sch)
    expect(data.get('C17')?.sim.Params).toBe('c=""')
    const circuit = makeCircuit([
      makePart('C17', '0.1uF 100V', 'Capacitor_SMD:C_0603_1608Metric'),
      makePart('C18', '100n', 'Capacitor_SMD:C_0603_1608Metric'),
    ])
    const res = resolveAll(circuit, data)
    expect(res.map(r => r.status)).toEqual(['ok', 'ok'])
    for (const r of res) {
      const card = r.model?.kind === 'primitive' ? r.model.card : ''
      expect(card).toMatch(/^c_c1[78] vin out 1e-7$/)
    }
  })
})
