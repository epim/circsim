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

  it('flags two different-net tracks closer than the min clearance', () => {
    // Two parallel F.Cu tracks 0.1 mm apart (< default 0.2), different nets.
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "A") (net 2 "B")
      (segment (start 10 20) (end 30 20) (width 0.25) (layer "F.Cu") (net 1))
      (segment (start 10 20.1) (end 30 20.1) (width 0.25) (layer "F.Cu") (net 2))
      ${baseEdge}
    )`
    const board = parseBoard(text)
    const circuit = extract(board)
    const report = runCritic(board, circuit)
    const c = report.findings.filter((f) => f.check === 'clearance' && f.severity === 'warn')
    expect(c.length).toBeGreaterThanOrEqual(1)
    expect(c[0].metrics!.gapMm).toBeCloseTo(0.1, 2)
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
})
