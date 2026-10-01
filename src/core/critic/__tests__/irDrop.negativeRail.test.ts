/**
 * core/critic/__tests__/irDrop.negativeRail.test.ts
 *
 * A negative rail is a rail. VEE sits at -5 V, inferred as a power rail by two
 * bypass caps to GND (C1, C2). J1 (connector, the supply entry) feeds U1 over
 * 100 mm of 0.25 mm track: at 1 A that is 0.193 V, a 3.9% warning, the same as
 * the positive-rail case A in irDrop.zones.test.ts.
 *
 * The current of a load on a negative rail flows from ground through the part
 * and back out into the rail, so the solve gives U1's VEE pad a negative draw
 * and its GND pad a positive one (deriveSolvedCurrents: a resistor from GND to
 * VEE draws (0 - -5) / R from GND and -(0 - -5) / R from VEE). The sag is
 * toward 0 V: the rail at U1 rises to -4.81 V, and the ground at U1 falls.
 *
 * Sheet resistance of 1 oz copper: 1.68e-8 / 34.8e-6 = 0.4828 mOhm per square;
 * 100 mm of 0.25 mm track is 400 squares, 0.1931 Ohm.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract, type Circuit } from '../../netlist/extract'
import { runCritic } from '../run'
import type { OpResult } from '../types'

const TRACK_OHMS = (1.68e-8 / 34.8e-6) * (100 / 0.25)

function cap(ref: string, x: number) {
  return `(footprint "Capacitor_SMD:C_0402" (layer "F.Cu") (at ${x} 30)
    (fp_text reference "${ref}" (at 0 -1) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "100nF" (at 0 1) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VEE"))
    (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
  )`
}

/** VEE = net 1 (track at y=10), GND = net 2 (track at y=13). */
function makeBoard(gndWidthMm = 3) {
  return parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6))
    (net 0 "") (net 1 "VEE") (net 2 "GND")
    (footprint "Connector_PinHeader_2.54mm:PinHeader_1x02" (layer "F.Cu") (at 10 10)
      (fp_text reference "J1" (at 0 -2) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VEE"))
      (pad "2" smd rect (at 0 3) (size 1 1) (layers "F.Cu") (net 2 "GND"))
    )
    (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 110 10)
      (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
        (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VEE"))
      (pad "2" smd rect (at 0 3) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )
    ${cap('C1', 40)}
    ${cap('C2', 60)}
    (segment (start 10 10) (end 110 10) (width 0.25) (layer "F.Cu") (net 1))
    (segment (start 10 13) (end 110 13) (width ${gndWidthMm}) (layer "F.Cu") (net 2))
  )`)
}

function vee(circuit: Circuit) {
  return circuit.nets.find((n) => n.kicadName === 'VEE')!
}

/** The op at VEE = -5 V with U1's pad currents as given (VEE pad, GND pad). */
function opWith(circuit: Circuit, veeA: number, gndA: number): OpResult {
  return {
    nodeVoltages: { [vee(circuit).spiceNode]: -5 },
    padCurrents: { U1: { '1': veeA, '2': gndA } },
    partCurrents: { U1: Math.max(Math.abs(veeA), Math.abs(gndA)) },
  }
}

function irOf(board: ReturnType<typeof makeBoard>, op: (c: Circuit) => OpResult) {
  const circuit = extract(board)
  const report = runCritic(board, circuit, op(circuit))
  return { report, ir: report.findings.filter((f) => f.check === 'ir-drop') }
}

describe('IR drop on a negative rail', () => {
  it('reports the sag toward 0 V with the solve-signed currents (VEE pad -1 A, GND pad +1 A)', () => {
    const { ir, report } = irOf(makeBoard(), (c) => opWith(c, -1, 1))
    const f = ir.find((x) => x.netId === 1)
    expect(f, JSON.stringify(report.skipped)).toBeDefined()
    expect(f!.severity).toBe('warn')
    expect(f!.refs).toEqual(['U1'])
    expect(f!.metrics!.dropV).toBeCloseTo(TRACK_OHMS, 3)
    expect(f!.metrics!.nominalV).toBe(-5)
    // -5 V rises toward 0 V at the load, and the 3 mm GND return (33 squares,
    // 16 mV at 1 A) falls under it: 0.209 V round trip.
    const gndOhms = (1.68e-8 / 34.8e-6) * (100 / 3)
    expect(f!.metrics!.groundShiftV).toBeCloseTo(gndOhms, 3)
    expect(f!.metrics!.sinkV).toBeCloseTo(-5 + TRACK_OHMS + gndOhms, 3)
    expect(f!.title).toMatch(/"VEE" rail sags to -4\.79V at U1 \(0\.21 V drop/)
    expect(f!.metrics!.totalSinkA).toBeCloseTo(1, 6)
    expect(report.ranBy).toContain('ir-drop')
  })

  it('reports it from a bare partCurrents map too (no pad signs to go on)', () => {
    const { ir } = irOf(makeBoard(), (c) => ({
      nodeVoltages: { [vee(c).spiceNode]: -5 },
      partCurrents: { U1: 1 },
    }))
    const f = ir.find((x) => x.netId === 1)
    expect(f).toBeDefined()
    expect(f!.metrics!.dropV).toBeCloseTo(TRACK_OHMS, 3)
    expect(f!.metrics!.sinkV).toBeGreaterThan(-5)
  })

  it('adds the ground fall at the load to the round trip', () => {
    // A 0.25 mm GND return as well: 0.5 A drops 0.0966 V on each leg (1.9%,
    // under the 2% warn line alone) and 0.193 V round trip (3.9%).
    const { ir } = irOf(makeBoard(0.25), (c) => opWith(c, -0.5, 0.5))
    const f = ir.find((x) => x.netId === 1)
    expect(f).toBeDefined()
    expect(f!.metrics!.dropV).toBeCloseTo(0.5 * TRACK_OHMS, 3)
    expect(f!.metrics!.groundShiftV).toBeCloseTo(0.5 * TRACK_OHMS, 3)
    expect(f!.metrics!.roundTripV).toBeCloseTo(TRACK_OHMS, 3)
  })

  it('reports a ground that falls under a negative-rail load as a ground shift', () => {
    // 1 A drawn out of a 0.25 mm GND return: the ground at U1 sits 0.193 V
    // below the return entry, 3.9% of the 5 V rail.
    const { ir } = irOf(makeBoard(0.25), (c) => opWith(c, -1, 1))
    const g = ir.find((x) => x.netId === 2)
    expect(g).toBeDefined()
    expect(g!.severity).toBe('warn')
    expect(g!.title).toMatch(/"GND" return falls to -0\.19 V at U1/)
    expect(g!.metrics!.dropV).toBeCloseTo(TRACK_OHMS, 3)
  })

  it('names a rail whose only current flows into it instead of staying silent', () => {
    // U1 pulls current out of the -5 V rail, as a supply would: no pad draws a
    // load from the inferred entry J1, so there is no sag to measure from it.
    const { ir, report } = irOf(makeBoard(), (c) => opWith(c, 1, -1))
    expect(ir.find((x) => x.netId === 1)).toBeUndefined()
    expect(report.ranBy).not.toContain('ir-drop')
    expect(report.skipped.find((s) => s.check === 'ir-drop')?.reason).toMatch(/VEE: U1\.1 /)
  })
})
