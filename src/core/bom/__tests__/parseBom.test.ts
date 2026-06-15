import { describe, it, expect } from 'vitest'
import { parseBom } from '../parseBom'

describe('parseBom', () => {
  // ── Delimiter autodetection ────────────────────────────────────────────────

  it('autodetects comma delimiter', () => {
    const csv = 'Reference,Value,MPN\nR1,10k,RC0805FR-0710KL\n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
    expect(result.rows.get('R1')?.value).toBe('10k')
    expect(result.rows.get('R1')?.mpn).toBe('RC0805FR-0710KL')
  })

  it('autodetects semicolon delimiter', () => {
    const csv = 'Reference;Value;MPN\nR1;10k;RC0805FR-0710KL\n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
    expect(result.rows.get('R1')?.value).toBe('10k')
  })

  it('autodetects tab delimiter', () => {
    const csv = 'Reference\tValue\tMPN\nR1\t10k\tRC0805FR-0710KL\n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
    expect(result.rows.get('R1')?.value).toBe('10k')
  })

  // ── Header aliasing ────────────────────────────────────────────────────────

  it('aliases "Designator" → ref column', () => {
    const csv = 'Designator,Value\nR1,10k\n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
  })

  it('aliases "Manufacturer Part Number" → mpn', () => {
    const csv = 'Reference,Value,Manufacturer Part Number\nR1,10k,RC0805\n'
    const result = parseBom(csv)
    expect(result.rows.get('R1')?.mpn).toBe('RC0805')
  })

  it('aliases "MPN" → mpn', () => {
    const csv = 'Reference,Value,MPN\nR1,10k,RC0805\n'
    const result = parseBom(csv)
    expect(result.rows.get('R1')?.mpn).toBe('RC0805')
  })

  it('aliases "Part Number" → mpn', () => {
    const csv = 'Reference,Value,Part Number\nR1,10k,RC0805\n'
    const result = parseBom(csv)
    expect(result.rows.get('R1')?.mpn).toBe('RC0805')
  })

  it('captures Footprint column', () => {
    const csv = 'Reference,Value,Footprint\nR1,10k,Resistor_SMD:R_0805\n'
    const result = parseBom(csv)
    expect(result.rows.get('R1')?.footprint).toBe('Resistor_SMD:R_0805')
  })

  it('columnGuess records header-to-field mapping', () => {
    const csv = 'Reference,Value,MPN\nR1,10k,RC0805\n'
    const result = parseBom(csv)
    expect(result.columnGuess['Reference']).toBe('ref')
    expect(result.columnGuess['Value']).toBe('value')
    expect(result.columnGuess['MPN']).toBe('mpn')
  })

  // ── Grouped-ref expansion ─────────────────────────────────────────────────

  it('expands "R1, R2, R3" grouped ref row to individual entries', () => {
    const csv = 'Reference,Value,MPN\n"R1, R2, R3",10k,RC0805\n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
    expect(result.rows.has('R2')).toBe(true)
    expect(result.rows.has('R3')).toBe(true)
    expect(result.rows.get('R2')?.value).toBe('10k')
    expect(result.rows.get('R3')?.mpn).toBe('RC0805')
  })

  it('expands grouped refs without quotes', () => {
    const csv = 'Reference,Value\nR1 R2 R3,10k\n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
    expect(result.rows.has('R2')).toBe(true)
    expect(result.rows.has('R3')).toBe(true)
  })

  // ── Quoted fields with embedded commas ────────────────────────────────────

  it('handles quoted fields with embedded commas', () => {
    const csv = 'Reference,Value,MPN\nR1,"10k, 1%",RC0805\n'
    const result = parseBom(csv)
    expect(result.rows.get('R1')?.value).toBe('10k, 1%')
    expect(result.rows.get('R1')?.mpn).toBe('RC0805')
  })

  it('handles quoted fields with embedded commas (semicolon CSV)', () => {
    const csv = 'Reference;Value;MPN\nR1;"47k; 5%";RC0805\n'
    const result = parseBom(csv)
    expect(result.rows.get('R1')?.value).toBe('47k; 5%')
  })

  it('handles escaped quotes inside quoted fields', () => {
    const csv = 'Reference,Value\nR1,"he said ""hi"""\n'
    const result = parseBom(csv)
    expect(result.rows.get('R1')?.value).toBe('he said "hi"')
  })

  // ── Multi-row and empty handling ──────────────────────────────────────────

  it('handles multiple rows', () => {
    const csv = 'Reference,Value,MPN\nR1,10k,RC0805\nC1,100nF,GRM188R71C104K\n'
    const result = parseBom(csv)
    expect(result.rows.size).toBe(2)
    expect(result.rows.get('C1')?.value).toBe('100nF')
  })

  it('errors is empty array for valid BOM', () => {
    const csv = 'Reference,Value\nR1,10k\n'
    const result = parseBom(csv)
    expect(result.errors).toEqual([])
  })

  it('returns error when no ref column found', () => {
    const csv = 'PartName,Value\nSomeIC,NA\n'
    const result = parseBom(csv)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toMatch(/ref/i)
  })

  it('skips blank lines', () => {
    const csv = 'Reference,Value\nR1,10k\n\nR2,4k7\n'
    const result = parseBom(csv)
    expect(result.rows.size).toBe(2)
  })

  it('trims whitespace from cell values', () => {
    const csv = 'Reference,Value,MPN\n R1 , 10k , RC0805 \n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
    expect(result.rows.get('R1')?.value).toBe('10k')
  })

  // ── KiCad-style BOM format ────────────────────────────────────────────────

  it('handles KiCad-exported BOM with Id column (non-ref columns ignored gracefully)', () => {
    const csv = 'Id,Reference,Value,Footprint,Quantity\n1,R1,10k,R_0805,1\n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
    expect(result.rows.get('R1')?.value).toBe('10k')
  })

  it('handles "Ref" as alias for Reference', () => {
    const csv = 'Ref,Value\nR1,10k\n'
    const result = parseBom(csv)
    expect(result.rows.has('R1')).toBe(true)
  })
})
