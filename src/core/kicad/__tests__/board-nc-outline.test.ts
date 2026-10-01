/**
 * core/kicad/__tests__/board-nc-outline.test.ts
 *
 * Issues #49 and #50, the board side:
 *   - `(pintype "...+no_connect")` on a pad is read, and an NC-flagged pad does
 *     not produce a floating-pad warning (#49).
 *   - Edge.Cuts drawn as gr_poly, or as fp_* graphics inside a footprint, is
 *     stitched into the outline (#50).
 *   - Zero usable outline primitives and unsupported Edge.Cuts items produce a
 *     visible outline warning (#50).
 *   - A leading BOM is tolerated; KiCad 5 and older files get an explicit
 *     "save with KiCad 6 or newer" error (#50).
 *
 * The board snippets are hand-written in the KiCad 10 dialect (name-only nets,
 * stroke, uuid), the shapes KiCad itself writes.
 */

import { describe, expect, it } from 'vitest'

import { extract } from '../../netlist/extract'
import { parseBoard } from '../board'

function board(body: string, version = '20260206'): string {
  return `(kicad_pcb
  (version ${version})
  (generator "pcbnew")
  (general (thickness 1.6))
${body}
)`
}

function padXml(num: string, extra: string): string {
  return `(pad "${num}" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") ${extra})`
}

// ─── #49: pintype no_connect ──────────────────────────────────────────────────

describe('#49: pad pintype and no_connect', () => {
  const nc = board(`
  (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 10 10)
    (property "Reference" "U1" (at 0 0))
    (property "Value" "CHIP" (at 0 0))
    ${padXml('1', '(net "VIN") (pinfunction "VIN") (pintype "power_in")')}
    ${padXml('2', '(pinfunction "CFG2_2") (pintype "unspecified+no_connect")')}
    ${padXml('3', '(pinfunction "SENSE") (pintype "input")')}
  )`)

  it('parsePad reads pinfunction and pintype', () => {
    const fp = parseBoard(nc).footprints[0]
    const p1 = fp.pads.find((p) => p.number === '1')!
    expect(p1.pinFunction).toBe('VIN')
    expect(p1.pinType).toBe('power_in')
    const p2 = fp.pads.find((p) => p.number === '2')!
    expect(p2.pinFunction).toBe('CFG2_2')
    expect(p2.pinType).toBe('unspecified+no_connect')
  })

  it('an NC-flagged pad with no net does not produce a floating-pad warning', () => {
    const circuit = extract(parseBoard(nc))
    const floating = circuit.warnings.filter((w) => w.kind === 'floating-pad')
    // Pad 3 is genuinely unrouted (plain input, no net); pad 2 is NC-flagged.
    expect(floating.map((w) => (w as { pad: string }).pad)).toEqual(['3'])
  })

  it('an NC-flagged pad that IS wired to a net still joins that net', () => {
    const wired = board(`
  (footprint "X:Y" (layer "F.Cu") (at 0 0)
    (property "Reference" "U2" (at 0 0))
    (property "Value" "CHIP" (at 0 0))
    ${padXml('1', '(net "A") (pintype "unspecified+no_connect")')}
  )`)
    const circuit = extract(parseBoard(wired))
    expect(circuit.warnings.filter((w) => w.kind === 'floating-pad')).toHaveLength(0)
    expect(circuit.nets.some((n) => n.kicadName === 'A')).toBe(true)
  })
})

// ─── #50: outline primitives ──────────────────────────────────────────────────

const RECT_PTS = `(pts (xy 0 0) (xy 20 0) (xy 20 10) (xy 0 10))`

describe('#50: gr_poly outline', () => {
  it('a gr_poly on Edge.Cuts produces a closed outer loop', () => {
    const b = parseBoard(
      board(`(gr_poly ${RECT_PTS} (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "a"))`),
    )
    expect(b.edgeCuts.length).toBeGreaterThan(0)
    expect(b.outline.outer).toHaveLength(1)
    expect(b.outline.warnings).toEqual([])
    const xs = b.outline.outer[0].map((p) => p.x)
    const ys = b.outline.outer[0].map((p) => p.y)
    expect(Math.min(...xs)).toBeCloseTo(0)
    expect(Math.max(...xs)).toBeCloseTo(20)
    expect(Math.min(...ys)).toBeCloseTo(0)
    expect(Math.max(...ys)).toBeCloseTo(10)
  })

  it('a gr_poly on a non-Edge.Cuts layer is not an outline', () => {
    const b = parseBoard(board(`(gr_poly ${RECT_PTS} (fill yes) (layer "F.SilkS") (uuid "a"))`))
    expect(b.edgeCuts).toHaveLength(0)
  })
})

describe('#50: footprint Edge.Cuts', () => {
  function fpOutline(at: string, graphics: string): string {
    return board(`
  (footprint "Mech:Slot" (layer "F.Cu") (at ${at})
    (property "Reference" "H1" (at 0 0))
    (property "Value" "Slot" (at 0 0))
    ${graphics}
  )`)
  }

  it('fp_line on Edge.Cuts is collected, transformed by the footprint placement', () => {
    // 10 x 10 square centred on the footprint origin, footprint at (100, 50).
    const sq = [
      ['-5 -5', '5 -5'],
      ['5 -5', '5 5'],
      ['5 5', '-5 5'],
      ['-5 5', '-5 -5'],
    ]
      .map(([s, e]) => `(fp_line (start ${s}) (end ${e}) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts") (uuid "x"))`)
      .join('\n')
    const b = parseBoard(fpOutline('100 50', sq))
    expect(b.edgeCuts).toHaveLength(4)
    expect(b.outline.outer).toHaveLength(1)
    expect(b.outline.warnings).toEqual([])
    const xs = b.outline.outer[0].map((p) => p.x)
    const ys = b.outline.outer[0].map((p) => p.y)
    expect(Math.min(...xs)).toBeCloseTo(95)
    expect(Math.max(...xs)).toBeCloseTo(105)
    expect(Math.min(...ys)).toBeCloseTo(45)
    expect(Math.max(...ys)).toBeCloseTo(55)
  })

  it('the footprint rotation is applied with the KiCad sign convention', () => {
    // One line from (10, 0) to (10, 4) in a footprint rotated 90 degrees at the
    // origin. rotateKicad(x, y, 90) = (y, -x): (10, 0) -> (0, -10), (10, 4) -> (4, -10).
    const b = parseBoard(
      fpOutline(
        '0 0 90',
        `(fp_line (start 10 0) (end 10 4) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts") (uuid "x"))`,
      ),
    )
    expect(b.edgeCuts).toHaveLength(1)
    const line = b.edgeCuts[0]
    if (line.kind !== 'line') throw new Error('expected a line')
    expect(line.start.x).toBeCloseTo(0)
    expect(line.start.y).toBeCloseTo(-10)
    expect(line.end.x).toBeCloseTo(4)
    expect(line.end.y).toBeCloseTo(-10)
  })

  it('fp_rect, fp_circle, fp_arc and fp_poly on Edge.Cuts are collected', () => {
    const b = parseBoard(
      fpOutline(
        '10 10',
        `(fp_rect (start -2 -2) (end 2 2) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "a"))
         (fp_circle (center 20 0) (end 21 0) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "b"))
         (fp_arc (start 0 5) (mid 1 6) (end 2 5) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts") (uuid "c"))
         (fp_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "d"))`,
      ),
    )
    const kinds = b.edgeCuts.map((p) => p.kind)
    expect(kinds).toContain('circle')
    expect(kinds).toContain('arc')
    const circle = b.edgeCuts.find((p) => p.kind === 'circle')!
    if (circle.kind !== 'circle') throw new Error('unreachable')
    expect(circle.center.x).toBeCloseTo(30)
    expect(circle.center.y).toBeCloseTo(10)
    // rect (4 lines) + poly (3 lines) + arc + circle
    expect(b.edgeCuts).toHaveLength(9)
  })

  it('fp graphics on other layers are not outline', () => {
    const b = parseBoard(
      fpOutline(
        '0 0',
        `(fp_line (start 0 0) (end 1 1) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "x"))`,
      ),
    )
    expect(b.edgeCuts).toHaveLength(0)
  })

  it('a board outline plus a footprint cutout stitches into outer loop and hole', () => {
    const outer = `(gr_rect (start 0 0) (end 40 30) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "o"))`
    const slot = `
  (footprint "Mech:Slot" (layer "F.Cu") (at 20 15)
    (property "Reference" "H1" (at 0 0))
    (property "Value" "Slot" (at 0 0))
    (fp_circle (center 0 0) (end 2 0) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "s"))
  )`
    const b = parseBoard(board(outer + slot))
    expect(b.outline.outer).toHaveLength(1)
    expect(b.outline.holes).toHaveLength(1)
    expect(b.outline.warnings).toEqual([])
  })
})

// ─── #50: diagnostics ─────────────────────────────────────────────────────────

describe('#50: outline diagnostics', () => {
  it('a board with no Edge.Cuts at all carries a visible warning', () => {
    const b = parseBoard(board(''))
    expect(b.outline.outer).toHaveLength(0)
    expect(b.outline.warnings).toHaveLength(1)
    expect(b.outline.warnings[0]).toMatch(/no board outline found on the Edge\.Cuts layer/i)
  })

  it('an unsupported Edge.Cuts primitive is named in a warning', () => {
    const b = parseBoard(
      board(`
  (gr_rect (start 0 0) (end 10 10) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "o"))
  (gr_curve (pts (xy 0 0) (xy 1 1) (xy 2 1) (xy 3 0)) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts") (uuid "c"))`),
    )
    expect(b.outline.outer).toHaveLength(1)
    expect(b.outline.warnings.some((w) => w.includes('gr_curve'))).toBe(true)
  })

  it('an Edge.Cuts text item is not reported as an unsupported primitive', () => {
    const b = parseBoard(
      board(`
  (gr_rect (start 0 0) (end 10 10) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "o"))
  (gr_text "note" (at 5 5) (layer "Edge.Cuts") (uuid "t"))`),
    )
    expect(b.outline.warnings).toEqual([])
  })
})

describe('#50: file-format guards', () => {
  it('a leading UTF-8 BOM is tolerated', () => {
    const b = parseBoard('﻿' + board(`(gr_poly ${RECT_PTS} (fill no) (layer "Edge.Cuts") (uuid "a"))`))
    expect(b.outline.outer).toHaveLength(1)
  })

  it('a KiCad 5 (module ...) board is rejected with an explicit message', () => {
    const k5 = `(kicad_pcb (version 20171130) (host pcbnew 5.1.12)
  (module "Resistor_SMD:R_0402" (layer F.Cu) (tedit 5B301BBE) (tstamp 1) (at 10 10)
    (fp_text reference R1 (at 0 0) (layer F.SilkS) (effects (font (size 1 1) (thickness 0.15))))
  )
)`
    expect(() => parseBoard(k5)).toThrow(/KiCad 6 or newer/)
  })

  it('a pre-KiCad-6 version number is rejected even with no modules', () => {
    expect(() => parseBoard(board('', '20171130'))).toThrow(/KiCad 6 or newer/)
  })

  it('a non-board file still reports the root-node error', () => {
    expect(() => parseBoard('(kicad_sch (version 20211123))')).toThrow(/root node must be kicad_pcb/)
  })
})
