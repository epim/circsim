/**
 * Review focus 3 (docs/superpowers/plans/2026-09-24-council-remediation-plan.md):
 * a part whose value is "4,7k" and whose BOM row carries an MPN. Resolution
 * prefers the MPN, and no part shows status ok after ngspice prints
 * "could not find a valid modelname" for it.
 *
 * The fixture is synthetic: a comma-decimal value no value parser owns (the
 * board author typed "4,7k" into a diode's Value field), a BOM with the MPN,
 * and the literal ngspice 46 log lines from the issue #6 reproduction.
 */

import { describe, it, expect } from 'vitest'

import { resolveAll, ngspiceLogDiagnostic, applyDeckDiagnostics, type DeckDiagnostic } from '../resolve'
import { parseBom } from '../../bom/parseBom'
import { bundledLibrary, makeCircuit, makePart } from './p2-helpers'

const lib = bundledLibrary()

const circuit = makeCircuit([
  makePart('D1', '4,7k', 'Diode_SMD:D_SOD-123'),
  makePart('R1', '10k', 'Resistor_SMD:R_0805_2012Metric'),
])
const bom = parseBom('Comment,Designator,Footprint,Manufacturer Part Number\n"4,7k","D1",D_SOD-123,1N4148W\n').rows

// What SimHost relays for a deck holding a model-less diode card (issue #6).
const NGSPICE_LOG = [
  'stderr Error on line 4 or its substitute:',
  'stderr d_d1 a 0',
  'stderr could not find a valid modelname',
  'stderr Error: circuit not parsed.',
]

function collect(lines: string[], refs: string[]): DeckDiagnostic[] {
  const out: DeckDiagnostic[] = []
  let prev: string | undefined
  for (const line of lines) {
    const d = ngspiceLogDiagnostic(line, prev, refs)
    if (d) out.push(d)
    prev = line
  }
  return out
}

describe('review focus 3: 4,7k part with a BOM MPN', () => {
  it('without the BOM the part is not modeled', () => {
    expect(resolveAll(circuit, undefined, undefined, lib)[0].status).not.toBe('ok')
  })

  it('resolves by the BOM MPN, not by its value', () => {
    const res = resolveAll(circuit, undefined, bom, lib)
    expect(res[0].status).toBe('ok')
    expect(res[0].tier).toBe(3)
    expect(res[0].model).toMatchObject({ subcktName: 'D1N4148' })
  })

  it('a part named in an ngspice "could not find a valid modelname" report is not ok afterwards', () => {
    const before = resolveAll(circuit, undefined, bom, lib)
    const diags = collect(NGSPICE_LOG, ['D1', 'R1'])
    expect(diags).toHaveLength(1)
    expect(diags[0].ref).toBe('D1')
    const after = applyDeckDiagnostics(before, diags)
    expect(after.find(r => r.ref === 'D1')!.status).not.toBe('ok')
    expect(after.find(r => r.ref === 'D1')!.warnings.join(' ')).toMatch(/could not find a valid modelname/)
    // The untouched part keeps its resolution (same object, not just equal).
    expect(after.find(r => r.ref === 'R1')).toBe(before.find(r => r.ref === 'R1'))
  })
})

describe('ngspiceLogDiagnostic', () => {
  const refs = ['C1', 'R2', 'BT1', 'D1']

  it('names the part behind an "ignored!" capacitor warning (level warn, not error)', () => {
    const d = ngspiceLogDiagnostic("stderr Warning: 'c_c1 a 0' is not a valid capacitor instance line, ignored!", undefined, refs)
    expect(d?.ref).toBe('C1')
    expect(d?.message).toMatch(/ignored/)
  })

  it('names the part behind an "ignored!" resistor warning', () => {
    expect(ngspiceLogDiagnostic("Warning: 'r_r2 a 0' is not a valid resistor instance line, ignored!", undefined, refs)?.ref).toBe('R2')
  })

  it('names the part behind "has no value, DC 0 assumed"', () => {
    const d = ngspiceLogDiagnostic('stderr Note: v_bt1: has no value, DC 0 assumed', undefined, refs)
    expect(d?.ref).toBe('BT1')
  })

  it('uses the previous line as the offending card for a modelname error', () => {
    const d = ngspiceLogDiagnostic('stderr could not find a valid modelname', 'stderr d_d1 a 0', refs)
    expect(d?.ref).toBe('D1')
  })

  it('returns null for unrelated lines and for unknown elements', () => {
    expect(ngspiceLogDiagnostic('stdout Circuit: * circsim', undefined, refs)).toBeNull()
    expect(ngspiceLogDiagnostic('stderr Error: circuit not parsed.', 'stderr x', refs)).toBeNull()
    expect(ngspiceLogDiagnostic("Warning: 'r_zz9 a 0' is not a valid resistor instance line, ignored!", undefined, refs)).toBeNull()
    expect(ngspiceLogDiagnostic('could not find a valid modelname', 'stderr Error on line 4 or its substitute:', refs)).toBeNull()
  })
})

describe('applyDeckDiagnostics', () => {
  it('demotes an ok part to unresolved, drops its model, keeps earlier warnings, and is idempotent', () => {
    const res = resolveAll(circuit, undefined, bom, lib)
    const d: DeckDiagnostic = { ref: 'D1', message: 'ngspice: could not find a valid modelname' }
    const once = applyDeckDiagnostics(res, [d])
    const d1 = once.find(r => r.ref === 'D1')!
    expect(d1.status).toBe('unresolved')
    expect(d1.model).toBeUndefined()
    const twice = applyDeckDiagnostics(once, [d])
    expect(twice.find(r => r.ref === 'D1')!.warnings).toEqual(d1.warnings)
  })

  it('returns the same array when there is nothing to apply', () => {
    const res = resolveAll(circuit, undefined, bom, lib)
    expect(applyDeckDiagnostics(res, [])).toBe(res)
  })
})
