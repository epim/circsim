import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { buildCopperNetwork } from '../index'

function board(copper: string, destination: { x: number; y: number; layer?: string }): string {
  return `(kicad_pcb (version 20221018) (generator pcbnew)
    (net 0 "") (net 1 "VCC")
    (footprint "Connector" (layer "F.Cu") (at 0 0)
      (fp_text reference "J1" (at 0 0) (layer "F.SilkS"))
      (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC")))
    (footprint "Connector" (layer "${destination.layer ?? 'F.Cu'}") (at ${destination.x} ${destination.y})
      (fp_text reference "J2" (at 0 0) (layer "F.SilkS"))
      (pad "1" smd circle (at 0 0) (size 1 1) (layers "${destination.layer ?? 'F.Cu'}") (net 1 "VCC")))
    (segment (start 0 0) (end 20 0) (width 0.25) (layer "F.Cu") (net 1))
    ${copper})`
}

describe('copper contacts along a track', () => {
  it.each([
    ['pad', '', { x: 10, y: 0 }],
    ['branch endpoint', '(segment (start 10 0) (end 10 5) (width 0.25) (layer "F.Cu") (net 1))', { x: 10, y: 5 }],
    ['via barrel', '(via (at 10 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1)) (segment (start 10 0) (end 10 5) (width 0.25) (layer "B.Cu") (net 1))', { x: 10, y: 5, layer: 'B.Cu' }],
  ] as const)('bonds a %s to the middle without discarding track resistance', (_, copper, destination) => {
    const model = parseBoard(board(copper, destination))
    const network = buildCopperNetwork(model, extract(model))
    expect(network.unreachedPads).toEqual([])
    expect(network.padNode('J1', '1')).not.toBe(network.padNode('J2', '1'))
    const horizontal = network.edges.filter(edge => edge.kind === 'track' && edge.track?.start.x === 0)
    expect(horizontal).toHaveLength(2)
    expect(horizontal.reduce((sum, edge) => sum + edge.lengthMm, 0)).toBeCloseTo(20, 9)
  })

  it('does not bond a nearby pad across clearance or on another copper layer', () => {
    for (const destination of [{ x: 10, y: 2 }, { x: 10, y: 0, layer: 'B.Cu' }]) {
      const model = parseBoard(board('', destination))
      expect(buildCopperNetwork(model, extract(model)).unreachedPads.map(pad => pad.ref)).toEqual(['J2'])
    }
  })

  it('joins overlapping copper pad shapes without bridging a pad clearance', () => {
    const text = board('', { x: 21.3, y: 0 }).replace('    (segment', `
      (footprint "Connector" (layer "F.Cu") (at 20.5 0)
        (fp_text reference "J3" (at 0 0) (layer "F.SilkS"))
        (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC")))
      (segment`)
    const model = parseBoard(text)
    expect(buildCopperNetwork(model, extract(model)).unreachedPads).toEqual([])
    const separate = parseBoard(text.replace('(at 21.3 0)', '(at 21.6 0)'))
    expect(buildCopperNetwork(separate, extract(separate)).unreachedPads.map(pad => pad.ref)).toEqual(['J2'])
  })
})
