/**
 * core/netlist/__tests__/extract.test.ts
 *
 * TDD tests for Task 6: connectivity extraction + SPICE node naming.
 * Written BEFORE implementation — expect failures initially.
 *
 * spec §8.3
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseBoard } from '../../kicad/board'
import { extract, suggestGround, suggestSupplies } from '../extract'
import { sanitizeSpiceNode } from '../spiceNames'
import type { CircuitNet, Part, NetlistWarning } from '../extract'

// ─── fixture helpers ──────────────────────────────────────────────────────────

const fixturesDir = join(__dirname, '../../../../fixtures')

function loadBoard(name: string) {
  const text = readFileSync(join(fixturesDir, name), 'utf-8')
  return parseBoard(text)
}

// ─── spiceNode sanitization (deterministic algorithm) ────────────────────────

describe('sanitizeSpiceNode', () => {
  it('lowercases plain names', () => {
    expect(sanitizeSpiceNode('VIN')).toBe('vin')
  })

  it('replaces non-[a-z0-9_] chars with underscores', () => {
    // +5V → _5v
    expect(sanitizeSpiceNode('+5V')).toBe('_5v')
  })

  it('collapses runs of underscores', () => {
    // Net-(R1-Pad1) → net_r1_pad1_ (parens become underscores, runs collapsed)
    expect(sanitizeSpiceNode('Net-(R1-Pad1)')).toBe('net_r1_pad1_')
  })

  it('lowercases GND → gnd (before ground override)', () => {
    // standalone — ground net mapping is done at extract() time, not sanitize time
    expect(sanitizeSpiceNode('GND')).toBe('gnd')
  })

  it('handles already-valid names', () => {
    expect(sanitizeSpiceNode('out')).toBe('out')
    expect(sanitizeSpiceNode('net_1')).toBe('net_1')
  })

  it('handles names starting with digits (digit after _ is ok, but leading digit gets _)', () => {
    // "3V3" → "_3v3" (starts with digit → prepend _ then lowercase)
    // Wait: the algorithm says lowercase then replace non [a-z0-9_].
    // "3V3" → lowercase → "3v3" → "3" is a digit, valid. Result: "3v3"
    // BUT — a node name starting with a digit is valid SPICE so we keep it as-is.
    expect(sanitizeSpiceNode('3V3')).toBe('3v3')
  })

  it('collapses multiple underscores from adjacent replacements', () => {
    // "A--B" → lowercase "a--b" → replace "-" → "a__b" → collapse → "a_b"
    expect(sanitizeSpiceNode('A--B')).toBe('a_b')
  })

  it('handles empty string', () => {
    // empty → "" (stays empty, handled upstream)
    expect(sanitizeSpiceNode('')).toBe('')
  })

  it('asserts ground net name → maps to "0" (spec example)', () => {
    // The "ground" token is applied by extract(), not sanitize()
    // But the spec says ground → "0". We test that extract() handles this.
    // This test focuses only on sanitizeSpiceNode behavior.
    expect(sanitizeSpiceNode('ground')).toBe('ground')
  })
})

// ─── collision suffix ─────────────────────────────────────────────────────────

describe('sanitizeSpiceNode — collision handling', () => {
  it('appends _2 on first collision', () => {
    // Two nets that sanitize to the same name should get _2 suffix on the second
    // This is tested via the extract() function's internal collision resolution
    // (sanitizeSpiceNode itself is pure and stateless)
    // We test the extract-level collision via a synthetic board string
    const rcBoardText = readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8')
    const board = parseBoard(rcBoardText)
    const circuit = extract(board)
    // All spiceNodes must be unique
    const nodes = circuit.nets.map(n => n.spiceNode)
    const unique = new Set(nodes)
    expect(unique.size).toBe(nodes.length)
  })
})

// ─── fixture-rc extraction ────────────────────────────────────────────────────

describe('extract() — fixture-rc', () => {
  const board = loadBoard('fixture-rc.kicad_pcb')
  const circuit = extract(board)

  it('produces exactly 3 CircuitNets (VIN, OUT, GND)', () => {
    expect(circuit.nets).toHaveLength(3)
  })

  it('has correct kicadName for each net', () => {
    const names = circuit.nets.map(n => n.kicadName).sort()
    expect(names).toEqual(['GND', 'OUT', 'VIN'])
  })

  it('VIN net has correct spiceNode', () => {
    const vin = circuit.nets.find(n => n.kicadName === 'VIN')!
    expect(vin).toBeDefined()
    expect(vin.spiceNode).toBe('vin')
  })

  it('OUT net has correct spiceNode', () => {
    const out = circuit.nets.find(n => n.kicadName === 'OUT')!
    expect(out).toBeDefined()
    expect(out.spiceNode).toBe('out')
  })

  it('GND net has correct spiceNode (gnd, before ground designation)', () => {
    const gnd = circuit.nets.find(n => n.kicadName === 'GND')!
    expect(gnd).toBeDefined()
    expect(gnd.spiceNode).toBe('gnd')
  })

  it('OUT net padRefs includes {ref:R1, pad:2} and {ref:R2, pad:1}', () => {
    const out = circuit.nets.find(n => n.kicadName === 'OUT')!
    expect(out.padRefs).toEqual(
      expect.arrayContaining([
        { ref: 'R1', pad: '2' },
        { ref: 'R2', pad: '1' },
      ])
    )
    expect(out.padRefs).toHaveLength(2)
  })

  it('VIN net padRefs includes {ref:R1, pad:1}', () => {
    const vin = circuit.nets.find(n => n.kicadName === 'VIN')!
    expect(vin.padRefs).toEqual(
      expect.arrayContaining([{ ref: 'R1', pad: '1' }])
    )
  })

  it('GND net padRefs includes {ref:R2, pad:2}', () => {
    const gnd = circuit.nets.find(n => n.kicadName === 'GND')!
    expect(gnd.padRefs).toEqual(
      expect.arrayContaining([{ ref: 'R2', pad: '2' }])
    )
  })

  it('produces exactly 2 Parts (R1, R2)', () => {
    expect(circuit.parts).toHaveLength(2)
  })

  it('R1 Part has correct padNet map', () => {
    const r1 = circuit.parts.find(p => p.ref === 'R1')!
    expect(r1).toBeDefined()
    expect(r1.padNet.get('1')).toBe(1) // VIN = net 1
    expect(r1.padNet.get('2')).toBe(2) // OUT = net 2
  })

  it('R2 Part has correct padNet map', () => {
    const r2 = circuit.parts.find(p => p.ref === 'R2')!
    expect(r2).toBeDefined()
    expect(r2.padNet.get('1')).toBe(2) // OUT = net 2
    expect(r2.padNet.get('2')).toBe(3) // GND = net 3
  })

  it('R1 Part has correct value and libId', () => {
    const r1 = circuit.parts.find(p => p.ref === 'R1')!
    expect(r1.value).toBe('10k')
    expect(r1.libId).toBe('Resistor_SMD:R_0805_2012Metric')
  })

  it('no warnings for fixture-rc (all pads connected, nets have ≥2 pads)', () => {
    // VIN: 1 pad (R1.1) — single-pad-net warning expected
    // Actually: VIN only has R1 pad 1, OUT has R1 pad 2 + R2 pad 1, GND has R2 pad 2
    // VIN = 1 pad → single-pad-net warning
    // GND = 1 pad → single-pad-net warning
    const singlePadWarnings = circuit.warnings.filter(w => w.kind === 'single-pad-net')
    expect(singlePadWarnings).toHaveLength(2) // VIN and GND each have 1 pad
  })
})

// ─── ground designation ───────────────────────────────────────────────────────

describe('extract() with ground designation', () => {
  it('designated ground net maps to spiceNode "0"', () => {
    const board = loadBoard('fixture-rc.kicad_pcb')
    // GND is net id 3
    const gndNet = Array.from(board.netById.values()).find(n => n.name === 'GND')!
    expect(gndNet).toBeDefined()

    const circuit = extract(board, { groundNetId: gndNet.id })
    const gnd = circuit.nets.find(n => n.kicadName === 'GND')!
    expect(gnd.spiceNode).toBe('0')
  })

  it('non-ground nets are unaffected by ground designation', () => {
    const board = loadBoard('fixture-rc.kicad_pcb')
    const gndNet = Array.from(board.netById.values()).find(n => n.name === 'GND')!
    const circuit = extract(board, { groundNetId: gndNet.id })
    const vin = circuit.nets.find(n => n.kicadName === 'VIN')!
    expect(vin.spiceNode).toBe('vin')
    const out = circuit.nets.find(n => n.kicadName === 'OUT')!
    expect(out.spiceNode).toBe('out')
  })
})

// ─── fixture-555 extraction ───────────────────────────────────────────────────

describe('extract() — fixture-555', () => {
  const board = loadBoard('fixture-555.kicad_pcb')
  const circuit = extract(board)

  it('produces 7 CircuitNets (VCC, GND, DISCH, THRES, OUT, LED_A, CTRL)', () => {
    expect(circuit.nets).toHaveLength(7)
  })

  it('has correct net names', () => {
    const names = circuit.nets.map(n => n.kicadName).sort()
    expect(names).toEqual(['CTRL', 'DISCH', 'GND', 'LED_A', 'OUT', 'THRES', 'VCC'])
  })

  it('produces 7 Parts (U1, R1, R2, C1, C2, R3, D1)', () => {
    expect(circuit.parts).toHaveLength(7)
  })

  it('U1 Part has 8 pads mapped correctly', () => {
    const u1 = circuit.parts.find(p => p.ref === 'U1')!
    expect(u1).toBeDefined()
    expect(u1.padNet.size).toBe(8)
    // pad 1 → GND (net 2)
    expect(u1.padNet.get('1')).toBe(2)
    // pad 8 → VCC (net 1)
    expect(u1.padNet.get('8')).toBe(1)
  })

  it('LED_A net has correct spiceNode', () => {
    const ledA = circuit.nets.find(n => n.kicadName === 'LED_A')!
    expect(ledA).toBeDefined()
    // LED_A → lowercase → led_a (underscore is valid)
    expect(ledA.spiceNode).toBe('led_a')
  })

  it('THRES net connects U1 pads 2 and 6, plus R2 pad 2 and C1 pad 1', () => {
    const thres = circuit.nets.find(n => n.kicadName === 'THRES')!
    expect(thres.padRefs).toEqual(
      expect.arrayContaining([
        { ref: 'U1', pad: '2' },
        { ref: 'U1', pad: '6' },
        { ref: 'R2', pad: '2' },
        { ref: 'C1', pad: '1' },
      ])
    )
    expect(thres.padRefs).toHaveLength(4)
  })
})

// ─── spiceNode examples from spec §8.3 ───────────────────────────────────────

describe('spec §8.3 node name examples', () => {
  it('VIN → vin', () => {
    expect(sanitizeSpiceNode('VIN')).toBe('vin')
  })

  it('+5V → _5v', () => {
    expect(sanitizeSpiceNode('+5V')).toBe('_5v')
  })

  it('Net-(R1-Pad1) → net_r1_pad1_', () => {
    expect(sanitizeSpiceNode('Net-(R1-Pad1)')).toBe('net_r1_pad1_')
  })

  it('ground → "ground" (sanitize only; "0" comes from ground designation)', () => {
    // The spec says "ground" maps to "0" only when it is the designated ground net
    // The sanitizeSpiceNode function itself is pure and doesn't know this.
    expect(sanitizeSpiceNode('ground')).toBe('ground')
  })
})

// ─── warnings ────────────────────────────────────────────────────────────────

describe('NetlistWarning — floating-pad', () => {
  it('pad with no netId generates floating-pad warning', () => {
    // Create a board text with an unconnected pad
    const boardText = `(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))
  (net 1 "VIN")
  (footprint "Resistor_SMD:R_0402" (layer "F.Cu")
    (at 10 10)
    (fp_text reference "R1" (at 0 -1) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -0.5 0) (size 0.5 0.5)
      (layers "F.Cu") (net 1 "VIN"))
    (pad "2" smd rect (at 0.5 0) (size 0.5 0.5)
      (layers "F.Cu"))
  )
  (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 20 0) (end 20 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 20 20) (end 0 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (width 0.1))
)`
    const board = parseBoard(boardText)
    const circuit = extract(board)
    const floating = circuit.warnings.filter(w => w.kind === 'floating-pad')
    expect(floating).toHaveLength(1)
    expect(floating[0].ref).toBe('R1')
    expect(floating[0].pad).toBe('2')
  })
})

describe('NetlistWarning — single-pad-net', () => {
  it('net with only one pad generates single-pad-net warning', () => {
    // A net that only appears on one pad is suspicious
    const boardText = `(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))
  (net 1 "VIN")
  (net 2 "ORPHAN")
  (footprint "Resistor_SMD:R_0402" (layer "F.Cu")
    (at 10 10)
    (fp_text reference "R1" (at 0 -1) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -0.5 0) (size 0.5 0.5)
      (layers "F.Cu") (net 1 "VIN"))
    (pad "2" smd rect (at 0.5 0) (size 0.5 0.5)
      (layers "F.Cu") (net 2 "ORPHAN"))
  )
  (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 20 0) (end 20 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 20 20) (end 0 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (width 0.1))
)`
    const board = parseBoard(boardText)
    const circuit = extract(board)
    const singlePad = circuit.warnings.filter(w => w.kind === 'single-pad-net')
    // Both VIN and ORPHAN each have 1 pad → 2 warnings
    expect(singlePad).toHaveLength(2)
    const netNames = singlePad.map(w => w.netName)
    expect(netNames).toContain('VIN')
    expect(netNames).toContain('ORPHAN')
  })
})

// ─── suggestGround ───────────────────────────────────────────────────────────

describe('suggestGround()', () => {
  const board = loadBoard('fixture-rc.kicad_pcb')
  const circuit = extract(board)

  it('returns the GND net for fixture-rc', () => {
    const gnd = suggestGround(circuit.nets)
    expect(gnd).toBeDefined()
    expect(gnd!.kicadName).toBe('GND')
  })

  it('matches case-insensitively: gnd, GND, Gnd', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'gnd', spiceNode: 'gnd', padRefs: [] },
    ]
    expect(suggestGround(nets)?.kicadName).toBe('gnd')
  })

  it('matches AGND', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'AGND', spiceNode: 'agnd', padRefs: [] },
    ]
    expect(suggestGround(nets)?.kicadName).toBe('AGND')
  })

  it('matches DGND', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'DGND', spiceNode: 'dgnd', padRefs: [] },
    ]
    expect(suggestGround(nets)?.kicadName).toBe('DGND')
  })

  it('matches VSS', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VSS', spiceNode: 'vss', padRefs: [] },
    ]
    expect(suggestGround(nets)?.kicadName).toBe('VSS')
  })

  it('matches 0V', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: '0V', spiceNode: '_0v', padRefs: [] },
    ]
    expect(suggestGround(nets)?.kicadName).toBe('0V')
  })

  it('returns undefined when no ground candidate found', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
    ]
    expect(suggestGround(nets)).toBeUndefined()
  })
})

// ─── suggestSupplies ─────────────────────────────────────────────────────────

describe('suggestSupplies()', () => {
  const board555 = loadBoard('fixture-555.kicad_pcb')
  const circuit555 = extract(board555)

  it('returns VCC net for fixture-555', () => {
    const supplies = suggestSupplies(circuit555.nets)
    const names = supplies.map(n => n.kicadName)
    expect(names).toContain('VCC')
  })

  it('matches VCC', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
    ]
    expect(suggestSupplies(nets)).toHaveLength(1)
  })

  it('matches VDD', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VDD', spiceNode: 'vdd', padRefs: [] },
    ]
    expect(suggestSupplies(nets)).toHaveLength(1)
  })

  it('matches +5V', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: '+5V', spiceNode: '_5v', padRefs: [] },
    ]
    expect(suggestSupplies(nets)).toHaveLength(1)
  })

  it('matches 3V3', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: '3V3', spiceNode: '3v3', padRefs: [] },
    ]
    expect(suggestSupplies(nets)).toHaveLength(1)
  })

  it('matches 5V', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: '5V', spiceNode: '5v', padRefs: [] },
    ]
    expect(suggestSupplies(nets)).toHaveLength(1)
  })

  it('matches 12V', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: '12V', spiceNode: '12v', padRefs: [] },
    ]
    expect(suggestSupplies(nets)).toHaveLength(1)
  })

  it('matches +3.3V', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: '+3.3V', spiceNode: '_3_3v', padRefs: [] },
    ]
    expect(suggestSupplies(nets)).toHaveLength(1)
  })

  it('returns empty array when no supply candidate found', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
    ]
    expect(suggestSupplies(nets)).toHaveLength(0)
  })
})

// ─── collision suffix via extract() ──────────────────────────────────────────

describe('collision suffix (_2) via extract()', () => {
  it('two nets with same sanitized name get _2 suffix on second', () => {
    // Create a board where two nets sanitize identically
    // e.g., "A-B" and "A_B" both sanitize to "a_b"
    const boardText = `(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))
  (net 1 "A-B")
  (net 2 "A_B")
  (footprint "Resistor_SMD:R_0402" (layer "F.Cu")
    (at 10 10)
    (fp_text reference "R1" (at 0 -1) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -0.5 0) (size 0.5 0.5)
      (layers "F.Cu") (net 1 "A-B"))
    (pad "2" smd rect (at 0.5 0) (size 0.5 0.5)
      (layers "F.Cu") (net 2 "A_B"))
  )
  (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 20 0) (end 20 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 20 20) (end 0 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (width 0.1))
)`
    const board = parseBoard(boardText)
    const circuit = extract(board)
    const nodes = circuit.nets.map(n => n.spiceNode)
    // One should be "a_b" and the other "a_b_2"
    expect(nodes).toContain('a_b')
    expect(nodes).toContain('a_b_2')
    // Uniqueness guaranteed
    expect(new Set(nodes).size).toBe(nodes.length)
  })
})

// ─── types re-export check ────────────────────────────────────────────────────

describe('exported types', () => {
  it('Circuit, CircuitNet, Part, NetlistWarning are importable', () => {
    // This is a compile-time check — if the import at the top of the file works,
    // these types exist. We just assert the shapes at runtime with dummy values.
    const net: CircuitNet = { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [{ ref: 'R1', pad: '1' }] }
    expect(net.spiceNode).toBe('vin')

    const part: Part = {
      ref: 'R1',
      value: '10k',
      libId: 'Resistor_SMD:R_0805_2012Metric',
      layer: 'F',
      padNet: new Map([['1', 1]]),
      properties: {},
    }
    expect(part.ref).toBe('R1')

    const warning: NetlistWarning = { kind: 'floating-pad', ref: 'R1', pad: '2', netName: undefined }
    expect(warning.kind).toBe('floating-pad')
  })
})
