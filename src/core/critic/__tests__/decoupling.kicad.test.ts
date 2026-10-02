/**
 * Decoupling distances against KiCad (issue #48).
 *
 * The inline boards in decoupling.test.ts use unrotated F.Cu parts with exact
 * integer coordinates, so they cannot tell a correct pad transform from a wrong
 * one. This suite runs the critic on a routed two-sided board (the bundled
 * sensor-node sample: rotated passives, back-side bypass caps) and checks every
 * (IC, rail) distance it reports against distances measured from the pad centres
 * kicad-cli plotted for that board (test/corpus/oracle/sensor-node.flashes.json,
 * rewritten by test/corpus/sample.corpus.test.ts from live kicad-cli).
 *
 * The expected numbers come from KiCad's coordinates and the board's own pad
 * nets, with the check's definition applied independently here (an IC is a
 * U-reference; a bypass cap is a C part of at most 1 uF on both the rail and
 * ground); none of it goes through padWorldPos. A pad-rotation or back-side
 * mirroring defect moves the nearest cap by millimetres and fails these.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import type { BoardModel } from '../../kicad/types'
import { extract } from '../../netlist/extract'
import { runCritic } from '../run'
import type { PadFlash } from './padOracle'

const ROOT = join(__dirname, '../../../..')
const board: BoardModel = parseBoard(readFileSync(join(ROOT, 'resources/sample/sensor-node.kicad_pcb'), 'utf8'))
const flashes = (JSON.parse(readFileSync(join(ROOT, 'test/corpus/oracle/sensor-node.flashes.json'), 'utf8')) as {
  flashes: PadFlash[]
}).flashes

/** KiCad's centre for a pad (any one flash: a through-hole pad has one per layer, all equal). */
const kicadCentre = new Map<string, { x: number; y: number }>()
for (const f of flashes) kicadCentre.set(`${f.ref}\t${f.pad}`, { x: f.x, y: f.y })

/** Capacitance in farads for the plain "100n", "1u", "10u" values this board uses. */
function farads(value: string): number {
  const m = /^([\d.]+)([pnu])$/.exec(value)
  if (!m) throw new Error(`unexpected capacitor value ${value}`)
  return Number(m[1]) * { p: 1e-12, n: 1e-9, u: 1e-6 }[m[2] as 'p' | 'n' | 'u']
}

const RAILS = ['+5V', '+3V3']
const netName = (id: number | undefined): string | undefined => (id === undefined ? undefined : board.netById.get(id)?.name)

interface Expected {
  ic: string
  rail: string
  cap: string
  distanceMm: number
}

/** For every U part and rail it touches: the nearest qualifying bypass cap and its KiCad-measured distance. */
function expectedFromKicad(): Expected[] {
  const out: Expected[] = []
  const centre = (ref: string, pad: string): { x: number; y: number } => {
    const c = kicadCentre.get(`${ref}\t${pad}`)
    if (!c) throw new Error(`no kicad-cli flash for ${ref}.${pad}`)
    return c
  }
  const caps = board.footprints.filter((f) => /^C\d/.test(f.ref) && farads(f.value) <= 1e-6)
  for (const ic of board.footprints.filter((f) => /^U\d/.test(f.ref))) {
    for (const rail of RAILS) {
      const pins = ic.pads.filter((p) => netName(p.netId) === rail)
      if (pins.length === 0) continue
      let best: Expected | undefined
      for (const cap of caps) {
        const onRail = cap.pads.filter((p) => netName(p.netId) === rail)
        const onGround = cap.pads.some((p) => netName(p.netId) === 'GND')
        if (onRail.length === 0 || !onGround) continue
        for (const a of pins) {
          for (const b of onRail) {
            const ca = centre(ic.ref, a.number)
            const cb = centre(cap.ref, b.number)
            const d = Math.hypot(ca.x - cb.x, ca.y - cb.y)
            if (!best || d < best.distanceMm) best = { ic: ic.ref, rail, cap: cap.ref, distanceMm: d }
          }
        }
      }
      if (best) out.push(best)
    }
  }
  return out
}

const expected = expectedFromKicad()
const circuit = extract(board)
const railOfFinding = (id: string): string => {
  const netId = Number(id.split(':')[2])
  return netName(netId) ?? `net ${netId}`
}

describe('decoupling distances match KiCad on the sensor-node sample', () => {
  it('covers the ICs and both rails, including back-side caps and a rotated stack', () => {
    expect(expected.length).toBeGreaterThanOrEqual(7)
    expect(new Set(expected.map((e) => e.ic))).toEqual(new Set(['U1', 'U2', 'U3', 'U4', 'U5', 'U6']))
    // the nearest cap of the four small ICs is the back-side bypass cap under it
    expect(expected.filter((e) => ['C15', 'C16', 'C17', 'C18'].includes(e.cap)).length).toBeGreaterThanOrEqual(4)
  })

  it('reports, for every (IC, rail), the nearest bypass cap and the distance KiCad measures', () => {
    // decouplingNearMm 0 makes every pair with a cap report its distance.
    const report = runCritic(board, circuit, undefined, { decouplingNearMm: 0, decouplingFarMm: 1000 })
    const dec = report.findings.filter((f) => f.check === 'decoupling' && f.metrics?.distanceMm !== undefined)
    const got = new Map(dec.map((f) => [`${f.id.split(':')[1]}:${railOfFinding(f.id)}`, f]))
    expect([...got.keys()].sort()).toEqual(expected.map((e) => `${e.ic}:${e.rail}`).sort())
    for (const e of expected) {
      const f = got.get(`${e.ic}:${e.rail}`)!
      expect(f.refs, `${e.ic} on ${e.rail}: nearest cap`).toEqual([e.ic, e.cap])
      expect(f.metrics!.distanceMm, `${e.ic} on ${e.rail}: distance to ${e.cap}`).toBeCloseTo(e.distanceMm, 2)
    }
  })

  it('pins distances measured in KiCad (so a shared mistake in both computations still fails)', () => {
    // Hand check, U3 (LM358 at 112,132, no rotation): pad 8 (+3V3) is at (114.475, 130.095).
    // C15 sits under it on B.Cu at (112,134); its +3V3 pad is mirrored to (112.775, 134):
    // hypot(1.7, 3.905) = 4.259. KiCad plots the same two centres.
    const pick = (ic: string, rail: string): Expected => expected.find((e) => e.ic === ic && e.rail === rail)!
    expect(pick('U3', '+3V3').cap).toBe('C15')
    expect(pick('U3', '+3V3').distanceMm).toBeCloseTo(4.259, 3)
  })

  it('with the default thresholds, flags exactly the pairs KiCad measures beyond 5 mm', () => {
    const report = runCritic(board, circuit)
    const flagged = report.findings
      .filter((f) => f.check === 'decoupling')
      .map((f) => `${f.id.split(':')[1]}:${railOfFinding(f.id)}`)
      .sort()
    const far = expected.filter((e) => e.distanceMm > 5).map((e) => `${e.ic}:${e.rail}`).sort()
    expect(flagged).toEqual(far)
  })
})
