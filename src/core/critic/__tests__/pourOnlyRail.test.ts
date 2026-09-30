/**
 * core/critic/__tests__/pourOnlyRail.test.ts
 *
 * The pour-only rail fixture (remediation plan, review focus 2; issues #10 and
 * #48): fixtures/synthetic/pour-only-rail-kicad10.kicad_pcb is a generator
 * board (scripts/gen-synthetic-board.mjs, preset pour-only-rail) whose VCC rail
 * is one F.Cu pour, a dumbbell with a 4 mm x 16 mm neck, and no VCC track at
 * all. test/corpus/synthetic.corpus.test.ts has kicad-cli confirm the board is
 * fully connected (zero unconnected items), so the pour really is the rail.
 *
 * Pre-fix the IR-drop check built no graph for it: no finding, no not-assessed
 * line, `ir-drop` still listed as run. The verdicts pinned here:
 *   - every load on the pour is a sink (none silently dropped);
 *   - the solved drop matches the pour's own resistance (the neck is 4 squares
 *     of 0.4828 mOhm, so a few mV at a few amps: quiet, and a real number);
 *   - the number does not depend on the mesh pitch beyond a small margin;
 *   - the ground return through vias to the B.Cu pour is solved too;
 *   - a current high enough to make the neck sag is reported, through the pour.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { buildContext } from '../context'
import { solveRail } from '../railGraph'
import { runCritic } from '../run'
import { DEFAULT_CRITIC_OPTIONS, type OpResult } from '../types'

const SHEET_OHMS = 1.68e-8 / 34.8e-6

const board = parseBoard(
  readFileSync(join(process.cwd(), 'fixtures', 'synthetic', 'pour-only-rail-kicad10.kicad_pcb'), 'utf8'),
)
const circuit = extract(board)
const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
const gnd = circuit.nets.find((n) => n.kicadName === 'GND')!

/** U1 draws `u1` A and U2 `u2` A from VCC (returned on their GND pads); C1 and J1 none. */
function opFor(u1: number, u2: number): OpResult {
  return {
    nodeVoltages: { [vcc.spiceNode]: 5 },
    partCurrents: { U1: u1, U2: u2, C1: 0 },
    padCurrents: {
      U1: { '8': u1, '4': -u1 },
      U2: { '8': u2, '4': -u2 },
      C1: { '1': 0, '2': 0 },
    },
  }
}

describe('pour-only rail fixture', () => {
  it('is what it says: no VCC track, one VCC pour, a B.Cu GND pour, vias', () => {
    expect(board.tracks.filter((t) => t.netId === vcc.id)).toHaveLength(0)
    expect(board.zones.filter((z) => z.netId === vcc.id && z.layer === 'F.Cu')).toHaveLength(1)
    expect(board.zones.filter((z) => z.netId === gnd.id && z.layer === 'B.Cu')).toHaveLength(1)
    expect(board.vias.filter((v) => v.netId === gnd.id).length).toBeGreaterThanOrEqual(3)
  })

  it('every load on the pour is a sink: the solve reaches all of them and strands none', () => {
    const ctx = buildContext(board, circuit, opFor(2, 1), DEFAULT_CRITIC_OPTIONS)
    const sol = solveRail(ctx, vcc.id, false)
    expect(sol).not.toBeNull()
    expect(sol!.source.ref).toBe('J1') // the connector is the supply entry
    expect(sol!.stranded).toHaveLength(0)
    expect(sol!.loads.map((l) => l.pad.ref).sort()).toEqual(['U1', 'U2'])
    expect(sol!.graph.hasPour).toBe(true)
  })

  it('is assessed and quiet: a few mV at a few amps is neither a false error nor a false zero', () => {
    const report = runCritic(board, circuit, opFor(2, 1))
    expect(report.findings.filter((f) => f.check === 'ir-drop')).toHaveLength(0)
    expect(report.ranBy).toContain('ir-drop')
    expect(report.skipped.find((s) => s.check === 'ir-drop')).toBeUndefined()
    expect(report.findings.filter((f) => f.check === 'ampacity')).toHaveLength(0)
  })

  it('solves to the pour resistance: U1 at 2 A, U2 (mid-neck) at 1 A', () => {
    const ctx = buildContext(board, circuit, opFor(2, 1), DEFAULT_CRITIC_OPTIONS)
    const sol = solveRail(ctx, vcc.id, false)!
    const u1 = sol.loads.find((l) => l.pad.ref === 'U1')!
    const u2 = sol.loads.find((l) => l.pad.ref === 'U2')!
    const dropU1 = -sol.volts[u1.pad.node]
    const dropU2 = -sol.volts[u2.pad.node]
    // The neck alone: 8 mm (2 squares) carrying 3 A, then 8 mm carrying 2 A.
    const neckOnlyU1 = SHEET_OHMS * (2 * 3 + 2 * 2)
    // Adding the two lobes' spreading stays within a factor of two of the neck.
    expect(dropU1).toBeGreaterThan(neckOnlyU1 * 0.95)
    expect(dropU1).toBeLessThan(neckOnlyU1 * 2)
    expect(dropU2).toBeGreaterThan(SHEET_OHMS * 2 * 3 * 0.95)
    expect(dropU2).toBeLessThan(dropU1) // U2 is upstream of U1
  })

  it('does not depend on the mesh pitch beyond a small margin', () => {
    const drops = [4, 2, 1].map((h) => {
      const ctx = buildContext(board, circuit, opFor(2, 1), { ...DEFAULT_CRITIC_OPTIONS, zoneMeshMm: h })
      const sol = solveRail(ctx, vcc.id, false)!
      return -sol.volts[sol.loads.find((l) => l.pad.ref === 'U1')!.pad.node]
    })
    const fine = drops[2]
    for (const d of drops) expect(Math.abs(d - fine) / fine).toBeLessThan(0.25)
  })

  it('solves the ground return through the vias and the B.Cu pour', () => {
    const ctx = buildContext(board, circuit, opFor(2, 1), DEFAULT_CRITIC_OPTIONS)
    const sol = solveRail(ctx, gnd.id, true)
    expect(sol).not.toBeNull()
    expect(sol!.stranded).toHaveLength(0)
    const rise = Math.max(...sol!.loads.map((l) => sol!.volts[l.pad.node]))
    expect(rise).toBeGreaterThan(0)
    // The vias dominate: about 1.4 mOhm each, J1's carrying all 3 A, plus the pad stubs.
    expect(rise).toBeLessThan(0.02)
  })

  it('reports a genuine sag through the pour, and names the pour as the copper', () => {
    // 60 A on a 4 mm neck is about 10 squares in series: ~0.29 V, 5.8 percent.
    const report = runCritic(board, circuit, opFor(60, 1))
    const f = report.findings.find((x) => x.check === 'ir-drop' && x.netId === vcc.id)
    expect(f).toBeDefined()
    expect(f!.refs).toContain('U1')
    expect(f!.title).toMatch(/pour/i)
    expect(f!.metrics!.dropV).toBeGreaterThan(0.1)
    expect(f!.severity).toBe('error')
  })
})
