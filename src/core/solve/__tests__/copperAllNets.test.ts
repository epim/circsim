import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { resolveAll } from '../../models/resolve'
import { extract } from '../../netlist/extract'
import { buildDeck, buildDeckWithUndriven, buildSolveInputs } from '../inputs'

describe('all-net physical solve inputs', () => {
  it('keeps resistance between signal pads in both full operating-point and reduced transient decks', () => {
    const board = parseBoard(`(kicad_pcb (version 20240108)
      (net 0 "") (net 1 "VCC") (net 2 "MID") (net 3 "GND")
      (footprint "Connector" (layer "F.Cu") (at 0 0)
        (fp_text reference "J1" (at 0 0) (layer "F.SilkS"))
        (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC")))
      (footprint "R" (layer "F.Cu") (at 10 0)
        (fp_text reference "R1" (at 0 0) (layer "F.SilkS")) (fp_text value "50" (at 0 0) (layer "F.Fab"))
        (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
        (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "MID")))
      (footprint "R" (layer "F.Cu") (at 20 0)
        (fp_text reference "R2" (at 0 0) (layer "F.SilkS")) (fp_text value "50" (at 0 0) (layer "F.Fab"))
        (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "MID"))
        (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 3 "GND")))
      (footprint "Connector" (layer "F.Cu") (at 31 0)
        (fp_text reference "J2" (at 0 0) (layer "F.SilkS"))
        (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 3 "GND")))
      (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1))
      (segment (start 11 0) (end 20 0) (width 0.25) (layer "F.Cu") (net 2))
      (segment (start 21 0) (end 31 0) (width 0.25) (layer "F.Cu") (net 3)))`)
    const circuit = extract(board, { groundNetId: 3 })
    const inputs = buildSolveInputs(board, circuit, resolveAll(circuit), [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
    ], 3, { copperAware: true })
    expect([...inputs.copperNetwork!.rails.keys()]).toEqual([1, 2, 3])
    expect([...inputs.copperNetwork!.powerNetIds!]).toEqual([1])
    const first = inputs.copperNetwork!.padNode('R1', '2')!
    const second = inputs.copperNetwork!.padNode('R2', '1')!
    expect(first).not.toBe(second)
    for (const deck of [buildDeckWithUndriven(inputs).deck, buildDeck(inputs)]) {
      expect(deck.some(line => line.startsWith('r_copper_') && line.includes(` ${first} `) && line.includes(` ${second} `))).toBe(true)
    }
  })
})
