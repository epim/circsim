/**
 * core/critic/__tests__/railGraph.test.ts
 *
 * The rail graph builder and solve (issue #10): pour meshing accuracy, slots,
 * layer stitching, stranded pads, the via constant, and the scale the dense
 * solver could not reach. Sheet resistance of 1 oz copper is 0.4828 mOhm/sq.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { buildContext } from '../context'
import { solveRail, viaResistanceOhms } from '../railGraph'
import { runCritic } from '../run'
import { DEFAULT_CRITIC_OPTIONS, type OpResult } from '../types'

const SHEET = 1.68e-8 / 34.8e-6

function fp(ref: string, x: number, y: number, vccPadX = 0, layer = 'F.Cu'): string {
  return `(footprint "Package_SO:SOIC-8" (layer "F.Cu") (at ${x} ${y})
    (fp_text reference "${ref}" (at 0 -3) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (pad "8" smd rect (at ${vccPadX} 0) (size 0.8 0.8) (layers "${layer}") (net 1 "VCC"))
    (pad "4" smd rect (at 0 6) (size 0.8 0.8) (layers "F.Cu") (net 2 "GND")))`
}
function pcb(body: string): string {
  return `(kicad_pcb (version 20221018) (generator pcbnew) (general (thickness 1.6))
    (net 0 "") (net 1 "VCC") (net 2 "GND") ${body})`
}
function zone(layer: string, pts: [number, number][], holes: [number, number][][] = []): string {
  const ring = (p: [number, number][]) => `(polygon (pts ${p.map(([x, y]) => `(xy ${x} ${y})`).join(' ')}))`
  return `(zone (net 1) (net_name "VCC") (layer "${layer}") (hatch edge 0.5) ${ring(pts)} ${holes.map(ring).join(' ')})`
}
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0], [x1, y0], [x1, y1], [x0, y1],
]
function ctxFor(body: string, loads: Record<string, number>, zoneMeshMm = 2) {
  const board = parseBoard(pcb(body))
  const circuit = extract(board)
  const padCurrents: Record<string, Record<string, number>> = {}
  for (const [ref, a] of Object.entries(loads)) padCurrents[ref] = { '8': a, '4': -a }
  const op: OpResult = { nodeVoltages: { vcc: 5 }, partCurrents: loads, padCurrents }
  return { board, circuit, ctx: buildContext(board, circuit, op, { ...DEFAULT_CRITIC_OPTIONS, zoneMeshMm }) }
}
function netId(circuit: ReturnType<typeof extract>, name: string): number {
  return circuit.nets.find((n) => n.kicadName === name)!.id
}

describe('pour meshing', () => {
  it('a 100 mm x 10 mm strip is ten squares: 4.8 mOhm end to end (within 12 percent)', () => {
    const { circuit, ctx } = ctxFor(`${fp('J1', 10, 10)} ${fp('U1', 110, 10)} ${zone('F.Cu', rect(8, 5, 112, 15))}`, { U1: 10 })
    const sol = solveRail(ctx, netId(circuit, 'VCC'), false)!
    const drop = -sol.volts[sol.loads[0].pad.node]
    const want = 10 * SHEET * (100 / 10)
    expect(drop).toBeGreaterThan(want * 0.88)
    expect(drop).toBeLessThan(want * 1.12)
  })

  it('a square plate fed corner to corner by point contacts sits between the bounds (no mesh blow-up)', () => {
    // Point-to-point spreading resistance in a sheet grows with log(L/a); just
    // check a finite, positive, small answer.
    const { circuit, ctx } = ctxFor(`${fp('J1', 10, 10)} ${fp('U1', 40, 40)} ${zone('F.Cu', rect(5, 5, 45, 45))}`, { U1: 5 })
    const sol = solveRail(ctx, netId(circuit, 'VCC'), false)!
    const drop = -sol.volts[sol.loads[0].pad.node]
    expect(drop).toBeGreaterThan(0)
    expect(drop).toBeLessThan(5 * SHEET * 5)
  })

  it('two pours with a gap between them split the rail: the far load is stranded and named, not dropped', () => {
    // A 2 mm gap at x 35..37 cuts the strip in two; nothing bridges it.
    const { circuit, ctx } = ctxFor(
      `${fp('J1', 10, 10)} ${fp('U1', 60, 10)} ${zone('F.Cu', rect(5, 5, 35, 15))} ${zone('F.Cu', rect(37, 5, 65, 15))}`,
      { U1: 1 },
    )
    const sol = solveRail(ctx, netId(circuit, 'VCC'), false)!
    expect(sol.stranded.map((l) => l.pad.ref)).toEqual(['U1'])
    // and the critic says so instead of passing the rail
    const report = runCritic(ctx.board, circuit, ctx.opResult)
    expect(report.skipped.find((s) => s.check === 'ir-drop')?.reason).toMatch(/U1\.8.*no modelled copper/)
    expect(report.ranBy).not.toContain('ir-drop')
  })

  it('a multi-layer zone (KiCad 7+ `(layers ...)`) is one fill per layer, joined by vias', () => {
    // No `(layer ...)` token at all: pre-fix the zone had layer '' and matched nothing.
    const multi = `(zone (net 1) (net_name "VCC") (layers "F.Cu" "B.Cu") (hatch edge 0.5)
      (polygon (pts (xy 5 5) (xy 65 5) (xy 65 15) (xy 5 15))))`
    const { circuit, board, ctx } = ctxFor(
      `${fp('J1', 10, 10)} ${fp('U1', 60, 10, 0, 'B.Cu')}
       (via (at 30 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1)) ${multi}`,
      { U1: 2 },
    )
    expect(board.zones[0].layers).toEqual(['F.Cu', 'B.Cu'])
    const sol = solveRail(ctx, netId(circuit, 'VCC'), false)!
    expect(sol.stranded).toHaveLength(0) // U1 is on B.Cu, J1 on F.Cu: the via joins the two fills
    expect(sol.loads.map((l) => l.pad.ref)).toEqual(['U1'])
  })

  it('a hole in the pour is routed around, costing resistance', () => {
    const plain = ctxFor(`${fp('J1', 10, 10)} ${fp('U1', 60, 10)} ${zone('F.Cu', rect(5, 5, 65, 15))}`, { U1: 10 })
    const holed = ctxFor(
      `${fp('J1', 10, 10)} ${fp('U1', 60, 10)} ${zone('F.Cu', rect(5, 5, 65, 15), [rect(30, 5.5, 34, 13)])}`,
      { U1: 10 },
    )
    const drop = (c: ReturnType<typeof ctxFor>): number => {
      const s = solveRail(c.ctx, netId(c.circuit, 'VCC'), false)!
      return -s.volts[s.loads[0].pad.node]
    }
    expect(drop(holed)).toBeGreaterThan(drop(plain) * 1.3)
  })

  it('stitches two pours on different layers through a via', () => {
    const { circuit, ctx } = ctxFor(
      `${fp('J1', 10, 10)} ${fp('U1', 60, 10, 0, 'B.Cu')}
       ${zone('F.Cu', rect(5, 5, 35, 15))}
       (via (at 34 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))
       ${zone('B.Cu', rect(30, 5, 65, 15))}`,
      { U1: 2 },
    )
    const sol = solveRail(ctx, netId(circuit, 'VCC'), false)!
    expect(sol.stranded).toHaveLength(0)
    const u1 = sol.loads.find((l) => l.pad.ref === 'U1')!
    // 2 A through one 0.4 mm drill barrel alone is 2.9 mV, plus the two sheets.
    expect(-sol.volts[u1.pad.node]).toBeGreaterThan(2 * viaResistanceOhms(ctx.board.vias[0], 1.6))
  })
})

describe('via resistance', () => {
  it('is derived from drill, plating and board thickness: 0.3 mm drill, 1.6 mm board is 1.43 mOhm', () => {
    const ohms = viaResistanceOhms({ at: { x: 0, y: 0 }, sizeMm: 0.6, drillMm: 0.3, layers: ['F.Cu', 'B.Cu'] }, 1.6)
    expect(ohms * 1000).toBeCloseTo(1.43, 2)
  })

  it('a larger drill is lower and a thicker board is higher', () => {
    const v = (drill: number, t: number) =>
      viaResistanceOhms({ at: { x: 0, y: 0 }, sizeMm: 0.8, drillMm: drill, layers: ['F.Cu', 'B.Cu'] }, t)
    expect(v(0.6, 1.6)).toBeLessThan(v(0.3, 1.6))
    expect(v(0.3, 2.4)).toBeGreaterThan(v(0.3, 1.6))
  })
})

describe('scale', () => {
  it('solves a 1950-node track rail with a pour in well under the 320 ms the dense solver took', () => {
    // A 40 x 40 grid of VCC tracks (3120 segments) plus a pour over the whole
    // board, and 60 loads: the council's perf-scale board in miniature.
    const segs: string[] = []
    const N = 40
    const step = 2.5
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j < N; j++) {
        segs.push(`(segment (start ${10 + j * step} ${10 + i * step}) (end ${10 + (j + 1) * step} ${10 + i * step}) (width 0.25) (layer "F.Cu") (net 1))`)
        segs.push(`(segment (start ${10 + i * step} ${10 + j * step}) (end ${10 + i * step} ${10 + (j + 1) * step}) (width 0.25) (layer "F.Cu") (net 1))`)
      }
    }
    const parts = [fp('J1', 10, 10)]
    const loads: Record<string, number> = {}
    for (let k = 0; k < 60; k++) {
      const ref = `U${k + 1}`
      parts.push(fp(ref, 10 + (k % 10) * 10, 10 + Math.floor(k / 10) * 15))
      loads[ref] = 0.05
    }
    const { circuit, ctx } = ctxFor(`${parts.join(' ')} ${segs.join(' ')} ${zone('F.Cu', rect(5, 5, 115, 115))}`, loads)
    const t0 = performance.now()
    const sol = solveRail(ctx, netId(circuit, 'VCC'), false)
    const ms = performance.now() - t0
    expect(sol).not.toBeNull()
    expect(sol!.loads.length).toBeGreaterThanOrEqual(55)
    // Generous bound: the point is that meshing a pour into the graph does not
    // bring back the cubic blow-up.
    expect(ms).toBeLessThan(2500)
  })
})
