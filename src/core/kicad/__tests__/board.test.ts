/**
 * core/kicad/__tests__/board.test.ts
 *
 * Tests for parseBoard() — Task 3.
 * Written FIRST (TDD). All tests must fail before board.ts is implemented.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseBoard } from '../board'

// ─── load fixture ─────────────────────────────────────────────────────────────

const FIXTURE_RC_PATH = join(__dirname, '../../../../fixtures/fixture-rc.kicad_pcb')
const fixtureRcText = readFileSync(FIXTURE_RC_PATH, 'utf-8')

// ─── nets ─────────────────────────────────────────────────────────────────────

describe('parseBoard — nets', () => {
  it('parses 3 named nets (net 0 is ignored)', () => {
    const board = parseBoard(fixtureRcText)
    // net 0 "" is excluded
    expect(board.netById.has(0)).toBe(false)
    expect(board.netById.size).toBe(3)
    expect(board.netById.get(1)).toEqual({ id: 1, name: 'VIN' })
    expect(board.netById.get(2)).toEqual({ id: 2, name: 'OUT' })
    expect(board.netById.get(3)).toEqual({ id: 3, name: 'GND' })
  })
})

// ─── footprints ───────────────────────────────────────────────────────────────

describe('parseBoard — footprints', () => {
  it('parses 2 footprints with correct ref, value, libId', () => {
    const board = parseBoard(fixtureRcText)
    expect(board.footprints).toHaveLength(2)

    const r1 = board.footprints[0]
    expect(r1.ref).toBe('R1')
    expect(r1.value).toBe('10k')
    expect(r1.libId).toBe('Resistor_SMD:R_0805_2012Metric')

    const r2 = board.footprints[1]
    expect(r2.ref).toBe('R2')
    expect(r2.value).toBe('10k')
    expect(r2.libId).toBe('Resistor_SMD:R_0805_2012Metric')
  })

  it('parses footprint at positions correctly', () => {
    const board = parseBoard(fixtureRcText)
    const r1 = board.footprints[0]
    expect(r1.at.x).toBeCloseTo(10)
    expect(r1.at.y).toBeCloseTo(10)

    const r2 = board.footprints[1]
    expect(r2.at.x).toBeCloseTo(20)
    expect(r2.at.y).toBeCloseTo(10)
  })

  it('defaults rotDeg to 0 when the rotation token is absent', () => {
    // The fixture has (at 10 10) with no rotation — must NOT be NaN
    const board = parseBoard(fixtureRcText)
    const r1 = board.footprints[0]
    expect(r1.at.rotDeg).toBe(0)
    expect(Number.isNaN(r1.at.rotDeg)).toBe(false)
  })

  it('parses R1 pad 1 → netId 1, pad 2 → netId 2', () => {
    const board = parseBoard(fixtureRcText)
    const r1 = board.footprints[0]
    expect(r1.pads).toHaveLength(2)

    const pad1 = r1.pads.find(p => p.number === '1')!
    expect(pad1).toBeDefined()
    expect(pad1.netId).toBe(1)

    const pad2 = r1.pads.find(p => p.number === '2')!
    expect(pad2).toBeDefined()
    expect(pad2.netId).toBe(2)
  })

  it('parses R2 pad 1 → netId 2, pad 2 → netId 3', () => {
    const board = parseBoard(fixtureRcText)
    const r2 = board.footprints[1]

    const pad1 = r2.pads.find(p => p.number === '1')!
    expect(pad1.netId).toBe(2)

    const pad2 = r2.pads.find(p => p.number === '2')!
    expect(pad2.netId).toBe(3)
  })

  it('parses pad type and shape correctly', () => {
    const board = parseBoard(fixtureRcText)
    const pad = board.footprints[0].pads[0]
    expect(pad.type).toBe('smd')
    expect(pad.shape).toBe('roundrect')
  })

  it('parses pad layers list', () => {
    const board = parseBoard(fixtureRcText)
    const pad = board.footprints[0].pads[0]
    expect(pad.layers).toContain('F.Cu')
    expect(pad.layers).toContain('F.Paste')
    expect(pad.layers).toContain('F.Mask')
  })
})

// ─── tracks ───────────────────────────────────────────────────────────────────

describe('parseBoard — tracks', () => {
  it('parses 1 track segment with kind:segment, netId 2, widthMm 0.25', () => {
    const board = parseBoard(fixtureRcText)
    expect(board.tracks).toHaveLength(1)

    const seg = board.tracks[0]
    // TrackSegment discriminated union — must have kind:'segment'
    expect(seg.kind).toBe('segment')
    if (seg.kind === 'segment') {
      expect(seg.netId).toBe(2)
      expect(seg.widthMm).toBeCloseTo(0.25)
      expect(seg.layer).toBe('F.Cu')
      expect(seg.start.x).toBeCloseTo(10.9125)
      expect(seg.start.y).toBeCloseTo(10)
      expect(seg.end.x).toBeCloseTo(19.0875)
      expect(seg.end.y).toBeCloseTo(10)
    }
  })
})

// ─── board thickness ──────────────────────────────────────────────────────────

describe('parseBoard — board metadata', () => {
  it('parses board thickness 1.6 from (general (thickness 1.6))', () => {
    const board = parseBoard(fixtureRcText)
    expect(board.boardThicknessMm).toBeCloseTo(1.6)
  })
})

// ─── edgeCuts ─────────────────────────────────────────────────────────────────

describe('parseBoard — edgeCuts', () => {
  it('collects 4 EdgePrimitive entries all of kind:line', () => {
    const board = parseBoard(fixtureRcText)
    expect(board.edgeCuts).toHaveLength(4)
    for (const prim of board.edgeCuts) {
      expect(prim.kind).toBe('line')
    }
  })

  it('edgeCuts lines have correct start/end coordinates', () => {
    const board = parseBoard(fixtureRcText)
    const firstLine = board.edgeCuts[0]
    if (firstLine.kind === 'line') {
      expect(firstLine.start.x).toBeCloseTo(0)
      expect(firstLine.start.y).toBeCloseTo(0)
      expect(firstLine.end.x).toBeCloseTo(30)
      expect(firstLine.end.y).toBeCloseTo(0)
    }
  })
})

// ─── silkscreen ───────────────────────────────────────────────────────────────

describe('parseBoard — silkscreen', () => {
  it('collects ≥ 1 silkscreen entry (the gr_text on F.SilkS)', () => {
    const board = parseBoard(fixtureRcText)
    expect(board.silkscreen.length).toBeGreaterThanOrEqual(1)

    const grText = board.silkscreen.find(t => t.text === 'fixture-rc')
    expect(grText).toBeDefined()
    expect(grText!.layer).toBe('F.SilkS')
  })

  it('also collects fp_text reference labels from F.SilkS', () => {
    const board = parseBoard(fixtureRcText)
    const r1Label = board.silkscreen.find(t => t.text === 'R1')
    const r2Label = board.silkscreen.find(t => t.text === 'R2')
    expect(r1Label).toBeDefined()
    expect(r2Label).toBeDefined()
  })

  it('value text on F.Fab is NOT in silkscreen', () => {
    const board = parseBoard(fixtureRcText)
    // The value "10k" is on F.Fab, not F.SilkS — must not appear
    const fabText = board.silkscreen.find(t => t.layer === 'F.Fab')
    expect(fabText).toBeUndefined()
  })
})

// ─── KiCad 8 property form ────────────────────────────────────────────────────

describe('parseBoard — KiCad 8 (property ...) form', () => {
  it('reads ref and value from KiCad-8-style (property "Reference" ...) tokens', () => {
    // KiCad 8 style: (property "Reference" "R3") and (property "Value" "100k")
    // instead of fp_text reference/value
    const kicad8Footprint = `(kicad_pcb (version 20231120) (generator pcbnew)
  (general (thickness 1.6))
  (net 0 "")
  (net 1 "VIN")
  (footprint "Resistor_SMD:R_0402_1005Metric" (layer "F.Cu")
    (at 5 5)
    (property "Reference" "R3" (at 0 -1.3) (layer "F.SilkS"))
    (property "Value" "100k" (at 0 1.3) (layer "F.Fab"))
    (pad "1" smd rect (at -0.5 0) (size 0.7 0.9)
      (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "VIN"))
  )
)`
    const board = parseBoard(kicad8Footprint)
    expect(board.footprints).toHaveLength(1)
    const fp = board.footprints[0]
    expect(fp.ref).toBe('R3')
    expect(fp.value).toBe('100k')
  })
})

// ─── F.Silkscreen layer spelling ──────────────────────────────────────────────

describe('parseBoard — F.Silkscreen layer spelling', () => {
  it('accepts both F.SilkS and F.Silkscreen for silkscreen collection', () => {
    const withNewSpelling = `(kicad_pcb (version 20231120) (generator pcbnew)
  (general (thickness 1.6))
  (net 0 "")
  (gr_text "new-spelling" (at 5 5) (layer "F.Silkscreen")
    (effects (font (size 1 1) (thickness 0.15))))
)`
    const board = parseBoard(withNewSpelling)
    const entry = board.silkscreen.find(t => t.text === 'new-spelling')
    expect(entry).toBeDefined()
    expect(entry!.layer).toBe('F.Silkscreen')
  })
})

// ─── unknown token tolerance ──────────────────────────────────────────────────

describe('parseBoard — unknown token tolerance', () => {
  it('ignores unknown tokens at multiple nesting levels without throwing', () => {
    const withUnknown = `(kicad_pcb (version 20221018) (generator pcbnew)
  (zzz_future_field 42)
  (general (thickness 1.6) (zzz_unknown_nested foo bar))
  (net 0 "")
  (net 1 "VIN")
  (footprint "Resistor_SMD:R_0402" (layer "F.Cu")
    (at 5 5)
    (zzz_future_fp_field 99)
    (fp_text reference "R1" (at 0 -1) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -0.5 0) (size 0.7 0.9)
      (layers "F.Cu") (zzz_pad_future hello) (net 1 "VIN"))
  )
)`
    expect(() => parseBoard(withUnknown)).not.toThrow()
    const board = parseBoard(withUnknown)
    // Should still find the footprint
    expect(board.footprints).toHaveLength(1)
    expect(board.footprints[0].ref).toBe('R1')
  })
})

// ─── TrackSegment discriminated union shape ────────────────────────────────────

describe('parseBoard — TrackSegment discriminated union', () => {
  it('arc tracks have kind:arc and start/mid/end fields', () => {
    const withArc = `(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (net 0 "")
  (net 1 "VIN")
  (arc (start 10 10) (mid 15 5) (end 20 10) (width 0.25) (layer "F.Cu") (net 1))
)`
    const board = parseBoard(withArc)
    expect(board.tracks).toHaveLength(1)
    const arcTrack = board.tracks[0]
    expect(arcTrack.kind).toBe('arc')
    if (arcTrack.kind === 'arc') {
      expect(arcTrack.start.x).toBeCloseTo(10)
      expect(arcTrack.mid.x).toBeCloseTo(15)
      expect(arcTrack.mid.y).toBeCloseTo(5)
      expect(arcTrack.end.x).toBeCloseTo(20)
      expect(arcTrack.netId).toBe(1)
    }
  })
})

// ─── KiCad 9 / 2026 name-only net format ──────────────────────────────────────

describe('parseBoard — KiCad 9 (2026) name-only net format', () => {
  const FIXTURE_V9_PATH = join(__dirname, '../../../../fixtures/fixture-rc-v9.kicad_pcb')
  const fixtureV9Text = readFileSync(FIXTURE_V9_PATH, 'utf-8')

  it('synthesizes a net table from name-only references (no top-level net table)', () => {
    // KiCad 9/2026 dropped the numeric net id AND the top-level net table:
    // every reference is `(net "NAME")`. The parser must synthesize ids so the
    // rest of the pipeline (which keys on numeric ids) keeps working.
    const board = parseBoard(fixtureV9Text)
    // 3 distinct named nets: VIN, OUT, GND. The empty net is never referenced.
    expect(board.netById.size).toBe(3)
    const names = [...board.netById.values()].map(n => n.name).sort()
    expect(names).toEqual(['GND', 'OUT', 'VIN'])
    // Synthesized ids are positive integers, all distinct.
    const ids = [...board.netById.keys()]
    expect(ids.every(id => Number.isInteger(id) && id > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('assigns the SAME synthesized id to every reference of one net name', () => {
    // The connectivity guarantee: R1.pad2, R2.pad1, the segment and the via all
    // name "OUT", so they must all resolve to one shared id.
    const board = parseBoard(fixtureV9Text)
    const r1 = board.footprints[0]
    const r2 = board.footprints[1]
    const r1Pad2 = r1.pads.find(p => p.number === '2')!
    const r2Pad1 = r2.pads.find(p => p.number === '1')!
    expect(r1Pad2.netId).toBeDefined()
    expect(r1Pad2.netId).toBe(r2Pad1.netId)

    const seg = board.tracks[0]
    expect(seg.netId).toBe(r1Pad2.netId)
    expect(board.vias[0].netId).toBe(r1Pad2.netId)

    // And that shared id maps back to "OUT" in the synthesized table.
    expect(board.netById.get(r1Pad2.netId!)!.name).toBe('OUT')
  })

  it('distinct net names get distinct ids (VIN ≠ OUT ≠ GND)', () => {
    const board = parseBoard(fixtureV9Text)
    const r1 = board.footprints[0]
    const r2 = board.footprints[1]
    const vin = r1.pads.find(p => p.number === '1')!.netId
    const out = r1.pads.find(p => p.number === '2')!.netId
    const gnd = r2.pads.find(p => p.number === '2')!.netId
    expect(new Set([vin, out, gnd]).size).toBe(3)
    expect(board.netById.get(vin!)!.name).toBe('VIN')
    expect(board.netById.get(gnd!)!.name).toBe('GND')
  })

  it('still parses footprints, tracks and vias from the v9 file', () => {
    const board = parseBoard(fixtureV9Text)
    expect(board.footprints).toHaveLength(2)
    expect(board.footprints[0].ref).toBe('R1')
    expect(board.tracks).toHaveLength(1)
    expect(board.vias).toHaveLength(1)
  })
})

// ─── pad rotDeg default ───────────────────────────────────────────────────────

describe('parseBoard — pad rotDeg default', () => {
  it('defaults pad rotDeg to 0 when rotation is absent', () => {
    const board = parseBoard(fixtureRcText)
    for (const fp of board.footprints) {
      for (const pad of fp.pads) {
        expect(Number.isNaN(pad.at.rotDeg)).toBe(false)
        // All pads in the fixture have no rotation — should default to 0
        expect(pad.at.rotDeg).toBe(0)
      }
    }
  })
})
