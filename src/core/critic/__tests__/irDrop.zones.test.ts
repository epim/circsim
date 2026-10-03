import { haveNativeCopper } from './nativeCopper'
/**
 * core/critic/__tests__/irDrop.zones.test.ts
 *
 * Issue #10: the IR-drop check must see copper pours and the ground return.
 * The council's reproduction cases, run through parseBoard + extract + runCritic:
 *
 *   A  100 mm x 0.25 mm VCC track only                      (warn, as before)
 *   B  the same track PLUS a pour covering every pad        (the pour carries it: quiet)
 *   C  pour only, no track, a 4 mm neck in the pour         (finding from the pour's own resistance)
 *   D  pour plus a stub to U1; U2 sits on the pour only     (U2 is a sink, not silently dropped)
 *
 * plus the ground return, the pour-only rail fixture (review focus 2 of the
 * remediation plan), and the not-assessed honesty lines of issue #9.
 *
 * Sheet resistance of 1 oz copper: 1.68e-8 / 34.8e-6 = 0.4828 mOhm per square.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract, type Circuit } from '../../netlist/extract'
import { nativeRunCritic as runCritic } from './nativeCopper'
import type { OpResult } from '../types'

const SHEET_OHMS = 1.68e-8 / 34.8e-6

interface BoardOpts {
  /** Extra s-expression copper (segments, vias, zones). */
  copper: string
  /** Extra footprints (U2 etc.). */
  extraFootprints?: string
}

// VCC = net 1, GND = net 2. J1 (connector, the supply entry) at (10,10), U1 at
// (110,10). GND pads sit 3 mm below the VCC pads on both parts.
function makeBoard({ copper, extraFootprints = '' }: BoardOpts) {
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
      (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
      (pad "4" smd rect (at 0 3) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
    )
    ${extraFootprints}
    ${copper}
  )`)
}

const U2 = `(footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 60 10)
  (fp_text reference "U2" (at 0 -3) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15))))
  (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
  (pad "4" smd rect (at 0 3) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
)`

function zone(net: number, name: string, layer: string, x0: number, y0: number, x1: number, y1: number) {
  return `(zone (net ${net}) (net_name "${name}") (layer "${layer}") (hatch edge 0.5)
    (connect_pads (clearance 0.3)) (min_thickness 0.25)
    (polygon (pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))))`
}

const TRACK = `(segment (start 10 10) (end 110 10) (width 0.25) (layer "F.Cu") (net 1))`
/** A fat GND track J1 to U1: a routed return that stays well under the warn line. */
const GND_TRACK = `(segment (start 10 13) (end 110 13) (width 3) (layer "F.Cu") (net 2))`
/** A pour covering J1, U1 and U2 and everything between: 120 x 40 mm. */
const WIDE_POUR = zone(1, 'VCC', 'F.Cu', 5, -10, 125, 30)
/** A 100 mm long, 4 mm wide strip of pour from J1 to U1: 25 squares. */
const NECK_POUR = zone(1, 'VCC', 'F.Cu', 8, 8, 112, 12)

/**
 * The op a bench solve would give: VCC at 5 V, and signed pad currents for each
 * load (draw on the VCC pad, the same current returned on the GND pad). Carries
 * `partCurrents` too, which is all the pre-fix check read.
 */
function opFor(circuit: Circuit, loads: Record<string, number>, volts = 5): OpResult {
  const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
  const padCurrents: Record<string, Record<string, number>> = {}
  for (const [ref, amps] of Object.entries(loads)) padCurrents[ref] = { '8': amps, '4': -amps }
  return { nodeVoltages: { [vcc.spiceNode]: volts }, partCurrents: { ...loads }, padCurrents }
}

async function run(board: ReturnType<typeof makeBoard>, loads: Record<string, number>) {
  const circuit = extract(board)
  const report = (await runCritic(board, circuit, opFor(circuit, loads)))
  return { report, ir: report.findings.filter((f) => f.check === 'ir-drop') }
}

describe.skipIf(!haveNativeCopper)('IR drop with copper pours (issue #10)', () => {
  it('case A: a lone 100 mm x 0.25 mm track at 1 A is still a 3.9% warning', async () => {
    const { ir } = (await run(makeBoard({ copper: TRACK }), { U1: 1 }))
    expect(ir).toHaveLength(1)
    expect(ir[0].metrics!.dropV).toBeCloseTo(0.1931, 3)
  })

  it('case B: the same track under a pour that covers every pad is no longer an error', async () => {
    // The pour carries the rail; the thin track underneath is bonded to it along
    // its whole length. Pre-fix this produced the identical 0.19 V warning and
    // the suggestion to add the pour that was already there.
    const { ir, report } = (await run(makeBoard({ copper: `${TRACK} ${WIDE_POUR} ${GND_TRACK}` }), { U1: 1 }))
    expect(ir).toHaveLength(0)
    expect(report.ranBy).toContain('ir-drop')
    expect(report.skipped.find((s) => s.check === 'ir-drop')).toBeUndefined()
  })

  it('case C: a rail fed only by a pour is solved, and a 4 mm neck in it shows its resistance', async () => {
    // 100 mm of 4 mm strip = 25 squares = 12.07 mOhm; 10 A drops 0.121 V (2.4%).
    const { ir } = (await run(makeBoard({ copper: NECK_POUR }), { U1: 10 }))
    expect(ir).toHaveLength(1)
    expect(ir[0].refs).toContain('U1')
    const expected = 10 * SHEET_OHMS * 25
    expect(ir[0].metrics!.dropV).toBeGreaterThan(expected * 0.85)
    expect(ir[0].metrics!.dropV).toBeLessThan(expected * 1.15)
    expect(ir[0].severity).toBe('warn')
    // The pour is named as the copper, the fix is not "add a pour".
    expect(ir[0].title).toMatch(/pour/i)
    expect(ir[0].suggestion ?? '').not.toMatch(/add a copper pour/i)
  })

  it('case C: a wide pour with no track at all stays quiet and is reported as assessed', async () => {
    const { ir, report } = (await run(makeBoard({ copper: `${WIDE_POUR} ${GND_TRACK}` }), { U1: 2 }))
    expect(ir).toHaveLength(0)
    expect(report.ranBy).toContain('ir-drop')
    expect(report.skipped.find((s) => s.check === 'ir-drop')).toBeUndefined()
  })

  it('case D: a load that sits on the pour with no track is a sink, not silently dropped', async () => {
    // Thin track J1 to U1 as before (U1 idle); U2 sits 50 mm along a 4 mm strip
    // of pour and has no track. 20 A over 12.5 squares is 0.121 V (2.4%): a
    // warning about U2. Pre-fix U2 had no copper contacts and was dropped.
    const strip = zone(1, 'VCC', 'F.Cu', 8, 8, 62, 12)
    const { ir } = (await run(makeBoard({ copper: `${TRACK} ${strip}`, extraFootprints: U2 }), {
      U2: 20,
    }))
    expect(ir).toHaveLength(1)
    expect(ir[0].refs).toContain('U2')
    expect(ir[0].metrics!.dropV).toBeGreaterThan(0.1)
  })

  it('pins the ground return: a 4 mm pour neck on GND shows up as ground rise', async () => {
    // The return of a 10 A load crosses 100 mm of 4 mm GND pour: 0.121 V of rise.
    const gndNeck = zone(2, 'GND', 'F.Cu', 8, 11, 112, 15)
    const { ir } = (await run(makeBoard({ copper: `${WIDE_POUR} ${gndNeck}` }), { U1: 10 }))
    const gnd = ir.find((f) => f.netId === 2)
    expect(gnd).toBeDefined()
    expect(gnd!.title).toMatch(/GND/)
    expect(gnd!.metrics!.dropV).toBeGreaterThan(0.1)
    expect(gnd!.metrics!.dropV).toBeLessThan(0.14)
  })

  it('reports the round trip: a supply drop and a ground rise each under the warn line add up', async () => {
    // 1.5% on the supply neck + 1.5% on the ground neck at 5 V is 3% round trip.
    // 75 mV on a 4 mm neck = 6.2 A over 25 squares; use 6.2 A.
    const vccNeck = NECK_POUR
    const gndNeck = zone(2, 'GND', 'F.Cu', 8, 11, 112, 15)
    const { ir } = (await run(makeBoard({ copper: `${vccNeck} ${gndNeck}` }), { U1: 6.2 }))
    const vcc = ir.find((f) => f.netId === 1)
    expect(vcc).toBeDefined()
    expect(vcc!.metrics!.roundTripV).toBeGreaterThan(0.14)
    expect(vcc!.metrics!.groundShiftV).toBeGreaterThan(0.06)
    // neither leg alone is over 2% of 5 V (0.1 V), so no ground finding of its own
    expect(ir.find((f) => f.netId === 2)).toBeUndefined()
  })
})

describe.skipIf(!haveNativeCopper)('not assessed instead of silence (issue #9)', () => {
  it('lists ir-drop and ampacity as not assessed when the op carries no branch currents', async () => {
    const board = makeBoard({ copper: TRACK })
    const circuit = extract(board)
    const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
    const report = (await runCritic(board, circuit, { nodeVoltages: { [vcc.spiceNode]: 5 } }))
    expect(report.ranBy).not.toContain('ir-drop')
    expect(report.ranBy).not.toContain('ampacity')
    expect(report.skipped.find((s) => s.check === 'ir-drop')?.reason).toMatch(/current/i)
    expect(report.skipped.find((s) => s.check === 'ampacity')?.reason).toMatch(/current/i)
  })

  it('names a part whose current the solve could not resolve instead of counting it as zero', async () => {
    const board = makeBoard({ copper: `${TRACK} ${GND_TRACK}` })
    const circuit = extract(board)
    const op = { ...opFor(circuit, { U1: 1 }), unresolvedRefs: ['U9'] }
    // U9 is not on the board: nothing to name, stays assessed.
    expect((await runCritic(board, circuit, op)).skipped.find((s) => s.check === 'ir-drop')).toBeUndefined()
    const op2 = { ...opFor(circuit, {}), unresolvedRefs: ['U1'] }
    const report = (await runCritic(board, circuit, op2))
    expect(report.skipped.find((s) => s.check === 'ir-drop')?.reason).toMatch(/U1/)
    expect(report.ranBy).not.toContain('ir-drop')
  })

  it('names a rail with no copper at all that still carries current, in both checks', async () => {
    // J1 and U1 on VCC, U1 drawing 5 A, no VCC copper: nothing was solved.
    const board = makeBoard({ copper: GND_TRACK })
    const circuit = extract(board)
    const report = (await runCritic(board, circuit, opFor(circuit, { U1: 5 })))
    for (const check of ['ir-drop', 'ampacity'] as const) {
      expect(report.ranBy, check).not.toContain(check)
      expect(report.skipped.find((s) => s.check === check)?.reason, check).toMatch(/VCC: U1\.8 carry current but the board has no copper/)
    }
  })

  it('names a rail whose copper touches no pad (every load stranded), in both checks', async () => {
    // A VCC track in the middle of nowhere: copper exists, no pad is on it.
    const board = makeBoard({
      copper: `(segment (start 40 40) (end 60 40) (width 0.25) (layer "F.Cu") (net 1)) ${GND_TRACK}`,
    })
    const circuit = extract(board)
    const report = (await runCritic(board, circuit, opFor(circuit, { U1: 5 })))
    for (const check of ['ir-drop', 'ampacity'] as const) {
      expect(report.ranBy, check).not.toContain(check)
      expect(report.skipped.find((s) => s.check === check)?.reason, check).toMatch(/VCC: U1\.8 carry current but no modelled copper touches any pad/)
    }
  })

  it('says nothing about a rail that carries no current', async () => {
    const board = makeBoard({ copper: `${TRACK} ${GND_TRACK}` })
    const circuit = extract(board)
    const report = (await runCritic(board, circuit, opFor(circuit, { U1: 0 })))
    expect(report.ranBy).toContain('ir-drop')
    expect(report.ranBy).toContain('ampacity')
  })
})
