/**
 * Issue #4: BOM rows feed model resolution (MPN and value win over the board).
 *
 * Reproduction (before the fix): resolvePart took the BOM as `_bom` and never
 * read it, so a BOM with valid MPNs left parts exactly as unresolved as no BOM.
 */

import { describe, it, expect } from 'vitest'

import { resolveAll, type BomData } from '../resolve'
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

  it('names the BOM as the source in the part warnings (Model Doctor)', () => {
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
