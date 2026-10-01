/**
 * core/critic/__tests__/irDrop.supplyEntry.test.ts
 *
 * Issue #47: the IR-drop check used to guess the supply entry pad from a
 * connector-ref regex. The user's bench lead (its copper position, stored by the
 * sidecar and the store) now names the entry; the guess is the fallback and the
 * finding says which one it used.
 *
 * Board: 5 V VCC, U1 at (110,10) draws 1 A. A far feed enters 100 mm away through
 * 0.25 mm track (3.9% sag: a warn). A near feed enters 4 mm away through 4 mm track
 * (well under 1%: no finding). The two feeds are two footprints whose refs decide
 * what the heuristic guesses; the lead decides what is true.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { runCritic } from '../run'
import type { OpResult } from '../types'

function feed(ref: string, x: number): string {
  return `(footprint "Connector_PinHeader_2.54mm:PinHeader_1x01" (layer "F.Cu") (at ${x} 10)
      (fp_text reference "${ref}" (at 0 -2) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
    )`
}

/** farRef feeds U1 over 100 mm of thin track; nearRef over 4 mm of wide track. */
function makeBoard(farRef: string, nearRef: string) {
  return parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6))
    (net 0 "") (net 1 "VCC") (net 2 "GND")
    ${feed(farRef, 10)}
    ${feed(nearRef, 114)}
    (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 110 10)
      (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
      (pad "4" smd rect (at 0 3) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )
    (segment (start 10 10) (end 110 10) (width 0.25) (layer "F.Cu") (net 1))
    (segment (start 114 10) (end 110 10) (width 4) (layer "F.Cu") (net 1))
  )`)
}

function run(farRef: string, nearRef: string, supplyEntries?: OpResult['supplyEntries']) {
  const board = makeBoard(farRef, nearRef)
  const circuit = extract(board)
  const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
  const op: OpResult = {
    nodeVoltages: { [vcc.spiceNode]: 5 },
    partCurrents: { U1: 1 },
    ...(supplyEntries ? { supplyEntries } : {}),
  }
  const report = runCritic(board, circuit, op)
  return {
    findings: report.findings.filter((f) => f.check === 'ir-drop'),
    skipped: report.skipped.filter((s) => s.check === 'ir-drop'),
  }
}

const VCC = 1

describe('IR-drop supply entry from the bench lead (issue #47)', () => {
  it('baseline: with no lead position the heuristic picks the far connector J1 and says it guessed', () => {
    const { findings } = run('J1', 'J2')
    expect(findings).toHaveLength(1)
    expect(findings[0].metrics!.sagPct).toBeCloseTo(3.86, 1)
    expect(findings[0].assumption).toMatch(/no bench supply lead/i)
    expect(findings[0].assumption).toMatch(/guess/i)
    expect(findings[0].assumption).toContain('J1')
  })

  it('Case A: the lead clipped at the near connector J2 wins over the J1 guess, so no warning for an unused path', () => {
    const { findings } = run('J1', 'J2', [{ netId: VCC, pos: { x: 114, y: 10 } }])
    expect(findings).toHaveLength(0)
  })

  it('Case B: a battery BT1 clipped as the supply is assessed (the guess picked J1 and reported nothing)', () => {
    // Guess alone: J1 is the near connector, the true feed BT1 is not a connector ref.
    expect(run('BT1', 'J1').findings).toHaveLength(0)
    const { findings } = run('BT1', 'J1', [{ netId: VCC, pos: { x: 10, y: 10 } }])
    expect(findings).toHaveLength(1)
    expect(findings[0].metrics!.sagPct).toBeCloseTo(3.86, 1)
    expect(findings[0].detail).toContain('BT1 pad 1')
    expect(findings[0].assumption).toContain('bench lead')
    expect(findings[0].assumption).toContain('BT1')
    expect(findings[0].assumption).not.toMatch(/guess/i)
  })

  it('Case C: a barrel jack DC1 clipped as the supply is assessed', () => {
    expect(run('DC1', 'J1').findings).toHaveLength(0)
    const { findings } = run('DC1', 'J1', [{ netId: VCC, pos: { x: 10, y: 10 } }])
    expect(findings).toHaveLength(1)
    expect(findings[0].detail).toContain('DC1 pad 1')
  })

  it('snaps an off-pad lead to the nearest pad on the net and reports the snap distance', () => {
    const { findings } = run('BT1', 'J1', [{ netId: VCC, pos: { x: 12, y: 10 } }])
    expect(findings).toHaveLength(1)
    expect(findings[0].detail).toContain('BT1 pad 1')
    expect(findings[0].assumption).toMatch(/2(\.0)? mm/)
  })

  it('a supply attached with no recorded position says so, and still falls back to the guess', () => {
    const { findings } = run('J1', 'J2', [{ netId: VCC }])
    expect(findings).toHaveLength(1)
    expect(findings[0].assumption).toMatch(/no recorded (lead )?position/i)
    expect(findings[0].assumption).toMatch(/guess/i)
  })

  it('an entry for a different net does not steer this rail', () => {
    const { findings } = run('J1', 'J2', [{ netId: 99, pos: { x: 114, y: 10 } }])
    expect(findings).toHaveLength(1)
    expect(findings[0].assumption).toMatch(/guess/i)
  })
})
