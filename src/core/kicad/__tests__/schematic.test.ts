/**
 * core/kicad/__tests__/schematic.test.ts
 *
 * Tests for parseSchematicSimData() — Task 5.
 * Written FIRST (TDD). All tests must fail before schematic.ts is implemented.
 *
 * Spec §2, §8.2
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseSchematicSimData } from '../schematic'
import { parseBoard } from '../board'

// ─── load fixture ─────────────────────────────────────────────────────────────

const FIXTURE_SCH_PATH = join(__dirname, '../../../../fixtures/fixture-555.kicad_sch')
const fixture555SchText = readFileSync(FIXTURE_SCH_PATH, 'utf-8')

// ─── basic extraction ─────────────────────────────────────────────────────────

describe('parseSchematicSimData — basic structure', () => {
  it('returns a Map keyed by reference designator', () => {
    const data = parseSchematicSimData(fixture555SchText)
    expect(data).toBeInstanceOf(Map)
    expect(data.has('U1')).toBe(true)
    expect(data.has('R1')).toBe(true)
    expect(data.has('R2')).toBe(true)
    expect(data.has('C1')).toBe(true)
    expect(data.has('C2')).toBe(true)
    expect(data.has('R3')).toBe(true)
    expect(data.has('D1')).toBe(true)
  })

  it('has 7 entries total — one per component in the 555 fixture', () => {
    const data = parseSchematicSimData(fixture555SchText)
    expect(data.size).toBe(7)
  })
})

// ─── Sim.* property extraction ────────────────────────────────────────────────

describe('parseSchematicSimData — Sim.* properties for U1', () => {
  it('extracts Sim.Pins for U1 NE555', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    expect(u1).toBeDefined()
    expect(u1.sim['Pins']).toBeDefined()
    // Sim.Pins encodes the ngspice pin order
    expect(u1.sim['Pins']).toMatch(/GND/)
    expect(u1.sim['Pins']).toMatch(/VCC/)
  })

  it('extracts Sim.Library for U1', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    expect(u1.sim['Library']).toBeDefined()
    expect(typeof u1.sim['Library']).toBe('string')
  })

  it('extracts Sim.Name for U1', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    expect(u1.sim['Name']).toBeDefined()
    expect(typeof u1.sim['Name']).toBe('string')
  })

  it('extracts Sim.Device for U1', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    // NE555 uses SUBCKT type
    expect(u1.sim['Device']).toBeDefined()
  })
})

// ─── value field ─────────────────────────────────────────────────────────────

describe('parseSchematicSimData — value fields', () => {
  it('extracts the value field for passive components', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const r1 = data.get('R1')!
    expect(r1.value).toBeDefined()
    expect(r1.value).toMatch(/10k/i)
  })

  it('extracts value for R2 = 47k', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const r2 = data.get('R2')!
    expect(r2.value).toMatch(/47k/i)
  })

  it('extracts value for C1 = 10u', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const c1 = data.get('C1')!
    expect(c1.value).toMatch(/10u/i)
  })

  it('extracts value for U1 = NE555', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    expect(u1.value).toMatch(/NE555/i)
  })
})

// ─── pin extraction from lib_symbols ─────────────────────────────────────────

describe('parseSchematicSimData — pin list from lib_symbols', () => {
  it('U1 has 8 pins resolved from lib_symbols', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    expect(u1.pins).toHaveLength(8)
  })

  it('U1 pins have number, name, and type fields', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    for (const pin of u1.pins) {
      expect(pin).toHaveProperty('number')
      expect(pin).toHaveProperty('name')
      expect(pin).toHaveProperty('type')
      expect(typeof pin.number).toBe('string')
      expect(typeof pin.name).toBe('string')
      expect(typeof pin.type).toBe('string')
    }
  })

  it('U1 pin 1 is GND', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    const pin1 = u1.pins.find(p => p.number === '1')
    expect(pin1).toBeDefined()
    expect(pin1!.name).toMatch(/GND/i)
  })

  it('U1 pin 8 is VCC', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const u1 = data.get('U1')!
    const pin8 = u1.pins.find(p => p.number === '8')
    expect(pin8).toBeDefined()
    expect(pin8!.name).toMatch(/VCC/i)
  })
})

// ─── no-connect ───────────────────────────────────────────────────────────────

describe('parseSchematicSimData — no-connects', () => {
  // KiCad writes a no-connect as a sheet-level (no_connect (at x y) (uuid ...))
  // with coordinates only (issue #49). The parser matches each marker against
  // the placed pin positions, so the tests use that shape and nothing else.
  const LIB = `(lib_symbols
    (symbol "Test:CHIP" (in_bom yes) (on_board yes)
      (symbol "CHIP_1_1"
        (pin input line (at 2 1 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin input line (at -2 -1 180) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
      )
      (symbol "CHIP_2_1"
        (pin input line (at 0 4 0) (length 2.54) (name "C" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
      )
    )
  )`
  function sch(rot: string, extra: string, markers: Array<[number, number]>, unit = 1): string {
    const nc = markers.map(([x, y]) => `(no_connect (at ${x} ${y}) (uuid "n"))`).join('\n  ')
    return `(kicad_sch (version 20231120) (generator eeschema)
  ${LIB}
  (symbol (lib_id "Test:CHIP") (at 50 50 ${rot}) ${extra} (unit ${unit})
    (property "Reference" "U9" (at 50 50 0))
    (property "Value" "CHIP" (at 50 50 0))
  )
  ${nc}
)`
  }

  it('the KiCad-form root no_connect in the fixture lands on U1 pin 5', () => {
    const data = parseSchematicSimData(fixture555SchText)
    expect(data.get('U1')!.noConnects).toEqual(['5'])
    expect(data.has('R1')).toBe(true)
  })

  it('an unrotated marker is matched to the pin with Y flipped into sheet coordinates', () => {
    // Pin 1 is at lib (2, 1): sheet (52, 49). Pin 2 is at lib (-2, -1): sheet (48, 51).
    const r = parseSchematicSimData(sch('0', '', [[52, 49]])).get('U9')!
    expect(r.noConnects).toEqual(['1'])
  })

  it('both pins can be marked, and order follows the library pin order', () => {
    const r = parseSchematicSimData(sch('0', '', [[48, 51], [52, 49]])).get('U9')!
    expect(r.noConnects).toEqual(['1', '2'])
  })

  it('applies the instance rotation (counter-clockwise)', () => {
    // Rotate 90: lib (2, 1) -> (-1, 2) -> sheet (49, 48).
    const r = parseSchematicSimData(sch('90', '', [[49, 48]])).get('U9')!
    expect(r.noConnects).toEqual(['1'])
    // The unrotated position no longer matches.
    expect(parseSchematicSimData(sch('90', '', [[52, 49]])).get('U9')!.noConnects).toEqual([])
  })

  it('applies (mirror x) and (mirror y)', () => {
    // mirror x flips Y: pin 1 lib (2, -1) -> sheet (52, 51).
    expect(parseSchematicSimData(sch('0', '(mirror x)', [[52, 51]])).get('U9')!.noConnects).toEqual(['1'])
    // mirror y flips X: pin 1 lib (-2, 1) -> sheet (48, 49).
    expect(parseSchematicSimData(sch('0', '(mirror y)', [[48, 49]])).get('U9')!.noConnects).toEqual(['1'])
  })

  it('rotates first and then mirrors (rot 90 with a mirror)', () => {
    // Pin 1 lib (2, 1), pin 2 lib (-2, -1). Rotate 90 -> pin 1 (-1, 2), pin 2 (1, -2).
    // mirror x flips Y: pin 1 -> sheet (49, 52), pin 2 -> sheet (51, 48).
    // Mirror-then-rotate would swap these, marking pin 1 at (51, 48).
    expect(parseSchematicSimData(sch('90', '(mirror x)', [[49, 52]])).get('U9')!.noConnects).toEqual(['1'])
    expect(parseSchematicSimData(sch('90', '(mirror x)', [[51, 48]])).get('U9')!.noConnects).toEqual(['2'])
    // mirror y flips X: pin 1 -> sheet (51, 48), pin 2 -> sheet (49, 52).
    expect(parseSchematicSimData(sch('90', '(mirror y)', [[51, 48]])).get('U9')!.noConnects).toEqual(['1'])
    expect(parseSchematicSimData(sch('90', '(mirror y)', [[49, 52]])).get('U9')!.noConnects).toEqual(['2'])
    // Rotate 270 -> pin 1 (1, -2); mirror x -> (1, 2) -> sheet (51, 48).
    expect(parseSchematicSimData(sch('270', '(mirror x)', [[51, 48]])).get('U9')!.noConnects).toEqual(['1'])
  })

  it('only considers pins of the placed unit', () => {
    // Unit 2's pin 3 is at lib (0, 4): sheet (50, 46). Placed as unit 1 it does not exist.
    expect(parseSchematicSimData(sch('0', '', [[50, 46]], 1)).get('U9')!.noConnects).toEqual([])
    expect(parseSchematicSimData(sch('0', '', [[50, 46]], 2)).get('U9')!.noConnects).toEqual(['3'])
  })

  it('a marker that touches no pin is ignored', () => {
    expect(parseSchematicSimData(sch('0', '', [[10, 10]])).get('U9')!.noConnects).toEqual([])
  })

  it('a nested (no_connect (pin "N")) shape KiCad never writes is not read', () => {
    const nested = `(kicad_sch (version 20211123) (generator eeschema)
  (symbol (lib_id "Device:R") (at 100 100 0) (unit 1)
    (property "Reference" "R9" (at 100 100 0))
    (no_connect (at 87.62 77.46) (pin "5") (uuid "nc000001-0000-0000-0000-000000000000"))
  )
)`
    expect(parseSchematicSimData(nested).get('R9')!.noConnects).toEqual([])
  })
})

// ─── symbols without Sim fields ───────────────────────────────────────────────

describe('parseSchematicSimData — symbols without Sim fields', () => {
  it('still appears with empty sim object for parts without Sim.* properties', () => {
    // Inline minimal schematic: one symbol with no Sim fields
    const minimalSch = `(kicad_sch (version 20211123) (generator eeschema)
  (lib_symbols
    (symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (in_bom yes) (on_board yes)
      (symbol "R_0_0"
        (pin passive line (at 1.016 0) (length 0) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
      )
    )
  )
  (symbol (lib_id "Device:R") (at 100 100 0) (unit 1)
    (property "Reference" "R9" (at 100 100 0))
    (property "Value" "1k" (at 100 100 0))
    (pin "1" (uuid "aaaaaaaa-0000-0000-0000-000000000001"))
    (pin "2" (uuid "aaaaaaaa-0000-0000-0000-000000000002"))
  )
)`
    const data = parseSchematicSimData(minimalSch)
    expect(data.has('R9')).toBe(true)
    const r9 = data.get('R9')!
    // sim should exist but be an empty object (no Sim.* keys)
    expect(r9.sim).toEqual({})
    // noConnects should be empty array
    expect(r9.noConnects).toEqual([])
  })
})

// ─── six Sim.* property keys ──────────────────────────────────────────────────

describe('parseSchematicSimData — all six Sim.* keys covered', () => {
  it('Sim.Device, Sim.Type, Sim.Params, Sim.Pins, Sim.Library, Sim.Name are extracted when present', () => {
    const schWithAllSim = `(kicad_sch (version 20211123) (generator eeschema)
  (lib_symbols
    (symbol "Device:C" (in_bom yes) (on_board yes)
      (symbol "C_0_0"
        (pin passive line (at 0 1.524) (length 0) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -1.524) (length 0) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
      )
    )
  )
  (symbol (lib_id "Device:C") (at 50 50 0) (unit 1)
    (property "Reference" "C99" (at 50 50 0))
    (property "Value" "100n" (at 50 50 0))
    (property "Sim.Device" "C" (at 50 50 0))
    (property "Sim.Type" "SPICE" (at 50 50 0))
    (property "Sim.Params" "C=100n" (at 50 50 0))
    (property "Sim.Pins" "1=p 2=n" (at 50 50 0))
    (property "Sim.Library" "mylib.lib" (at 50 50 0))
    (property "Sim.Name" "MYCAP" (at 50 50 0))
    (pin "1" (uuid "bbbbbbbb-0000-0000-0000-000000000001"))
    (pin "2" (uuid "bbbbbbbb-0000-0000-0000-000000000002"))
  )
)`
    const data = parseSchematicSimData(schWithAllSim)
    expect(data.has('C99')).toBe(true)
    const c99 = data.get('C99')!
    expect(c99.sim['Device']).toBe('C')
    expect(c99.sim['Type']).toBe('SPICE')
    expect(c99.sim['Params']).toBe('C=100n')
    expect(c99.sim['Pins']).toBe('1=p 2=n')
    expect(c99.sim['Library']).toBe('mylib.lib')
    expect(c99.sim['Name']).toBe('MYCAP')
  })
})

// ─── passive components have simple sim object ────────────────────────────────

describe('parseSchematicSimData — passive resistors', () => {
  it('R1 sim is an object (possibly empty for a simple resistor)', () => {
    const data = parseSchematicSimData(fixture555SchText)
    const r1 = data.get('R1')!
    expect(r1.sim).toBeDefined()
    expect(typeof r1.sim).toBe('object')
  })
})

// ─── flat scanning tolerance for hierarchical files ───────────────────────────

describe('parseSchematicSimData — hierarchical tolerance', () => {
  it('flat-scans all (symbol ...) instances without error on a simple file', () => {
    const data = parseSchematicSimData(fixture555SchText)
    // Just verifying the parse doesn't throw and returns all parts
    expect(data.size).toBeGreaterThan(0)
  })
})

// ─── fixture-555.kicad_pcb parses cleanly through parseBoard ─────────────────

describe('fixture-555.kicad_pcb — parseBoard round-trip', () => {
  const FIXTURE_555_PCB_PATH = join(__dirname, '../../../../fixtures/fixture-555.kicad_pcb')
  const fixture555PcbText = readFileSync(FIXTURE_555_PCB_PATH, 'utf-8')

  it('fixture-555 PCB parses without throwing', () => {
    expect(() => parseBoard(fixture555PcbText)).not.toThrow()
  })

  it('fixture-555 PCB has 7 named nets (VCC, GND, DISCH, THRES, OUT, LED_A, CTRL)', () => {
    const board = parseBoard(fixture555PcbText)
    expect(board.netById.size).toBe(7)
    const netNames = Array.from(board.netById.values()).map(n => n.name)
    expect(netNames).toContain('VCC')
    expect(netNames).toContain('GND')
    expect(netNames).toContain('DISCH')
    expect(netNames).toContain('THRES')
    expect(netNames).toContain('OUT')
    expect(netNames).toContain('LED_A')
    expect(netNames).toContain('CTRL')
  })

  it('fixture-555 PCB has 7 footprints (U1 + R1 + R2 + C1 + C2 + R3 + D1)', () => {
    const board = parseBoard(fixture555PcbText)
    expect(board.footprints).toHaveLength(7)
    const refs = board.footprints.map(f => f.ref)
    expect(refs).toContain('U1')
    expect(refs).toContain('R1')
    expect(refs).toContain('R2')
    expect(refs).toContain('C1')
    expect(refs).toContain('C2')
    expect(refs).toContain('R3')
    expect(refs).toContain('D1')
  })

  it('fixture-555 PCB U1 has 8 pads numbered 1-8', () => {
    const board = parseBoard(fixture555PcbText)
    const u1 = board.footprints.find(f => f.ref === 'U1')!
    expect(u1).toBeDefined()
    expect(u1.pads).toHaveLength(8)
    const padNumbers = u1.pads.map(p => p.number).sort()
    expect(padNumbers).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('fixture-555 PCB has 4 Edge.Cuts lines', () => {
    const board = parseBoard(fixture555PcbText)
    expect(board.edgeCuts).toHaveLength(4)
    for (const prim of board.edgeCuts) {
      expect(prim.kind).toBe('line')
    }
  })

  it('fixture-555 PCB outline stitches successfully', () => {
    const board = parseBoard(fixture555PcbText)
    expect(board.outline.outer).toHaveLength(1)
    expect(board.outline.holes).toHaveLength(0)
    // Board is 55x40mm
    const outer = board.outline.outer[0]
    const xs = outer.map(p => p.x)
    const ys = outer.map(p => p.y)
    expect(Math.max(...xs)).toBeCloseTo(55)
    expect(Math.max(...ys)).toBeCloseTo(40)
  })
})
