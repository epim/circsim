/**
 * core/critic/__tests__/classify.test.ts
 *
 * TDD for the shared rail classifier (classifyRails). Boards are built from
 * inline kicad_pcb strings (style mirrors decoupling.test.ts). Covers:
 *   (a) name-based: VCC → power, GND → ground;
 *   (b) inference: a non-standard rail "/VGATED" (a gated rail — its name is
 *       NOT matched by the supply heuristics, unlike "/VBUS_C" which is
 *       name-based since Milestone 2) with TWO 100nF caps each wired
 *       /VGATED↔GND is classified power via its decoupling caps;
 *   (c) a rail with only ONE such cap is NOT inferred power.
 */

import { describe, it, expect } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { buildContext } from '../context'
import { DEFAULT_CRITIC_OPTIONS } from '../types'
import { classifyRails } from '../classify'

function classify(text: string) {
  const board = parseBoard(text)
  const circuit = extract(board)
  const ctx = buildContext(board, circuit, undefined, DEFAULT_CRITIC_OPTIONS)
  return { ...classifyRails(circuit, ctx), board }
}

describe('classifyRails', () => {
  it('classifies name-based VCC as power and GND as ground', () => {
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "VCC") (net 2 "GND") (net 3 "SIG")
      (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 10 10)
        (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "VCC"))
        (pad "4" smd rect (at -2 -2) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
        (pad "1" smd rect (at -2 1) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      )
    )`
    const { powerNetIds, groundNetIds } = classify(text)
    expect(groundNetIds.has(2)).toBe(true)
    expect(powerNetIds.has(1)).toBe(true)
    // ground is never reported as power
    expect(powerNetIds.has(2)).toBe(false)
    expect(powerNetIds.has(3)).toBe(false)
  })

  it('infers a non-standard rail "/VGATED" as power from TWO bypass caps to GND', () => {
    // U1 powered from net 1 "/VGATED" (NOT a name-based rail). Two 100nF caps
    // (C1, C2) each bridge /VGATED(net1)↔GND(net2) → inferred power.
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "/VGATED") (net 2 "GND") (net 3 "SIG")
      (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 10 10)
        (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "/VGATED"))
        (pad "4" smd rect (at -2 -2) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
        (pad "1" smd rect (at -2 1) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      )
      (footprint "Capacitor_SMD:C_0402" (layer "F.Cu") (at 12 10)
        (fp_text reference "C1" (at 0 -1) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (fp_text value "100nF" (at 0 1) (layer "F.Fab")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "/VGATED"))
        (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
      )
      (footprint "Capacitor_SMD:C_0402" (layer "F.Cu") (at 14 10)
        (fp_text reference "C2" (at 0 -1) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (fp_text value "100nF" (at 0 1) (layer "F.Fab")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "/VGATED"))
        (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
      )
    )`
    const { powerNetIds, groundNetIds } = classify(text)
    expect(groundNetIds.has(2)).toBe(true)
    expect(powerNetIds.has(1)).toBe(true)
  })

  it('does NOT infer power from only ONE bypass cap', () => {
    // Same as above but only C1 → fewer than 2 bypass caps → not inferred.
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (general (thickness 1.6))
      (net 0 "") (net 1 "/VGATED") (net 2 "GND") (net 3 "SIG")
      (footprint "Package_SO:SOIC-8" (layer "F.Cu") (at 10 10)
        (fp_text reference "U1" (at 0 -3) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "8" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "/VGATED"))
        (pad "4" smd rect (at -2 -2) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
        (pad "1" smd rect (at -2 1) (size 0.5 0.6) (layers "F.Cu") (net 3 "SIG"))
      )
      (footprint "Capacitor_SMD:C_0402" (layer "F.Cu") (at 12 10)
        (fp_text reference "C1" (at 0 -1) (layer "F.SilkS")
          (effects (font (size 1 1) (thickness 0.15))))
        (fp_text value "100nF" (at 0 1) (layer "F.Fab")
          (effects (font (size 1 1) (thickness 0.15))))
        (pad "1" smd rect (at 0 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "/VGATED"))
        (pad "2" smd rect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "GND"))
      )
    )`
    const { powerNetIds, groundNetIds } = classify(text)
    expect(groundNetIds.has(2)).toBe(true)
    expect(powerNetIds.has(1)).toBe(false)
  })
})
