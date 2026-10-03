import { describe, expect, it } from 'vitest'
import { parseBoard } from '../board'

const board = (points: string) => `(kicad_pcb (version 20240108) (generator pcbnew)
  (net 0 "") (net 1 "VCC")
  (zone (net 1) (layer "In2.Cu") (polygon (pts ${points}))))`

describe('zone polygon arcs', () => {
  it('preserves a curved boundary in a mixed xy/arc point list', () => {
    const points = parseBoard(board('(xy 0 0) (xy 2 0) (arc (start 2 0) (mid 3 1) (end 2 2)) (xy 0 2)')).zones[0].polygon[0]
    expect(points.length).toBeGreaterThan(16)
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points.at(-1)).toEqual({ x: 0, y: 2 })
    expect(points.some(point => Math.abs(point.x - 3) < 1e-9 && Math.abs(point.y - 1) < 1e-9)).toBe(true)
  })

  it('keeps an all-arc polygon instead of dropping the entire pour', () => {
    const points = parseBoard(board(`
      (arc (start 1 0) (mid 0.7071067811865476 0.7071067811865476) (end 0 1))
      (arc (start 0 1) (mid -0.7071067811865476 0.7071067811865476) (end -1 0))
      (arc (start -1 0) (mid -0.7071067811865476 -0.7071067811865476) (end 0 -1))
      (arc (start 0 -1) (mid 0.7071067811865476 -0.7071067811865476) (end 1 0))
    `)).zones[0].polygon[0]
    expect(points.length).toBeGreaterThanOrEqual(32)
    expect(points.every(point => Math.abs(Math.hypot(point.x, point.y) - 1) < 1e-9)).toBe(true)
  })

  it('leaves xy-only zone output byte-identical', () => {
    const zone = parseBoard(board('(xy 0 0) (xy 2 0) (xy 2 2) (xy 0 2)')).zones[0]
    expect(JSON.stringify(zone)).toBe('{"netId":1,"layer":"In2.Cu","polygon":[[{"x":0,"y":0},{"x":2,"y":0},{"x":2,"y":2},{"x":0,"y":2}]]}')
  })
})
