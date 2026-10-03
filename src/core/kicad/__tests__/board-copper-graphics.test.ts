import { describe, expect, it } from 'vitest'
import { buildCopperNetwork } from '../../copper'
import { extract } from '../../netlist/extract'
import { parseBoard } from '../board'

const board = (graphics: string) => `(kicad_pcb (version 20240108) (generator pcbnew)
  (net 0 "") (net 1 "VCC") ${graphics})`

describe('netted copper graphics', () => {
  it.each([
    ['gr_rect', '(start 0 0) (end 10 2)', 4],
    ['gr_poly', '(pts (xy 0 0) (xy 10 0) (xy 10 2) (xy 0 2))', 4],
    ['gr_circle', '(center 5 1) (end 7 1)', 64],
  ])('retains a filled %s as a copper sheet without changing routed item counts', (kind, geometry, points) => {
    const model = parseBoard(board(`(${kind} ${geometry} (stroke (width 0.2) (type solid)) (fill yes) (layer "F.Cu") (net 1))`))
    expect(model.copperGraphics?.zones).toHaveLength(1)
    expect(model.copperGraphics?.zones[0]).toMatchObject({ netId: 1, layer: 'F.Cu' })
    expect(model.copperGraphics?.zones[0].polygon[0]).toHaveLength(points as number)
    expect(model.tracks).toEqual([])
    expect(model.zones).toEqual([])
  })

  it('keeps line and unfilled rectangle stroke resistance rather than filling their interiors', () => {
    const model = parseBoard(board(`
      (gr_line (start 0 0) (end 10 0) (stroke (width 0.3) (type solid)) (layer "B.Cu") (net 1))
      (gr_rect (start 0 0) (end 10 2) (width 0.2) (fill none) (layer "F.Cu") (net 1))`))
    expect(model.copperGraphics?.tracks).toHaveLength(5)
    expect(model.copperGraphics?.tracks[0]).toEqual({ kind: 'segment', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, widthMm: 0.3, layer: 'B.Cu', netId: 1 })
    expect(model.copperGraphics?.zones).toEqual([])
  })

  it('bonds pad terminals through a filled copper graphic', () => {
    const model = parseBoard(board(`
      (footprint "Connector" (layer "F.Cu") (at 0.5 1)
        (fp_text reference "J1" (at 0 0) (layer "F.SilkS"))
        (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC")))
      (footprint "Connector" (layer "F.Cu") (at 9.5 1)
        (fp_text reference "J2" (at 0 0) (layer "F.SilkS"))
        (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC")))
      (gr_rect (start 0 0) (end 10 2) (stroke (width 0.2) (type solid)) (fill yes) (layer "F.Cu") (net 1))`))
    const network = buildCopperNetwork(model, extract(model))
    expect(network.unreachedPads).toEqual([])
    expect(network.edges.some(edge => edge.kind === 'pour')).toBe(true)
    expect(network.padNode('J1', '1')).not.toBe(network.padNode('J2', '1'))
  })

  it('leaves parse output byte-identical without netted copper graphics', () => {
    const original = JSON.stringify(parseBoard(board('')))
    const model = parseBoard(board(`
      (gr_rect (start 0 0) (end 10 2) (fill yes) (layer "F.Cu"))
      (gr_rect (start 0 0) (end 10 2) (fill yes) (layer "F.Fab") (net 1))`))
    expect(JSON.stringify(model)).toBe(original)
    expect(model).not.toHaveProperty('copperGraphics')
  })
})
