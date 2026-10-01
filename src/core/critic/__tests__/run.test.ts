/**
 * core/critic/__tests__/run.test.ts
 *
 * TDD for C1: the no-sim checks (floating, clearance) + orchestrator.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { runCritic } from '../run'

const fixturesDir = join(__dirname, '../../../../fixtures')
function loadBoard(name: string) {
  return parseBoard(readFileSync(join(fixturesDir, name), 'utf-8'))
}

// ─── orchestrator ───────────────────────────────────────────────────────────────

describe('runCritic — orchestrator', () => {
  it('runs the no-sim checks and reports a severity summary', () => {
    const board = loadBoard('fixture-rc.kicad_pcb')
    const circuit = extract(board)
    const report = runCritic(board, circuit)

    expect(report.ranBy).toContain('floating')
    expect(report.ranBy).toContain('clearance')
    // summary counts match the findings array
    const counted = report.findings.reduce(
      (acc, f) => ((acc[f.severity] = (acc[f.severity] ?? 0) + 1), acc),
      {} as Record<string, number>,
    )
    expect(report.summary.error).toBe(counted.error ?? 0)
    expect(report.summary.warn).toBe(counted.warn ?? 0)
    expect(report.summary.info).toBe(counted.info ?? 0)
  })

  it('reports single-pad nets as info (fixture-rc VIN & GND each reach one pad)', () => {
    const board = loadBoard('fixture-rc.kicad_pcb')
    const circuit = extract(board)
    const report = runCritic(board, circuit)
    const single = report.findings.filter((f) => f.check === 'floating' && f.severity === 'info')
    const names = single.map((f) => f.title)
    expect(names.some((t) => t.includes('VIN'))).toBe(true)
    expect(names.some((t) => t.includes('GND'))).toBe(true)
  })
})

// ─── floating check ───────────────────────────────────────────────────────────────

describe('checkFloating', () => {
  it('flags a genuinely floating pad as a warning with a location', () => {
    // R9 pad 2 has no (net ...) → floating.
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "")
      (net 1 "VIN")
      (footprint "Resistor_SMD:R_0402" (layer "F.Cu") (at 10 10)
        (fp_text reference "R9" (at 0 -1) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "1" smd rect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VIN"))
        (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu"))
      )
    )`
    const board = parseBoard(text)
    const circuit = extract(board)
    const report = runCritic(board, circuit)
    const floating = report.findings.find(
      (f) => f.check === 'floating' && f.severity === 'warn' && f.refs?.includes('R9'),
    )
    expect(floating).toBeDefined()
    expect(floating!.location).toBeDefined()
    // pad 2 is at footprint (10,10) + offset (0.5,0) → (10.5,10)
    expect(floating!.location!.x).toBeCloseTo(10.5)
    expect(floating!.location!.y).toBeCloseTo(10)
  })

  it('gives unique ids to multiple unnamed (exposed/thermal) floating pads', () => {
    // A QFN-style part with two unnumbered, unconnected exposed pads.
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "")
      (footprint "Package_DFN_QFN:QFN-16" (layer "F.Cu") (at 5 5)
        (fp_text reference "U4" (at 0 -1) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "" smd rect (at -0.5 0) (size 1 1) (layers "F.Cu"))
        (pad "" smd rect (at 0.5 0) (size 1 1) (layers "F.Cu"))
      )
    )`
    const board = parseBoard(text)
    const circuit = extract(board)
    const report = runCritic(board, circuit)
    const blanks = report.findings.filter((f) => f.check === 'floating' && f.refs?.includes('U4'))
    expect(blanks).toHaveLength(2)
    expect(new Set(blanks.map((f) => f.id)).size).toBe(2) // ids unique
    expect(blanks[0].title).toContain('exposed/thermal')
  })

  it('does NOT flag KiCad intentional unconnected-(...) nets', () => {
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "")
      (net 7 "unconnected-(U1-PadX)")
      (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 5 5)
        (fp_text reference "U1" (at 0 -1) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "1" smd rect (at -1 0) (size 0.5 0.6) (layers "F.Cu") (net 7 "unconnected-(U1-PadX)"))
      )
    )`
    const board = parseBoard(text)
    const circuit = extract(board)
    const report = runCritic(board, circuit)
    expect(report.findings.some((f) => f.title.includes('unconnected-'))).toBe(false)
  })
})

// ─── clearance check ──────────────────────────────────────────────────────────────

describe('checkClearance', () => {
  const baseEdge = `
    (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts") (width 0.1))
    (gr_line (start 40 0) (end 40 40) (layer "Edge.Cuts") (width 0.1))
    (gr_line (start 40 40) (end 0 40) (layer "Edge.Cuts") (width 0.1))
    (gr_line (start 0 40) (end 0 0) (layer "Edge.Cuts") (width 0.1))`

  const twoTrackBoard = (w1: number, w2: number, offsetMm: number) =>
    parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "A") (net 2 "B")
      (segment (start 10 20) (end 30 20) (width ${w1}) (layer "F.Cu") (net 1))
      (segment (start 10 ${20 + offsetMm}) (end 30 ${20 + offsetMm}) (width ${w2}) (layer "F.Cu") (net 2))
      ${baseEdge}
    )`)
  const clearance = (b: ReturnType<typeof parseBoard>) =>
    runCritic(b, extract(b)).findings.filter((f) => f.check === 'clearance')

  it('flags two different-net tracks whose copper edges are closer than the min clearance', () => {
    // Two 0.25 mm tracks, centerlines 0.35 mm apart: copper gap 0.35 - 0.25 = 0.10 mm (< 0.2).
    const c = clearance(twoTrackBoard(0.25, 0.25, 0.35))
    expect(c).toHaveLength(1)
    expect(c[0].severity).toBe('warn')
    expect(c[0].metrics!.gapMm).toBeCloseTo(0.1, 6)
  })

  it('treats overlapping copper as an error even when the centerlines clear the minimum (issue #11)', () => {
    // Two 1.0 mm tracks, centerlines 0.6 mm apart: copper overlaps by 0.4 mm.
    const c = clearance(twoTrackBoard(1.0, 1.0, 0.6))
    expect(c).toHaveLength(1)
    expect(c[0].severity).toBe('error')
    expect(c[0].title).toContain('touch or overlap')
    expect(c[0].metrics!.gapMm).toBeCloseTo(-0.4, 6)
  })

  it('does NOT flag wide tracks whose copper gap meets the minimum', () => {
    // 1.0 mm tracks, centerlines 1.25 mm apart: copper gap 0.25 mm (>= 0.2).
    expect(clearance(twoTrackBoard(1.0, 1.0, 1.25))).toEqual([])
  })

  it('uses each track own half width (mixed widths)', () => {
    // 1.0 mm and 0.2 mm tracks, centerlines 0.65 mm apart: gap = 0.65 - 0.6 = 0.05 mm.
    const c = clearance(twoTrackBoard(1.0, 0.2, 0.65))
    expect(c).toHaveLength(1)
    expect(c[0].severity).toBe('warn')
    expect(c[0].metrics!.gapMm).toBeCloseTo(0.05, 6)
  })

  it('finds a crossing pair among many non-conflicting tracks, with the original ids', () => {
    // Index the conflicting pair at positions 3 and 7 of a larger track list.
    const segs: string[] = []
    for (let k = 0; k < 10; k++) {
      const y = 2 + k * 3
      const net = k === 3 ? 1 : k === 7 ? 2 : 1
      const yy = k === 7 ? 2 + 3 * 3 + 0.3 : y
      segs.push(`(segment (start 5 ${yy}) (end 35 ${yy}) (width 0.25) (layer "F.Cu") (net ${net}))`)
    }
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "A") (net 2 "B")
      ${segs.join('\n')}
      ${baseEdge}
    )`
    const c = clearance(parseBoard(text))
    expect(c.map((f) => f.id)).toEqual(['clearance:t3-t7'])
    expect(c[0].metrics!.gapMm).toBeCloseTo(0.05, 6)
  })

  it('does NOT flag well-separated same-net tracks', () => {
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "A")
      (segment (start 10 10) (end 30 10) (width 0.25) (layer "F.Cu") (net 1))
      (segment (start 10 25) (end 30 25) (width 0.25) (layer "F.Cu") (net 1))
      ${baseEdge}
    )`
    const board = parseBoard(text)
    const circuit = extract(board)
    const report = runCritic(board, circuit)
    expect(report.findings.filter((f) => f.check === 'clearance' && f.severity !== 'info')).toHaveLength(0)
  })

  it('flags a track running too close to the board edge', () => {
    // Track at y=0.1 mm, parallel to the bottom edge (y=0) → < 0.2 mm.
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "A")
      (segment (start 10 0.1) (end 30 0.1) (width 0.25) (layer "F.Cu") (net 1))
      ${baseEdge}
    )`
    const board = parseBoard(text)
    const circuit = extract(board)
    const report = runCritic(board, circuit)
    expect(report.findings.some((f) => f.id.startsWith('clearance:edge'))).toBe(true)
  })

  it('measures track-to-edge clearance from the copper edge, not the centerline', () => {
    // 0.25 mm track, centerline 0.3 mm from the edge (clears 0.2 by centerline):
    // the copper edge is 0.3 - 0.125 = 0.175 mm from the outline, a warning.
    const warnText = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "A")
      (segment (start 10 0.3) (end 30 0.3) (width 0.25) (layer "F.Cu") (net 1))
      ${baseEdge}
    )`
    const warn = clearance(parseBoard(warnText)).filter((f) => f.id.startsWith('clearance:edge'))
    expect(warn).toHaveLength(1)
    expect(warn[0].severity).toBe('warn')
    expect(warn[0].metrics!.gapMm).toBeCloseTo(0.175, 6)

    // A 1.0 mm track whose centerline is 0.3 mm from the edge sticks out past it.
    const errText = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "A")
      (segment (start 10 0.3) (end 30 0.3) (width 1.0) (layer "F.Cu") (net 1))
      ${baseEdge}
    )`
    const err = clearance(parseBoard(errText)).filter((f) => f.id.startsWith('clearance:edge'))
    expect(err).toHaveLength(1)
    expect(err[0].severity).toBe('error')
    expect(err[0].metrics!.gapMm).toBeCloseTo(-0.2, 6)
  })
})
