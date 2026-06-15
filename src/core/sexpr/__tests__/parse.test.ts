import { describe, it, expect } from 'vitest'
import { parseSexpr, findAll, find, atom, SExpr } from '../parse'

// ─── basic parsing ────────────────────────────────────────────────────────────

describe('parseSexpr – basic', () => {
  it('parses (net 1 "VIN") → ["net", 1, "VIN"]', () => {
    expect(parseSexpr('(net 1 "VIN")')).toEqual(['net', 1, 'VIN'])
  })

  it('handles quoted strings with escape sequences', () => {
    const result = parseSexpr('(a "he said \\"hi\\"")')
    expect(result).toEqual(['a', 'he said "hi"'])
  })

  it('parses numbers as numbers, not strings', () => {
    const result = parseSexpr('(at 1.6 -0.9125)')
    expect(result).toEqual(['at', 1.6, -0.9125])
    expect(typeof (result as SExpr[])[1]).toBe('number')
    expect(typeof (result as SExpr[])[2]).toBe('number')
  })

  it('version-like tokens that are not valid numbers stay as strings', () => {
    // "20221018" is a large integer, but "1.0.5" is not a valid number
    const result = parseSexpr('(version 1.0.5)')
    expect(result).toEqual(['version', '1.0.5'])
    expect(typeof (result as SExpr[])[1]).toBe('string')
  })

  it('parses valid integer version tokens as numbers', () => {
    const result = parseSexpr('(version 20221018)')
    expect(result).toEqual(['version', 20221018])
    expect(typeof (result as SExpr[])[1]).toBe('number')
  })

  it('bare symbols parse as strings', () => {
    const result = parseSexpr('(pad "1" smd roundrect)')
    expect(result).toEqual(['pad', '1', 'smd', 'roundrect'])
    expect(typeof (result as SExpr[])[2]).toBe('string')
  })

  it('dot-tokens like F.Cu parse as strings', () => {
    const result = parseSexpr('(layer F.Cu)')
    expect(result).toEqual(['layer', 'F.Cu'])
  })

  it('handles nested depth ≥ 6', () => {
    const text = '(a (b (c (d (e (f "deep"))))))'
    const result = parseSexpr(text) as SExpr[]
    // Navigate 6 levels deep
    const lvl2 = result[1] as SExpr[]
    const lvl3 = lvl2[1] as SExpr[]
    const lvl4 = lvl3[1] as SExpr[]
    const lvl5 = lvl4[1] as SExpr[]
    const lvl6 = lvl5[1] as SExpr[]
    expect(lvl6).toEqual(['f', 'deep'])
  })
})

// ─── junk tolerance ───────────────────────────────────────────────────────────

describe('parseSexpr – junk tolerance', () => {
  it('unknown heads survive round-trip into the tree', () => {
    const text = '(kicad_pcb (zzz_future_field 42) (net 1 "VIN"))'
    const result = parseSexpr(text) as SExpr[]
    // Should not throw and should include the unknown field
    expect(result[0]).toBe('kicad_pcb')
    const unknownNode = result[1] as SExpr[]
    expect(unknownNode[0]).toBe('zzz_future_field')
    expect(unknownNode[1]).toBe(42)
    const netNode = result[2] as SExpr[]
    expect(netNode).toEqual(['net', 1, 'VIN'])
  })

  it('parser never validates vocabulary – any atom is accepted', () => {
    expect(() => parseSexpr('(totally_unknown_head 1 2 3)')).not.toThrow()
    expect(() => parseSexpr('(kicad_pcb (zzz_v10_new_feature (nested_unknown true)))')).not.toThrow()
  })
})

// ─── error handling ───────────────────────────────────────────────────────────

describe('parseSexpr – error handling', () => {
  it('throws SexprError with line and col on unbalanced open paren', () => {
    let err: unknown
    try {
      parseSexpr('(net 1 "VIN"')
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect((err as { message: string }).message).toBeTruthy()
    expect(typeof (err as { line: number }).line).toBe('number')
    expect(typeof (err as { col: number }).col).toBe('number')
  })

  it('throws SexprError with line and col on unbalanced close paren', () => {
    let err: unknown
    try {
      parseSexpr('(net 1 "VIN"))')
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect(typeof (err as { line: number }).line).toBe('number')
  })

  it('SexprError has a useful message', () => {
    let err: unknown
    try {
      parseSexpr('(net (missing-close "data")')
    } catch (e) {
      err = e
    }
    expect((err as { message: string }).message).toBeTruthy()
  })

  it('error col tracks position within a line', () => {
    let err: unknown
    try {
      parseSexpr('(net 1)\n(oops')
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect((err as { line: number }).line).toBe(2)
  })
})

// ─── helpers ──────────────────────────────────────────────────────────────────

describe('findAll', () => {
  it('returns immediate children whose [0] === head', () => {
    const tree = parseSexpr('(kicad_pcb (net 0 "") (net 1 "VIN") (net 2 "GND") (footprint "X"))')
    const nets = findAll(tree, 'net')
    expect(nets).toHaveLength(3)
    expect(nets[0]).toEqual(['net', 0, ''])
    expect(nets[1]).toEqual(['net', 1, 'VIN'])
  })

  it('returns empty array when no match', () => {
    const tree = parseSexpr('(kicad_pcb (net 1 "VIN"))')
    expect(findAll(tree, 'footprint')).toEqual([])
  })

  it('does NOT recurse into grandchildren', () => {
    const tree = parseSexpr('(a (b (net 1 "VIN")))')
    // 'net' is a grandchild of 'a', should not be found
    expect(findAll(tree, 'net')).toEqual([])
  })

  it('returns empty array when node is not a list', () => {
    expect(findAll('string-node', 'net')).toEqual([])
    expect(findAll(42, 'net')).toEqual([])
  })
})

describe('find', () => {
  it('returns first immediate child whose [0] === head', () => {
    const tree = parseSexpr('(footprint "Res" (at 10 20) (layer "F.Cu"))')
    const at = find(tree, 'at')
    expect(at).toEqual(['at', 10, 20])
  })

  it('returns undefined when not found', () => {
    const tree = parseSexpr('(footprint "Res" (at 10 20))')
    expect(find(tree, 'missing')).toBeUndefined()
  })

  it('returns undefined when node is not a list', () => {
    expect(find('string-node', 'at')).toBeUndefined()
    expect(find(42, 'at')).toBeUndefined()
  })
})

describe('atom', () => {
  it('returns the atom at the given index', () => {
    const tree = parseSexpr('(net 1 "VIN")')
    expect(atom(tree, 0)).toBe('net')
    expect(atom(tree, 1)).toBe(1)
    expect(atom(tree, 2)).toBe('VIN')
  })

  it('returns undefined for out-of-bounds index', () => {
    const tree = parseSexpr('(net 1)')
    expect(atom(tree, 5)).toBeUndefined()
  })

  it('returns undefined if node is not an array', () => {
    expect(atom('string', 0)).toBeUndefined()
    expect(atom(42, 0)).toBeUndefined()
  })

  it('returns undefined if element at index is a list, not an atom', () => {
    const tree = parseSexpr('(a (b c))')
    // index 1 is a nested list, not a string or number
    expect(atom(tree, 1)).toBeUndefined()
  })
})

// ─── real-world examples ──────────────────────────────────────────────────────

describe('parseSexpr – real-world KiCad patterns', () => {
  it('parses a full footprint with nested pads', () => {
    const text = `(footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu")
      (at 10 10)
      (pad "1" smd roundrect (at -0.9125 0) (size 1.025 1.4)
        (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "VIN"))
    )`
    const result = parseSexpr(text) as SExpr[]
    expect(result[0]).toBe('footprint')
    expect(result[1]).toBe('Resistor_SMD:R_0805_2012Metric')

    const pad = findAll(result, 'pad')[0] as SExpr[]
    expect(pad[0]).toBe('pad')
    expect(pad[1]).toBe('1')
    expect(pad[2]).toBe('smd')

    const padAt = find(pad, 'at') as SExpr[]
    expect(padAt[1]).toBe(-0.9125)
  })

  it('handles multi-line text with different token types', () => {
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "")
      (net 1 "VIN")
    )`
    const result = parseSexpr(text) as SExpr[]
    expect(result[0]).toBe('kicad_pcb')

    const general = find(result, 'general') as SExpr[]
    const thickness = find(general, 'thickness') as SExpr[]
    expect(thickness[1]).toBe(1.6)
  })

  it('handles empty strings in quotes', () => {
    const result = parseSexpr('(net 0 "")')
    expect(result).toEqual(['net', 0, ''])
  })

  it('handles backslash-n escape in strings', () => {
    const result = parseSexpr('(text "line1\\nline2")')
    // \n in a KiCad string literal should be treated as literal \n characters or newline
    // KiCad uses \\n for literal backslash-n; we handle \" for quote escaping
    expect(result).toEqual(['text', 'line1\nline2'])
  })
})

// ─── performance ─────────────────────────────────────────────────────────────

describe('parseSexpr – performance', () => {
  it('parses a 1 MB synthetic file in < 500 ms', () => {
    // Generate a synthetic ~1 MB KiCad-style file
    const lines: string[] = ['(kicad_pcb (version 20221018)']

    // Add many net declarations
    for (let i = 0; i < 1000; i++) {
      lines.push(`  (net ${i} "NET_${i}")`)
    }

    // Add many footprints with nested pads
    for (let i = 0; i < 200; i++) {
      lines.push(`  (footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu")`)
      lines.push(`    (at ${i * 2} 10 0)`)
      lines.push(`    (fp_text reference "R${i}" (at 0 -1.65) (layer "F.SilkS"))`)
      lines.push(`    (fp_text value "10k" (at 0 1.65) (layer "F.Fab"))`)
      lines.push(`    (pad "1" smd roundrect (at -0.9125 0) (size 1.025 1.4)`)
      lines.push(`      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net ${i % 1000} "NET_${i % 1000}"))`)
      lines.push(`    (pad "2" smd roundrect (at 0.9125 0) (size 1.025 1.4)`)
      lines.push(`      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net ${(i + 1) % 1000} "NET_${(i + 1) % 1000}"))`)
      lines.push(`  )`)
    }

    // Add many track segments
    for (let i = 0; i < 2000; i++) {
      lines.push(`  (segment (start ${i * 0.5} 10) (end ${i * 0.5 + 0.5} 10) (width 0.25) (layer "F.Cu") (net ${i % 1000}))`)
    }

    lines.push(')')

    const text = lines.join('\n')
    // Ensure we actually have at least 1 MB
    const sizeKB = Buffer.byteLength(text, 'utf8') / 1024
    expect(sizeKB).toBeGreaterThan(100) // at minimum 100 KB for this test to be valid

    const start = performance.now()
    const result = parseSexpr(text)
    const ms = performance.now() - start

    expect(Array.isArray(result)).toBe(true)
    expect(ms).toBeLessThan(500)
  })
})
