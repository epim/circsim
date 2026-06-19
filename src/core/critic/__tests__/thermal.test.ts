/**
 * core/critic/__tests__/thermal.test.ts
 *
 * TDD for the first-order thermal-proxy check. The check produces a RELATIVE
 * heat-spread proxy (arbitrary units), never an absolute °C.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { runCritic } from '../run'
import type { OpResult } from '../types'

/**
 * A square board with an Edge.Cuts outline and a footprint per (ref,x,y).
 * Each footprint is a 2-pad part so it has geometry; pads carry no nets (the
 * thermal check only uses footprint positions + supplied partPower).
 */
function makeBoardText(size: number, parts: { ref: string; x: number; y: number }[]): string {
  const edge = `
    (gr_line (start 0 0) (end ${size} 0) (layer "Edge.Cuts") (width 0.1))
    (gr_line (start ${size} 0) (end ${size} ${size}) (layer "Edge.Cuts") (width 0.1))
    (gr_line (start ${size} ${size}) (end 0 ${size}) (layer "Edge.Cuts") (width 0.1))
    (gr_line (start 0 ${size}) (end 0 0) (layer "Edge.Cuts") (width 0.1))`
  const fps = parts
    .map(
      (p) => `
    (footprint "Package_TO_SOT_SMD:SOT-23" (layer "F.Cu") (at ${p.x} ${p.y})
      (fp_text reference "${p.ref}" (at 0 -1) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu"))
      (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu"))
    )`,
    )
    .join('\n')
  return `(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6))
    (net 0 "")
    ${fps}
    ${edge}
  )`
}

function build(size: number, parts: { ref: string; x: number; y: number }[]) {
  const board = parseBoard(makeBoardText(size, parts))
  const circuit = extract(board)
  return { board, circuit }
}

describe('checkThermal', () => {
  it('flags adjacent high-power parts as a hot cluster, but not when spread to opposite corners', () => {
    const SIZE = 50
    const op: OpResult = { nodeVoltages: {}, partPower: { Q1: 1, Q2: 1 } }

    // Adjacent: both near the centre, a few mm apart.
    const adjacent = build(SIZE, [
      { ref: 'Q1', x: 24, y: 25 },
      { ref: 'Q2', x: 26, y: 25 },
    ])
    const adjReport = runCritic(adjacent.board, adjacent.circuit, op)
    const adjWarn = adjReport.findings.filter(
      (f) => f.check === 'thermal' && f.severity === 'warn',
    )
    expect(adjWarn.length).toBeGreaterThanOrEqual(1)
    expect(adjWarn[0].refs).toEqual(expect.arrayContaining(['Q1', 'Q2']))

    // Spread: opposite corners.
    const spread = build(SIZE, [
      { ref: 'Q1', x: 4, y: 4 },
      { ref: 'Q2', x: 46, y: 46 },
    ])
    const spreadReport = runCritic(spread.board, spread.circuit, op)
    const spreadWarn = spreadReport.findings.filter(
      (f) => f.check === 'thermal' && f.severity === 'warn',
    )
    expect(spreadWarn.length).toBe(0)

    // Sanity: adjacent peak proxy ≥ spread peak proxy (the warmest-info metric).
    const peak = (r: typeof adjReport) =>
      Math.max(
        ...r.findings
          .filter((f) => f.check === 'thermal' && f.severity === 'info')
          .map((f) => f.metrics?.proxy ?? 0),
      )
    expect(peak(adjReport)).toBeGreaterThanOrEqual(peak(spreadReport))
  })

  it('produces no thermal findings when partPower is absent/zero, and skips thermal when no opResult', () => {
    const { board, circuit } = build(50, [
      { ref: 'Q1', x: 10, y: 10 },
      { ref: 'Q2', x: 40, y: 40 },
    ])

    // No opResult at all → thermal is skipped (needs:'op').
    const noOp = runCritic(board, circuit)
    expect(noOp.findings.some((f) => f.check === 'thermal')).toBe(false)
    expect(noOp.skipped.some((s) => s.check === 'thermal')).toBe(true)

    // opResult present but all power ≤ 0 → ran, but nothing to assess.
    const zeroOp: OpResult = { nodeVoltages: {}, partPower: { Q1: 0, Q2: 0 } }
    const zeroReport = runCritic(board, circuit, zeroOp)
    expect(zeroReport.findings.some((f) => f.check === 'thermal')).toBe(false)
    expect(zeroReport.ranBy).toContain('thermal')

    // opResult present but partPower omitted → also nothing.
    const noPower: OpResult = { nodeVoltages: {} }
    const noPowerReport = runCritic(board, circuit, noPower)
    expect(noPowerReport.findings.some((f) => f.check === 'thermal')).toBe(false)
  })

  it('names the highest-power component in the warmest-part info finding', () => {
    const { board, circuit } = build(50, [
      { ref: 'Q1', x: 12, y: 12 },
      { ref: 'U1', x: 38, y: 38 },
    ])
    const op: OpResult = { nodeVoltages: {}, partPower: { Q1: 0.3, U1: 2.5 } }
    const report = runCritic(board, circuit, op)

    const info = report.findings.find(
      (f) => f.check === 'thermal' && f.severity === 'info',
    )
    expect(info).toBeDefined()
    expect(info!.refs).toContain('U1')
    expect(info!.title).toContain('U1')
    // Never claims an absolute °C.
    expect(info!.title).not.toMatch(/°C/)
    expect(info!.detail).not.toMatch(/\d\s*°C/)
    expect(info!.metrics?.watts).toBeCloseTo(2.5)
    expect(info!.location).toBeDefined()
    expect(info!.location!.x).toBeCloseTo(38)
    expect(info!.location!.y).toBeCloseTo(38)
  })
})
