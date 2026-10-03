import { haveNativeCopper } from './nativeCopper'
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
import { nativeRunCritic as runCritic } from './nativeCopper'
import type { CriticOptions, OpResult } from '../types'

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

async function ampFindings(copper: string, op: OpResult, opts?: Partial<CriticOptions>) {
  const b = board(copper)
  const c = extract(b)
  return (await runCritic(b, c, op, opts)).findings.filter((f) => f.check === 'ampacity')
}

describe.skipIf(!haveNativeCopper)('checkAmpacity', () => {
  it('flags a 1.0 A LED on a 0.15 mm track (rated ~0.60 A): the feed is not halved (issue #45)', async () => {
    // 49 mm x 0.15 mm VCC. The old sum/2 estimate said 0.5 A and passed it.
    const findings = (await ampFindings(`${VCC(0.15)} ${GND_RETURN}`, loadOp(1.0)))
    const f = findings.find((x) => x.netId === 1)
    expect(f).toBeDefined()
    expect(f!.id).toBe('ampacity:1')
    expect(f!.metrics!.currentA).toBeCloseTo(1.0, 2)
    expect(f!.metrics!.widthMm).toBeCloseTo(0.15)
    expect(f!.metrics!.ratedA).toBeCloseTo(0.6, 1)
    expect(f!.severity).toBe('error') // 1.0 A > 1.5 x 0.60 A
  })

  it('warns when the current is between the rating and 1.5 times it', async () => {
    const f = (await ampFindings(`${VCC(0.25)} ${GND_RETURN}`, loadOp(1.1))).find((x) => x.netId === 1)
    expect(f).toBeDefined()
    expect(f!.severity).toBe('warn') // 0.88 A rated, 1.1 A carried
  })

  it('does NOT flag a 1.0 mm track at 2 A (rated ~2.39 A)', async () => {
    expect((await ampFindings(`${VCC(1.0)} ${GND_RETURN}`, loadOp(2))).find((x) => x.netId === 1)).toBeUndefined()
  })

  it('does NOT flag a 0.25 mm track at 0.4 A (rated ~0.88 A)', async () => {
    expect((await ampFindings(`${VCC(0.25)} ${GND_RETURN}`, loadOp(0.4))).find((x) => x.netId === 1)).toBeUndefined()
  })

  it('does not flag a bypass-cap stub on the return for the rail current (issue #45, false-positive half)', async () => {
    // 1.5 A returns through the fat ground track. C1 hangs off it on a 0.15 mm
    // stub and carries nothing at DC. The lumped estimate charged the stub
    // with the whole rail (0.75 A against 0.60 A rated).
    const split = `(segment (start 59 14) (end 35 14) (width 2) (layer "F.Cu") (net 2))
      (segment (start 35 14) (end 10 14) (width 2) (layer "F.Cu") (net 2))`
    const stub = `(segment (start 35 14) (end 35 20) (width 0.15) (layer "F.Cu") (net 2))`
    const findings = (await ampFindings(`${VCC(1.0)} ${split} ${stub}`, loadOp(1.5)))
    expect(findings.find((x) => x.netId === 2)).toBeUndefined()
  })

  it('rates a thin track under a same-net pour by the current it really carries', async () => {
    // 5 A on a 0.25 mm track would fuse it; under a 10 mm wide pour bonded along
    // its whole length it carries almost none of it.
    const pour = `(zone (net 1) (net_name "VCC") (layer "F.Cu") (hatch edge 0.5)
      (polygon (pts (xy 5 5) (xy 65 5) (xy 65 15) (xy 5 15))))`
    const findings = (await ampFindings(`${VCC(0.25)} ${pour} ${GND_RETURN}`, loadOp(5)))
    expect(findings.find((x) => x.netId === 1)).toBeUndefined()
  })

  it('is skipped when no operating-point sim is provided', async () => {
    const b = board(VCC(0.25))
    const report = (await runCritic(b, extract(b)))
    expect(report.ranBy).not.toContain('ampacity')
    expect(report.skipped.some((s) => s.check === 'ampacity')).toBe(true)
  })

  it('reports not assessed, not clean, when the op carries no branch currents (issue #9)', async () => {
    const b = board(VCC(0.15))
    const report = (await runCritic(b, extract(b), { nodeVoltages: { vcc: 5 } }))
    expect(report.findings.filter((f) => f.check === 'ampacity')).toHaveLength(0)
    expect(report.ranBy).not.toContain('ampacity')
    expect(report.skipped.find((s) => s.check === 'ampacity')?.reason).toMatch(/current/i)
  })

  // Copper-weight scaling (issue #69). IPC-2221: I = k dT^0.44 A^0.725 with
  // A = width_mil x thickness_mil, so rated current scales as oz^0.725.
  describe.skipIf(!haveNativeCopper)('copper weight', () => {
    // Independent closed form for a 0.25 mm external trace at 1 oz (1.378 mil).
    const RAIL = `${VCC(0.25)} ${GND_RETURN}`
    const widthMil = 0.25 / 0.0254
    const rated = (oz: number) =>
      0.048 * Math.pow(10, 0.44) * Math.pow(widthMil * 1.378 * oz, 0.725)

    it('rated current for 0.25mm matches the IPC-2221 closed form at 0.5, 1 and 2 oz', async () => {
      for (const oz of [0.5, 1, 2]) {
        // A 2 A load, above the rating at every weight tested.
        const f = (await ampFindings(RAIL, loadOp(2), { copperOz: oz })).find((x) => x.netId === 1)
        expect(f, `${oz} oz`).toBeDefined()
        expect(f!.metrics!.ratedA).toBeCloseTo(rated(oz), 9)
      }
      // Pinned absolute values: 0.25mm rates ~0.88 A at 1 oz (see header).
      expect(rated(1)).toBeCloseTo(0.88, 1)
      expect(rated(2)).toBeCloseTo(1.45, 1)
      expect(rated(0.5)).toBeCloseTo(0.53, 1)
    })

    it('2 oz raises the rating by 2^0.725 and 0.5 oz lowers it by the same factor', async () => {
      const r1 = (await ampFindings(RAIL, loadOp(2), { copperOz: 1 }))[0].metrics!.ratedA
      const r2 = (await ampFindings(RAIL, loadOp(2), { copperOz: 2 }))[0].metrics!.ratedA
      const rHalf = (await ampFindings(RAIL, loadOp(2), { copperOz: 0.5 }))[0].metrics!.ratedA
      expect(r2 / r1).toBeCloseTo(Math.pow(2, 0.725), 9)
      expect(r1 / rHalf).toBeCloseTo(Math.pow(2, 0.725), 9)
      expect(r2).toBeGreaterThan(r1)
      expect(rHalf).toBeLessThan(r1)
    })

    it('a 1.2 A rail on 0.25mm is flagged at 1 oz but clean at 2 oz (rated ~1.45 A)', async () => {
      const load = loadOp(1.2)
      expect((await ampFindings(RAIL, load, { copperOz: 1 })).find((x) => x.netId === 1)).toBeDefined()
      expect((await ampFindings(RAIL, load, { copperOz: 2 })).find((x) => x.netId === 1)).toBeUndefined()
    })

    it('a 0.7 A rail on 0.25mm is clean at 1 oz but flagged at 0.5 oz (rated ~0.53 A)', async () => {
      const load = loadOp(0.7)
      expect((await ampFindings(RAIL, load, { copperOz: 1 })).find((x) => x.netId === 1)).toBeUndefined()
      expect((await ampFindings(RAIL, load, { copperOz: 0.5 })).find((x) => x.netId === 1)).toBeDefined()
    })
  })
})
