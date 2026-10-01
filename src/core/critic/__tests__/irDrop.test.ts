/**
 * core/critic/__tests__/irDrop.test.ts
 *
 * TDD for the IR-drop check (spec §5 item 4): build a resistive graph of each
 * power rail's copper, inject the op-solved sink currents, nodal-solve, and
 * report the worst source→sink sag. Boards are built from inline kicad_pcb
 * strings (style mirrors ampacity.test.ts) with simple coordinates so the
 * expected resistances are exact.
 *
 * Known values (1 oz copper, ρ = 1.68e-8 Ω·m, t = 34.8 µm):
 *   R(100 mm, 0.25 mm) = 1.68e-8 · 0.1 / (0.25e-3 · 34.8e-6) ≈ 0.19310 Ω
 *   R( 50 mm, 0.25 mm)                                       ≈ 0.09655 Ω
 * With a 5 V nominal: 1 A → 0.193 V drop (−3.9%, warn: >2%);
 *                     2 A → 0.386 V drop (−7.7%, error: >5%).
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract, type Circuit } from '../../netlist/extract'
import { runCritic } from '../run'
import type { OpResult } from '../types'

// VCC = net 1, GND = net 2. J1 (a connector → preferred supply entry) sits at
// (10,10); U1 (the load) at (110,10). Each test supplies the copper in between.
function makeBoard(copper: string, u1PadLayer = 'F.Cu') {
  return parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6))
    (net 0 "") (net 1 "VCC") (net 2 "GND")
    (footprint "Connector_PinHeader_2.54mm:PinHeader_1x02" (layer "F.Cu") (at 10 10)
      (fp_text reference "J1" (at 0 -2) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 0 3) (size 1 1) (layers "F.Cu") (net 2 "GND"))
    )
    (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 110 10)
      (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "${u1PadLayer}") (net 1 "VCC"))
      (pad "4" smd rect (at 0 3) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )
    ${copper}
  )`)
}

/** OpResult with VCC pinned at `volts` (keyed by its spiceNode) + the given currents. */
function opFor(circuit: Circuit, currents: Record<string, number>, volts = 5): OpResult {
  const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
  return { nodeVoltages: { [vcc.spiceNode]: volts }, partCurrents: currents }
}

const LONG_THIN = `(segment (start 10 10) (end 110 10) (width 0.25) (layer "F.Cu") (net 1))`

function irFindings(board: ReturnType<typeof makeBoard>, op?: OpResult) {
  const circuit = extract(board)
  return runCritic(board, circuit, op).findings.filter((f) => f.check === 'ir-drop')
}

describe('checkIrDrop', () => {
  it('warns when a 100mm × 0.25mm VCC trace at 1 A sags ~3.9% (drop ≈ 0.193 V)', () => {
    const b = makeBoard(LONG_THIN)
    const c = extract(b)
    const findings = runCritic(b, c, opFor(c, { U1: 1 })).findings.filter(
      (f) => f.check === 'ir-drop',
    )
    expect(findings).toHaveLength(1)
    const f = findings[0]
    expect(f.severity).toBe('warn') // 3.9% is between warn (2%) and error (5%)
    expect(f.id).toBe('ir-drop:1')
    expect(f.netId).toBe(1)
    expect(f.refs).toContain('U1')
    expect(f.metrics!.dropV).toBeCloseTo(0.1931, 3)
    expect(f.metrics!.sagPct).toBeCloseTo(3.86, 1)
    expect(f.metrics!.nominalV).toBeCloseTo(5)
    // Anchored at the worst sink pad (U1 pad 8 at 110,10) for the 3D overlay.
    expect(f.location).toBeDefined()
    expect(f.location!.x).toBeCloseTo(110)
    expect(f.location!.y).toBeCloseTo(10)
    expect(f.title).toContain('VCC')
    expect(f.title).toContain('U1')
    expect(f.assumption).toBeDefined()
  })

  it('escalates to error at 2 A (~7.7% sag)', () => {
    const b = makeBoard(LONG_THIN)
    const c = extract(b)
    const [f] = runCritic(b, c, opFor(c, { U1: 2 })).findings.filter((f) => f.check === 'ir-drop')
    expect(f).toBeDefined()
    expect(f.severity).toBe('error')
    expect(f.metrics!.dropV).toBeCloseTo(0.3862, 3)
  })

  it('stays quiet on a wide trace (4 mm → ~0.24% sag)', () => {
    const b = makeBoard(`(segment (start 10 10) (end 110 10) (width 4) (layer "F.Cu") (net 1))`)
    const c = extract(b)
    expect(runCritic(b, c, opFor(c, { U1: 1 })).findings.filter((f) => f.check === 'ir-drop'))
      .toHaveLength(0)
  })

  it('stitches layers through a via (two 50mm halves + a 1.4 mΩ barrel)', () => {
    const b = makeBoard(
      `(segment (start 10 10) (end 60 10) (width 0.25) (layer "F.Cu") (net 1))
       (via (at 60 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
       (segment (start 60 10) (end 110 10) (width 0.25) (layer "B.Cu") (net 1))`,
      'B.Cu',
    )
    const c = extract(b)
    const [f] = runCritic(b, c, opFor(c, { U1: 1 })).findings.filter((f) => f.check === 'ir-drop')
    expect(f).toBeDefined()
    expect(f.severity).toBe('warn')
    // 0.09655 + 0.00143 (0.3 mm drill, 20 um plating, 1.6 mm board) + 0.09655 = 0.19453 V at 1 A
    expect(f.metrics!.dropV).toBeCloseTo(0.1945, 3)
  })

  it("does not count the source part's own current as a sink", () => {
    const b = makeBoard(LONG_THIN)
    const c = extract(b)
    // J1 is the supply entry; its 1 A must not be injected as a second load.
    const [f] = runCritic(b, c, opFor(c, { U1: 1, J1: 1 })).findings.filter(
      (f) => f.check === 'ir-drop',
    )
    expect(f).toBeDefined()
    expect(f.metrics!.dropV).toBeCloseTo(0.1931, 3)
  })

  it('emits no finding when the load current is zero', () => {
    const b = makeBoard(LONG_THIN)
    const c = extract(b)
    expect(runCritic(b, c, opFor(c, { U1: 0 })).findings.filter((f) => f.check === 'ir-drop'))
      .toHaveLength(0)
  })

  it('reports not assessed, not clean, when the op result carries no branch currents', () => {
    const b = makeBoard(LONG_THIN)
    const c = extract(b)
    const vcc = c.nets.find((n) => n.kicadName === 'VCC')!
    const op: OpResult = { nodeVoltages: { [vcc.spiceNode]: 5 } }
    const report = runCritic(b, c, op)
    expect(report.findings.filter((f) => f.check === 'ir-drop')).toHaveLength(0)
    expect(report.ranBy).not.toContain('ir-drop')
    expect(report.skipped.some((s) => s.check === 'ir-drop')).toBe(true)
  })

  it("emits no finding when the rail's nominal voltage is unknown", () => {
    const b = makeBoard(LONG_THIN)
    const c = extract(b)
    const op: OpResult = { nodeVoltages: {}, partCurrents: { U1: 1 } }
    expect(runCritic(b, c, op).findings.filter((f) => f.check === 'ir-drop')).toHaveLength(0)
  })

  it('is skipped when no operating-point sim is provided', () => {
    const b = makeBoard(LONG_THIN)
    const report = runCritic(b, extract(b))
    expect(report.ranBy).not.toContain('ir-drop')
    expect(report.skipped.some((s) => s.check === 'ir-drop')).toBe(true)
  })

  it('does not throw on degenerate copper (zero-length segment, disconnected sink)', () => {
    // The only VCC copper is a zero-length stub at the source; U1 is stranded.
    const b = makeBoard(`(segment (start 10 10) (end 10 10) (width 0.25) (layer "F.Cu") (net 1))`)
    const c = extract(b)
    expect(() => runCritic(b, c, opFor(c, { U1: 1 }))).not.toThrow()
    expect(irFindings(b, opFor(c, { U1: 1 }))).toHaveLength(0)
  })

  it('does not throw on a board with no tracks at all', () => {
    const b = makeBoard('')
    const c = extract(b)
    expect(() => runCritic(b, c, opFor(c, { U1: 1 }))).not.toThrow()
  })

  // Copper-weight scaling (issue #69). R = rho L / (w t), t = oz x 34.8 um.
  // The 100mm x 0.25mm trace is 0.1931 ohm at 1 oz, 0.0966 at 2 oz, 0.3862 at 0.5 oz.
  describe('copper weight', () => {
    function irAt(oz: number, amps: number) {
      const b = makeBoard(LONG_THIN)
      const c = extract(b)
      return runCritic(b, c, opFor(c, { U1: amps }), { copperOz: oz }).findings.find(
        (f) => f.check === 'ir-drop',
      )
    }

    it('2 oz halves the drop: 2 A over 100mm x 0.25mm sags 0.1931 V (same as 1 A at 1 oz)', () => {
      const f = irAt(2, 2)
      expect(f).toBeDefined()
      expect(f!.metrics!.dropV).toBeCloseTo(0.1931, 3)
      expect(f!.metrics!.sagPct).toBeCloseTo(3.86, 1)
      expect(f!.severity).toBe('warn')
    })

    it('0.5 oz doubles the drop: 0.5 A over 100mm x 0.25mm sags 0.1931 V', () => {
      const f = irAt(0.5, 0.5)
      expect(f).toBeDefined()
      expect(f!.metrics!.dropV).toBeCloseTo(0.1931, 3)
      expect(f!.severity).toBe('warn')
    })

    it('the same 1 A load warns at 1 oz but clean at 2 oz (0.0966 V, 1.9%)', () => {
      expect(irAt(1, 1)!.metrics!.dropV).toBeCloseTo(0.1931, 3)
      // 1.93% is under the 2% warn threshold, so heavier copper clears the finding.
      expect(irAt(2, 1)).toBeUndefined()
    })

    it('0.5 oz at 1 A escalates to error (0.3862 V, 7.7%)', () => {
      const f = irAt(0.5, 1)
      expect(f).toBeDefined()
      expect(f!.severity).toBe('error')
      expect(f!.metrics!.dropV).toBeCloseTo(0.3862, 3)
    })

    it('states the copper weight used in the assumption text', () => {
      expect(irAt(2, 2)!.assumption).toContain('2 oz copper')
      expect(irAt(0.5, 0.5)!.assumption).toContain('0.5 oz copper')
    })
  })
})
