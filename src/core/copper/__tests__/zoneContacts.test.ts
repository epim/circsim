import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { buildCopperNetwork } from '../index'

const zone = (points: number[][]) => `(zone (net 1) (layer "F.Cu") (polygon (pts ${points.map(([x, y]) => `(xy ${x} ${y})`).join(' ')})))`
const rect = (left: number, right: number) => zone([[left, 0], [right, 0], [right, 4], [left, 4]])
function network(zones: string, pads: number[][]) {
  const board = parseBoard(`(kicad_pcb (version 20240108) (net 0 "") (net 1 "VCC")
    ${pads.map(([x, y, w = 0.5, h = 0.5], i) => `(footprint "Connector" (layer "F.Cu") (at ${x} ${y})
      (fp_text reference "J${i + 1}" (at 0 0) (layer "F.SilkS"))
      (pad "1" smd rect (at 0 0) (size ${w} ${h}) (layers "F.Cu") (net 1 "VCC")))`).join(' ')}
    ${zones})`)
  return buildCopperNetwork(board, extract(board))
}

describe('pour contacts', () => {
  it.each([8, 9])('joins touching or overlapping pours ending at x=%s without shorting the entire mesh', right => {
    const copper = network(rect(0, right) + rect(8, 14), [[1, 2], [13, 2]])
    expect(copper.unreachedPads).toEqual([])
    expect(copper.padNode('J1', '1')).not.toBe(copper.padNode('J2', '1'))
    expect(copper.edges.filter(edge => edge.kind === 'pour').length).toBeGreaterThan(10)
  })

  it('preserves a clearance between separate pours even when it is smaller than a mesh cell', () => {
    const copper = network(rect(0, 7.9) + rect(8, 14), [[1, 2], [13, 2]])
    expect(copper.unreachedPads.map(pad => pad.ref)).toEqual(['J2'])
  })

  it('refines a thin pour neck that otherwise has no cells at a pad terminal', () => {
    const copper = network(zone([[6.15, 0], [2.25, 0], [1.1, 1.55], [0, 1.55], [0, 1.85], [6.15, 1.85]]), [
      [0.45, 1.7, 0.88, 0.25], [4.4, 1.29, 3.5, 1],
    ])
    expect(copper.unreachedPads).toEqual([])
    expect(copper.padNode('J1', '1')).not.toBe(copper.padNode('J2', '1'))
  })
})
