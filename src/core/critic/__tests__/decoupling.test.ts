/**
 * core/critic/__tests__/decoupling.test.ts
 *
 * TDD for the decoupling-proximity check (spec §5 item 5): every IC power pin
 * should have a small bypass cap on the same rail, placed close by. Boards are
 * built from inline kicad_pcb strings (style mirrors run.test.ts) with simple
 * coordinates so the pin↔cap distances are exact.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { runCritic } from '../run'
import { checkDecoupling } from '../checks/decoupling'

// A SOIC-8 IC "U1" whose pad 8 is on VCC (net 1) and pad 4 on GND (net 2). The
// caller passes a `cap` block (a 0402 capacitor C1) so each test can place it.
function board(cap: string) {
  return parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6))
    (net 0 "") (net 1 "VCC") (net 2 "GND") (net 3 "SIG")
    (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 10 10)
      (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (fp_text value "ATTINY85" (at 0 3) (layer "F.Fab")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at -2 1) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      (pad "2" smd rect (at -2 0) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      (pad "3" smd rect (at -2 -1) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      (pad "4" smd rect (at -2 -2) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
      (pad "5" smd rect (at 2 -2) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      (pad "6" smd rect (at 2 -1) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      (pad "7" smd rect (at 2 0) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
    )
    ${cap}
  )`)
}

/** A 100nF cap C1 wired VCC(net1)↔GND(net2), placed so its pad 1 lands at (x,y). */
function cap100nF(x: number, y: number) {
  return `(footprint "Capacitor_SMD:C_0402" (layer "F.Cu") (at ${x} ${y})
      (fp_text reference "C1" (at 0 -1) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (fp_text value "100nF" (at 0 1) (layer "F.Fab")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )`
}

function decoupFindings(cap: string) {
  const b = board(cap)
  const c = extract(b)
  // Exercise via the orchestrator so registration is covered too.
  return runCritic(b, c).findings.filter((f) => f.check === 'decoupling')
}

describe('checkDecoupling', () => {
  it('runs via the orchestrator and is reported in ranBy', () => {
    const b = board(cap100nF(12, 10))
    const report = runCritic(b, extract(b))
    expect(report.ranBy).toContain('decoupling')
  })

  it('emits NO finding when a 100nF cap sits ~2 mm from the power pin', () => {
    // U1 pad 8 (VCC) is at (10,10); C1 pad 1 (VCC) at (12,10) → 2 mm away (≤5).
    const findings = decoupFindings(cap100nF(12, 10))
    expect(findings).toHaveLength(0)
  })

  it('emits an error when the only decoupling cap is ~20 mm away (>15 mm)', () => {
    // C1 pad 1 (VCC) at (30,10) → 20 mm from U1 pad 8.
    const findings = decoupFindings(cap100nF(30, 10))
    expect(findings).toHaveLength(1)
    const f = findings[0]
    expect(f.severity).toBe('error')
    expect(f.id).toBe('decoupling:U1:1')
    expect(f.refs).toContain('U1')
    expect(f.refs).toContain('C1')
    expect(f.netId).toBe(1)
    expect(f.metrics!.distanceMm).toBeCloseTo(20)
    expect(f.title).toContain('15mm')
    // location is the IC power pin (10,10), not the cap.
    expect(f.location!.x).toBeCloseTo(10)
    expect(f.location!.y).toBeCloseTo(10)
  })

  it('emits a warn when the nearest cap is ~8 mm away (>5, ≤15 mm)', () => {
    // C1 pad 1 (VCC) at (18,10) → 8 mm from U1 pad 8.
    const findings = decoupFindings(cap100nF(18, 10))
    expect(findings).toHaveLength(1)
    const f = findings[0]
    expect(f.severity).toBe('warn')
    expect(f.metrics!.distanceMm).toBeCloseTo(8)
    expect(f.title).toContain('5mm')
  })

  it('emits an error when the power pin has NO bypass cap on that net', () => {
    // C1 is wired SIG↔GND, so it does not bypass VCC at all.
    const findings = decoupFindings(`(footprint "Capacitor_SMD:C_0402" (layer "F.Cu") (at 12 10)
      (fp_text reference "C1" (at 0 -1) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (fp_text value "100nF" (at 0 1) (layer "F.Fab")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )`)
    expect(findings).toHaveLength(1)
    const f = findings[0]
    expect(f.severity).toBe('error')
    expect(f.title).toContain('no decoupling capacitor')
    expect(f.title).toContain('VCC')
    expect(f.refs).toEqual(['U1'])
  })

  it('does NOT treat a large (electrolytic) cap as a bypass cap', () => {
    // A 10µF cap > 1µF threshold does not qualify → still "no decoupling cap".
    const findings = decoupFindings(`(footprint "Capacitor_SMD:C_0805" (layer "F.Cu") (at 12 10)
      (fp_text reference "C1" (at 0 -1) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (fp_text value "10uF" (at 0 1) (layer "F.Fab")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )`)
    expect(findings).toHaveLength(1)
    expect(findings[0].title).toContain('no decoupling capacitor')
  })

  it('is deterministic — same board yields the same findings', () => {
    const a = decoupFindings(cap100nF(30, 10))
    const b = decoupFindings(cap100nF(30, 10))
    expect(b).toEqual(a)
  })

  it('checkDecoupling can be called directly on a context', () => {
    // Sanity: the exported function works without the orchestrator wrapper.
    const b = board(cap100nF(12, 10))
    const c = extract(b)
    const ctx = {
      board: b,
      circuit: c,
      opResult: undefined,
      opts: {
        copperOz: 1,
        minClearanceMm: 0.2,
        irDropWarnPct: 2,
        irDropErrPct: 5,
        decouplingNearMm: 5,
        decouplingFarMm: 15,
        ambientC: 25,
        loopAreaWarnMm2: 100,
        loopAreaErrMm2: 500,
      },
      refToFootprint: new Map(b.footprints.map((fp) => [fp.ref, fp])),
      refToPart: new Map(c.parts.map((p) => [p.ref, p])),
    }
    expect(checkDecoupling(ctx)).toHaveLength(0)
  })
})
