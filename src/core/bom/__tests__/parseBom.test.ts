import { describe, it, expect } from 'vitest'
import { parseBom, describeBomImport } from '../parseBom'

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

// ── Issue #4: header aliases, ranges, quoted newlines, import notes ─────────

describe('parseBom: broader headers (issue #4)', () => {
  it.each(['References', 'Reference Designator', 'Reference Designators', 'Ref Des', 'RefDes', 'Designators'])(
    'accepts "%s" as the ref column',
    (header) => {
      const result = parseBom(`${header},Value,MPN\nD1,Diode,1N4148W\n`)
      expect(result.errors).toEqual([])
      expect(result.rows.get('D1')?.mpn).toBe('1N4148W')
    },
  )

  it('maps the JLCPCB Comment column to value', () => {
    const csv = 'Comment,Designator,Footprint,LCSC Part #\n100nF,"C1,C37",C_0603_1608Metric,C14663\n'
    const result = parseBom(csv)
    expect(result.rows.get('C1')?.value).toBe('100nF')
    expect(result.rows.get('C37')?.value).toBe('100nF')
    expect(result.rows.get('C1')?.footprint).toBe('C_0603_1608Metric')
  })

  it('prefers a Value column over a Comment column when both exist', () => {
    const result = parseBom('Reference,Comment,Value\nR1,thin film,10k\n')
    expect(result.rows.get('R1')?.value).toBe('10k')
  })

  it('does not treat an LCSC code column as the MPN', () => {
    const result = parseBom('Designator,LCSC Part #\nR1,C25804\n')
    expect(result.rows.get('R1')?.mpn).toBeUndefined()
  })

  it.each(['Manufacturer Part Number', 'Manufacturer Part #', 'Mfr Part Number', 'Mfr. Part #', 'MFG Part Number', 'Manufacturer_Part_Number'])(
    'accepts "%s" as the MPN column',
    (header) => {
      const result = parseBom(`Reference,${header}\nD1,1N4148W\n`)
      expect(result.rows.get('D1')?.mpn).toBe('1N4148W')
    },
  )

  it('strips a UTF-8 byte-order mark from the header', () => {
    const result = parseBom(String.fromCharCode(0xfeff) + 'Reference,Value\nR1,10k\n')
    expect(result.errors).toEqual([])
    expect(result.rows.has('R1')).toBe(true)
  })
})

describe('parseBom: range expansion (issue #4)', () => {
  it('expands R1-R4 to four rows', () => {
    const result = parseBom('Reference,Value\nR1-R4,10k\n')
    expect([...result.rows.keys()]).toEqual(['R1', 'R2', 'R3', 'R4'])
    expect(result.rows.has('R1-R4')).toBe(false)
    expect(result.rows.get('R3')?.value).toBe('10k')
  })

  it('expands a short-form range R1-4 and a tilde range', () => {
    expect([...parseBom('Reference,Value\nR1-4,10k\n').rows.keys()]).toEqual(['R1', 'R2', 'R3', 'R4'])
    expect([...parseBom('Reference,Value\nC10~C12,1u\n').rows.keys()]).toEqual(['C10', 'C11', 'C12'])
  })

  it('expands a range mixed with single refs', () => {
    const result = parseBom('Reference,Value\n"R1-R3, R7",10k\n')
    expect([...result.rows.keys()]).toEqual(['R1', 'R2', 'R3', 'R7'])
  })

  it('reports a descending or cross-prefix range instead of inventing refs', () => {
    const a = parseBom('Reference,Value\nR4-R1,10k\n')
    expect(a.rows.size).toBe(0)
    expect(a.errors.some(e => e.includes('R4-R1'))).toBe(true)
    const b = parseBom('Reference,Value\nR1-C4,10k\n')
    expect(b.rows.size).toBe(0)
    expect(b.errors.some(e => e.includes('R1-C4'))).toBe(true)
  })

  it('refuses an absurdly wide range', () => {
    const result = parseBom('Reference,Value\nR1-R99999,10k\n')
    expect(result.rows.size).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('parseBom: quoted fields with newlines (issue #4)', () => {
  it('keeps a quoted field that contains a newline in one record', () => {
    const csv = 'Reference,Value,Description\n"R1,\nR2",10k,"two\nlines"\nR3,4k7,plain\n'
    const result = parseBom(csv)
    expect([...result.rows.keys()].sort()).toEqual(['R1', 'R2', 'R3'])
    expect(result.rows.get('R2')?.value).toBe('10k')
  })

  it('does not invent a ref row from the tail of a multi-line description', () => {
    const csv = 'Reference,Description,Value\nR1,"first line\nsecond line",10k\n'
    const result = parseBom(csv)
    expect([...result.rows.keys()]).toEqual(['R1'])
    expect(result.rows.get('R1')?.value).toBe('10k')
  })
})

describe('describeBomImport: surface parse errors and unmatched rows (issue #4)', () => {
  it('returns the parser errors as warnings', () => {
    const parsed = parseBom('Foo,Bar\n1,2\n')
    const notes = describeBomImport(parsed, ['R1'])
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(notes.some(n => n.includes('No ref column'))).toBe(true)
  })

  it('counts rows whose ref is not on the board', () => {
    const parsed = parseBom('Reference,Value,MPN\nD1,Diode,1N4148W\nD9,Diode,1N4148W\nQ1,NPN,MMBT3904\n')
    const notes = describeBomImport(parsed, ['D1', 'Q1', 'R1'])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('1 of 3')
    expect(notes[0]).toContain('D9')
  })

  it('reports an empty BOM as a problem, not silence', () => {
    const notes = describeBomImport(parseBom('Reference,Value\n'), ['R1'])
    expect(notes.length).toBeGreaterThan(0)
  })

  it('is quiet when every row matches a board ref', () => {
    const parsed = parseBom('Reference,Value\nR1,10k\n')
    expect(describeBomImport(parsed, ['R1', 'R2'])).toEqual([])
  })

  it('matches refs case-insensitively', () => {
    const parsed = parseBom('Reference,Value\nr1,10k\n')
    expect(describeBomImport(parsed, ['R1'])).toEqual([])
  })
})
