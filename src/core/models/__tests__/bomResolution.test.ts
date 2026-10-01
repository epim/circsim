/**
 * Issue #4: BOM rows feed model resolution (MPN and value win over the board).
 *
 * Reproduction (before the fix): resolvePart took the BOM as `_bom` and never
 * read it, so a BOM with valid MPNs left parts exactly as unresolved as no BOM.
 */

import { describe, it, expect } from 'vitest'

import { resolveAll, resolutionNoteLines, type BomData } from '../resolve'
import { parseBom } from '../../bom/parseBom'
import { bundledLibrary, makeCircuit, makePart } from './p2-helpers'

const lib = bundledLibrary()

describe('BOM rows feed resolution (issue #4)', () => {
  const circuit = makeCircuit([
    makePart('D1', 'Diode', 'Diode_SMD:D_SOD-123'),
    makePart('Q1', 'NPN', 'Package_TO_SOT_SMD:SOT-23', {}, [['1', 1], ['2', 2], ['3', 1]]),
  ])
  const csv = 'Reference,Value,Footprint,MPN\nD1,Diode,Diode_SMD:D_SOD-123,1N4148W\nQ1,NPN,Package_TO_SOT_SMD:SOT-23,MMBT3904\n'

  it('control: without the BOM both parts are unresolved', () => {
    const res = resolveAll(circuit, undefined, undefined, lib)
    expect(res[0].status).toBe('unresolved')
    expect(res[1].status).toBe('unresolved')
  })

  it('a BOM MPN resolves the part by MPN (changes the resolution)', () => {
    const bom = parseBom(csv).rows
    const res = resolveAll(circuit, undefined, bom, lib)
    expect(res[0].status).toBe('ok')
    expect(res[0].tier).toBe(3)
    expect(res[0].model).toMatchObject({ kind: 'subckt', subcktName: 'D1N4148' })
    expect(res[1].status).toBe('ok')
    expect(res[1].model).toMatchObject({ kind: 'subckt', subcktName: 'Q2N3904' })
  })

  it('names the BOM as the source in the part warnings', () => {
    const res = resolveAll(circuit, undefined, parseBom(csv).rows, lib)
    expect(res[0].warnings.some(w => w.startsWith('bom:') && w.includes('1N4148W'))).toBe(true)
  })

  it('the BOM MPN wins over a disagreeing board MPN property', () => {
    const c = makeCircuit([makePart('D1', 'Diode', 'Diode_SMD:D_SOD-123', { MPN: '2N3904' })])
    const bom: BomData = new Map([['D1', { mpn: '1N4148W' }]])
    const res = resolveAll(c, undefined, bom, lib)
    expect(res[0].model).toMatchObject({ subcktName: 'D1N4148' })
  })

  it('a BOM value wins over the board value for R/C/L and says so', () => {
    const c = makeCircuit([makePart('R1', '1k', 'Resistor_SMD:R_0805_2012Metric')])
    const bom: BomData = new Map([['R1', { value: '10k' }]])
    const res = resolveAll(c, undefined, bom, lib)
    expect(res[0].model).toMatchObject({ kind: 'primitive', card: 'r_r1 vin out 10000' })
    expect(res[0].warnings.some(w => w.startsWith('bom:') && w.includes('1k') && w.includes('10k'))).toBe(true)
  })

  it('an agreeing BOM value adds no warning', () => {
    const c = makeCircuit([makePart('R1', '10k', 'Resistor_SMD:R_0805_2012Metric')])
    const res = resolveAll(c, undefined, new Map([['R1', { value: '10k' }]]), lib)
    expect(res[0].warnings).toEqual([])
  })

  it('the BOM footprint never replaces the placed footprint used for pin maps', () => {
    const c = makeCircuit([makePart('D1', '1N4148W', 'Diode_SMD:D_SOD-123')])
    const bom: BomData = new Map([['D1', { footprint: 'JLC-MCP:SOD-123_L2.8-W1.8-LS3.7-RD' }]])
    const res = resolveAll(c, undefined, bom, lib)
    expect(res[0].warnings).toEqual([])
    expect(res[0].model).toMatchObject({ pinMap: { '1': '2', '2': '1' } })
  })

  it('matches a BOM ref case-insensitively and ignores unrelated rows', () => {
    const c = makeCircuit([makePart('D1', 'Diode', 'Diode_SMD:D_SOD-123')])
    const bom: BomData = new Map([['d1', { mpn: '1N4148W' }], ['D99', { mpn: 'NE555' }]])
    const res = resolveAll(c, undefined, bom, lib)
    expect(res[0].status).toBe('ok')
  })

  it('a range row in the BOM reaches every part in the range', () => {
    const c = makeCircuit([
      makePart('D1', 'Diode', 'Diode_SMD:D_SOD-123'),
      makePart('D2', 'Diode', 'Diode_SMD:D_SOD-123'),
    ])
    const res = resolveAll(c, undefined, parseBom('Reference,MPN\nD1-D2,1N4148W\n').rows, lib)
    expect(res.map(r => r.status)).toEqual(['ok', 'ok'])
  })
})

describe('a JLCPCB Comment value never costs a passive its model', () => {
  const bomOf = (ref: string, comment: string) => parseBom(`Designator,Comment
${ref},"${comment}"
`).rows

  it('reads the leading value of "100nF 50V X7R" and "4.7kOhm +-1% 1/10W"', () => {
    const c = makeCircuit([
      makePart('C1', '100n', 'Capacitor_SMD:C_0805_2012Metric'),
      makePart('R2', '4k7', 'Resistor_SMD:R_0805_2012Metric'),
    ])
    const bom: BomData = new Map([
      ...bomOf('C1', '100nF 50V X7R'),
      ...bomOf('R2', '4.7kOhm +-1% 1/10W'),
    ])
    const res = resolveAll(c, undefined, bom, lib)
    expect(res.map(r => r.status)).toEqual(['ok', 'ok'])
    expect(res.map(r => r.tier)).toEqual([2, 2])
    expect(res[0].model).toMatchObject({ card: 'c_c1 vin out 1e-7' })
    expect(res[1].model).toMatchObject({ card: 'r_r2 vin out 4700' })
  })

  it('falls back to the board value when the BOM value cannot be read, and says so', () => {
    const c = makeCircuit([makePart('R3', '10k', 'Resistor_SMD:R_0805_2012Metric')])
    const res = resolveAll(c, undefined, bomOf('R3', 'Thick film chip resistor'), lib)
    expect(res[0].status).toBe('ok')
    expect(res[0].model).toMatchObject({ card: 'r_r3 vin out 10000' })
    expect(res[0].warnings.some(w => w.startsWith('bom:') && w.includes('Thick film') && w.includes('10k'))).toBe(true)
  })

  it('an unresolved part still names the BOM value that replaced the board value', () => {
    const c = makeCircuit([makePart('R4', 'banana', 'Resistor_SMD:R_0805_2012Metric')])
    const res = resolveAll(c, undefined, bomOf('R4', 'Thick film chip resistor'), lib)
    expect(res[0].status).toBe('unresolved')
    expect(res[0].warnings.some(w => w.startsWith('bom:') && w.includes('Thick film'))).toBe(true)
  })

  // A JLCPCB Comment repeats the board value with its rating on nearly every
  // passive: a note there would bury the parts the BOM really changed.
  it('a Comment that carries the board value (with a rating, or in another notation) adds no note', () => {
    const c = makeCircuit([
      makePart('C1', '100n', 'Capacitor_SMD:C_0805_2012Metric'),
      makePart('R2', '4k7', 'Resistor_SMD:R_0805_2012Metric'),
    ])
    const bom: BomData = new Map([
      ...bomOf('C1', '100nF 50V X7R'),
      ...bomOf('R2', '4.7kOhm +-1% 1/10W'),
    ])
    const res = resolveAll(c, undefined, bom, lib)
    expect(res.map(r => r.warnings)).toEqual([[], []])
  })
})

// ─── Where a resolved part's BOM note is read ───────────────────────────────
//
// The Model Doctor lists only parts that need attention, so a part the BOM
// resolved (status ok) has no card: its `bom:` note must reach the sim log.

describe('bom: notes become sim-log lines (issue #4)', () => {
  it('names every part a BOM row changed, resolved or not, and nothing else', () => {
    const c = makeCircuit([
      makePart('D1', 'Diode', 'Diode_SMD:D_SOD-123'),
      makePart('R1', '1k', 'Resistor_SMD:R_0805_2012Metric'),
      makePart('R2', '10k', 'Resistor_SMD:R_0805_2012Metric'),
      makePart('Q9', 'NPN', 'Package_TO_SOT_SMD:SOT-23', {}, [['1', 1], ['2', 2], ['3', 1]]),
    ])
    const bom: BomData = new Map([
      ['D1', { mpn: '1N4148W' }],
      ['R1', { value: '22k' }],
      ['R2', { value: '10k' }],
      ['Q9', { mpn: 'NOT-A-PART' }],
    ])
    const res = resolveAll(c, undefined, bom, lib)
    expect(res.map(r => r.status)).toEqual(['ok', 'ok', 'ok', 'unresolved'])
    expect(resolutionNoteLines(res, 'bom')).toEqual([
      'BOM: D1: MPN "1N4148W" from the BOM selected this model',
      'BOM: R1: value "22k" from the BOM replaces the board value "1k"',
      'BOM: Q9: MPN "NOT-A-PART" from the BOM matched no library model',
    ])
  })

  it('a resolution with no BOM note gives no line', () => {
    const c = makeCircuit([makePart('R1', '1k', 'Resistor_SMD:R_0805_2012Metric')])
    expect(resolutionNoteLines(resolveAll(c, undefined, undefined, lib), 'bom')).toEqual([])
  })
})
