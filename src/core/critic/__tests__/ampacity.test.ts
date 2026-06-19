/**
 * core/critic/__tests__/ampacity.test.ts
 *
 * TDD for the trace-ampacity check (spec §5). A board with a VCC rail and a
 * synthetic operating-point (partCurrents summing to ~2 A of rail current) is
 * checked against the IPC-2221 external-layer capacity of the rail's narrowest
 * track. Currents are constructed by hand and passed as runCritic's 3rd arg.
 *
 * Rail current = Σ|part currents on the net| / 2. With U1=+3 A and LOAD1=+1 A
 * both on VCC, the sum is 4 A → estimated rail current ≈ 2 A.
 *
 * IPC-2221 (1 oz, ΔT 10°C): a 0.25 mm trace is rated ≈ 0.88 A; a 1.0 mm trace
 * ≈ 2.39 A.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { runCritic } from '../run'
import type { OpResult } from '../types'

// VCC = net 1, GND = net 2. U1 and LOAD1 both draw from VCC; one VCC track of
// the given width carries the rail. The caller sets the track width.
function board(trackWidthMm: number) {
  return parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6))
    (net 0 "") (net 1 "VCC") (net 2 "GND")
    (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 10 10)
      (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
      (pad "4" smd rect (at -2 -2) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )
    (footprint "Resistor_SMD:R_0805" (layer "F.Cu") (at 20 10)
      (fp_text reference "LOAD1" (at 0 -1) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at -1 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 1 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )
    (segment (start 10 10) (end 20 10) (width ${trackWidthMm}) (layer "F.Cu") (net 1))
  )`)
}

// partCurrents summing (abs) to `total` across U1 + LOAD1 → rail current total/2.
function op(total: number): OpResult {
  return {
    nodeVoltages: {},
    partCurrents: { U1: (total * 3) / 4, LOAD1: total / 4 },
  }
}

function ampFindings(trackWidthMm: number, opResult: OpResult) {
  const b = board(trackWidthMm)
  const c = extract(b)
  return runCritic(b, c, opResult).findings.filter((f) => f.check === 'ampacity')
}

describe('checkAmpacity', () => {
  it('errors when a 0.25mm trace carries ~2A (rated ~0.88A)', () => {
    const findings = ampFindings(0.25, op(4)) // Σ|I| = 4 → rail ≈ 2 A
    const f = findings.find((x) => x.netId === 1)
    expect(f).toBeDefined()
    expect(f!.severity).toBe('error') // 2 A > 1.5 × ~0.88 A
    expect(f!.id).toBe('ampacity:1')
    expect(f!.metrics!.currentA).toBeCloseTo(2)
    expect(f!.metrics!.widthMm).toBeCloseTo(0.25)
    expect(f!.metrics!.ratedA).toBeLessThan(2)
  })

  it('does NOT flag a 1.0mm trace at ~2A (rated ~2.39A)', () => {
    const findings = ampFindings(1.0, op(4)) // rail ≈ 2 A < 2.39 A
    expect(findings.find((x) => x.netId === 1)).toBeUndefined()
  })

  it('does NOT flag a 0.25mm trace at ~0.4A (rated ~0.88A)', () => {
    const findings = ampFindings(0.25, op(0.8)) // Σ|I| = 0.8 → rail ≈ 0.4 A
    expect(findings.find((x) => x.netId === 1)).toBeUndefined()
  })

  it('is skipped when no operating-point sim is provided', () => {
    const b = board(0.25)
    const report = runCritic(b, extract(b))
    expect(report.ranBy).not.toContain('ampacity')
    expect(report.skipped.some((s) => s.check === 'ampacity')).toBe(true)
  })

  it('returns no findings when partCurrents is missing despite an opResult', () => {
    const findings = ampFindings(0.25, { nodeVoltages: {} })
    expect(findings).toHaveLength(0)
  })
})
