/**
 * core/critic/__tests__/loopArea.test.ts
 *
 * TDD for the loop-area heuristic (spec §5 item 7, stretch): for clock/
 * high-speed-looking signal nets, loop area ≈ Σ(segment length × distance to
 * nearest ground copper). A ground zone under a segment counts as zero.
 *
 * Fixture geometry: an 80 mm CLK trace at y=10.
 *   - GND return trace at y=13 → gap 3 mm → area ≈ 240 mm² (warn: >100 mm²)
 *   - GND return trace at y=50 → gap 40 mm → area ≈ 3200 mm² (error: >500 mm²)
 *   - same far return + a GND pour under the trace → area ≈ 0 (no finding)
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { runCritic } from '../run'
import { HIGH_SPEED_NET_RE } from '../checks/loopArea'

// Net 1 is the signal under test (name parametrized), net 2 is GND. U1 drives
// the signal from (10,10); U2 receives it at (90,10). Both have GND pads so the
// GND net exists in the extracted circuit.
function makeBoard(net1Name: string, copper: string) {
  return parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6))
    (net 0 "") (net 1 "${net1Name}") (net 2 "GND")
    (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 10 10)
      (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "${net1Name}"))
      (pad "4" smd rect (at 0 3) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )
    (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 90 10)
      (fp_text reference "U2" (at 0 -3) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "${net1Name}"))
      (pad "4" smd rect (at 0 3) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )
    ${copper}
  )`)
}

const SIG_TRACE = `(segment (start 10 10) (end 90 10) (width 0.25) (layer "F.Cu") (net 1))`
const GND_NEAR = `(segment (start 10 13) (end 90 13) (width 0.25) (layer "F.Cu") (net 2))`
const GND_FAR = `(segment (start 10 50) (end 90 50) (width 0.25) (layer "F.Cu") (net 2))`
const GND_POUR = `(zone (net 2) (net_name "GND") (layer "B.Cu")
      (polygon (pts (xy 0 0) (xy 100 0) (xy 100 20) (xy 0 20))))`

function loopFindings(net1Name: string, copper: string) {
  const b = makeBoard(net1Name, copper)
  const c = extract(b)
  return runCritic(b, c).findings.filter((f) => f.check === 'loop-area')
}

describe('checkLoopArea', () => {
  it('runs without a simulation and is reported in ranBy', () => {
    const b = makeBoard('CLK', SIG_TRACE + GND_NEAR)
    const report = runCritic(b, extract(b))
    expect(report.ranBy).toContain('loop-area')
    expect(report.skipped.some((s) => s.check === 'loop-area')).toBe(false)
  })

  it('warns on a CLK trace with its ground return 3 mm away (area ≈ 240 mm²)', () => {
    const findings = loopFindings('CLK', SIG_TRACE + GND_NEAR)
    expect(findings).toHaveLength(1)
    const f = findings[0]
    expect(f.severity).toBe('warn')
    expect(f.id).toBe('loop-area:1')
    expect(f.netId).toBe(1)
    expect(f.metrics!.loopAreaMm2).toBeCloseTo(240, 0)
    expect(f.title).toContain('CLK')
    expect(f.title.toLowerCase()).toContain('loop area')
    // Anchored on the worst-contributing segment for the 3D overlay.
    expect(f.location).toBeDefined()
    expect(f.location!.x).toBeCloseTo(50)
    expect(f.location!.y).toBeCloseTo(10)
    // Explicitly a v1 heuristic — the finding must say so.
    expect(`${f.detail} ${f.assumption ?? ''}`.toLowerCase()).toContain('heuristic')
  })

  it('errors on a CLK trace whose only ground return is 40 mm away (area ≈ 3200 mm²)', () => {
    const findings = loopFindings('CLK', SIG_TRACE + GND_FAR)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('error')
    expect(findings[0].metrics!.loopAreaMm2).toBeCloseTo(3200, 0)
  })

  it('does NOT flag the same trace when a ground pour sits under it', () => {
    expect(loopFindings('CLK', SIG_TRACE + GND_FAR + GND_POUR)).toHaveLength(0)
  })

  it('ignores nets that do not look clock/high-speed', () => {
    expect(loopFindings('SENSE', SIG_TRACE + GND_FAR)).toHaveLength(0)
  })

  it('emits nothing (and does not throw) when the board has no ground copper', () => {
    const b = makeBoard('CLK', SIG_TRACE)
    const c = extract(b)
    expect(() => runCritic(b, c)).not.toThrow()
    expect(runCritic(b, c).findings.filter((f) => f.check === 'loop-area')).toHaveLength(0)
  })

  it('does not throw on a zero-length signal segment', () => {
    const b = makeBoard(
      'CLK',
      `(segment (start 10 10) (end 10 10) (width 0.25) (layer "F.Cu") (net 1))` + GND_NEAR,
    )
    const c = extract(b)
    expect(() => runCritic(b, c)).not.toThrow()
  })
})

describe('HIGH_SPEED_NET_RE', () => {
  it.each(['CLK', 'SPI_SCK', '/mcu/USB_D+', 'XTAL1', 'UART_TX', 'SCL', 'MISO'])(
    'matches %s',
    (name) => {
      expect(HIGH_SPEED_NET_RE.test(name)).toBe(true)
    },
  )

  it.each(['VCC', 'SENSE', 'GND', 'LED1'])('does not match %s', (name) => {
    expect(HIGH_SPEED_NET_RE.test(name)).toBe(false)
  })
})
