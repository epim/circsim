/**
 * core/critic/__tests__/ampacity.test.ts
 *
 * The trace-ampacity check rates each track against the current the copper
 * solve puts through it (issues #9 and #45), not against a lumped per-rail
 * estimate. Currents are given as the signed pad currents a bench solve
 * produces (draw on the supply pad, the same current returned on the ground
 * pad), passed as runCritic's 3rd argument.
 *
 * IPC-2221 (1 oz, dT 10 C): 0.15 mm is rated about 0.60 A, 0.25 mm about
 * 0.88 A, 1.0 mm about 2.39 A.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { runCritic } from '../run'
import type { OpResult } from '../types'

// VCC = net 1, GND = net 2. J1 (connector, the supply entry) at (10,10), D1 (the
// load) 49 mm away at (59,10), C1 a bypass cap off the ground return.
function board(copper: string) {
  return parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6))
    (net 0 "") (net 1 "VCC") (net 2 "GND")
    (footprint "Connector_PinHeader_2.54mm:PinHeader_1x02" (layer "F.Cu") (at 10 10)
      (fp_text reference "J1" (at 0 -2) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 0 4) (size 1 1) (layers "F.Cu") (net 2 "GND"))
    )
    (footprint "LED_SMD:LED_0805_2012Metric" (layer "F.Cu") (at 59 10)
      (fp_text reference "D1" (at 0 -2) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 0.8 0.8) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 0 4) (size 0.8 0.8) (layers "F.Cu") (net 2 "GND"))
    )
    (footprint "Capacitor_SMD:C_0402_1005Metric" (layer "F.Cu") (at 35 20)
      (fp_text reference "C1" (at 0 -2) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu") (net 2 "GND"))
      (pad "2" smd rect (at 0 2) (size 0.5 0.5) (layers "F.Cu") (net 1 "VCC"))
    )
    ${copper}
  )`)
}

/** A load D1 drawing `amps`: current in at its VCC pad, out at its GND pad. */
function loadOp(amps: number): OpResult {
  return {
    nodeVoltages: { vcc: 5 },
    partCurrents: { D1: amps, C1: 0 },
    padCurrents: { D1: { '1': amps, '2': -amps }, C1: { '1': 0, '2': 0 } },
  }
}

const VCC = (w: number) => `(segment (start 10 10) (end 59 10) (width ${w}) (layer "F.Cu") (net 1))`
// Return path: a fat ground track from D1 back to J1.
const GND_RETURN = `(segment (start 59 14) (end 10 14) (width 2) (layer "F.Cu") (net 2))`

function ampFindings(copper: string, op: OpResult) {
  const b = board(copper)
  const c = extract(b)
  return runCritic(b, c, op).findings.filter((f) => f.check === 'ampacity')
}

describe('checkAmpacity', () => {
  it('flags a 1.0 A LED on a 0.15 mm track (rated ~0.60 A): the feed is not halved (issue #45)', () => {
    // 49 mm x 0.15 mm VCC. The old sum/2 estimate said 0.5 A and passed it.
    const findings = ampFindings(`${VCC(0.15)} ${GND_RETURN}`, loadOp(1.0))
    const f = findings.find((x) => x.netId === 1)
    expect(f).toBeDefined()
    expect(f!.id).toBe('ampacity:1')
    expect(f!.metrics!.currentA).toBeCloseTo(1.0, 2)
    expect(f!.metrics!.widthMm).toBeCloseTo(0.15)
    expect(f!.metrics!.ratedA).toBeCloseTo(0.6, 1)
    expect(f!.severity).toBe('error') // 1.0 A > 1.5 x 0.60 A
  })

  it('warns when the current is between the rating and 1.5 times it', () => {
    const f = ampFindings(`${VCC(0.25)} ${GND_RETURN}`, loadOp(1.1)).find((x) => x.netId === 1)
    expect(f).toBeDefined()
    expect(f!.severity).toBe('warn') // 0.88 A rated, 1.1 A carried
  })

  it('does NOT flag a 1.0 mm track at 2 A (rated ~2.39 A)', () => {
    expect(ampFindings(`${VCC(1.0)} ${GND_RETURN}`, loadOp(2)).find((x) => x.netId === 1)).toBeUndefined()
  })

  it('does NOT flag a 0.25 mm track at 0.4 A (rated ~0.88 A)', () => {
    expect(ampFindings(`${VCC(0.25)} ${GND_RETURN}`, loadOp(0.4)).find((x) => x.netId === 1)).toBeUndefined()
  })

  it('does not flag a bypass-cap stub on the return for the rail current (issue #45, false-positive half)', () => {
    // 1.5 A returns through the fat ground track. C1 hangs off it on a 0.15 mm
    // stub and carries nothing at DC. The lumped estimate charged the stub
    // with the whole rail (0.75 A against 0.60 A rated).
    const split = `(segment (start 59 14) (end 35 14) (width 2) (layer "F.Cu") (net 2))
      (segment (start 35 14) (end 10 14) (width 2) (layer "F.Cu") (net 2))`
    const stub = `(segment (start 35 14) (end 35 20) (width 0.15) (layer "F.Cu") (net 2))`
    const findings = ampFindings(`${VCC(1.0)} ${split} ${stub}`, loadOp(1.5))
    expect(findings.find((x) => x.netId === 2)).toBeUndefined()
  })

  it('rates a thin track under a same-net pour by the current it really carries', () => {
    // 5 A on a 0.25 mm track would fuse it; under a 10 mm wide pour bonded along
    // its whole length it carries almost none of it.
    const pour = `(zone (net 1) (net_name "VCC") (layer "F.Cu") (hatch edge 0.5)
      (polygon (pts (xy 5 5) (xy 65 5) (xy 65 15) (xy 5 15))))`
    const findings = ampFindings(`${VCC(0.25)} ${pour} ${GND_RETURN}`, loadOp(5))
    expect(findings.find((x) => x.netId === 1)).toBeUndefined()
  })

  it('is skipped when no operating-point sim is provided', () => {
    const b = board(VCC(0.25))
    const report = runCritic(b, extract(b))
    expect(report.ranBy).not.toContain('ampacity')
    expect(report.skipped.some((s) => s.check === 'ampacity')).toBe(true)
  })

  it('reports not assessed, not clean, when the op carries no branch currents (issue #9)', () => {
    const b = board(VCC(0.15))
    const report = runCritic(b, extract(b), { nodeVoltages: { vcc: 5 } })
    expect(report.findings.filter((f) => f.check === 'ampacity')).toHaveLength(0)
    expect(report.ranBy).not.toContain('ampacity')
    expect(report.skipped.find((s) => s.check === 'ampacity')?.reason).toMatch(/current/i)
  })
})
