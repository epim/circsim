/**
 * Generated large-board fixture for the parser allocation tests (issue #60).
 *
 * Built in memory from scripts/gen-synthetic-board.mjs, never committed. The
 * shape mirrors a pour-heavy routed board: footprints, many track segments, and
 * a few copper zones whose filled_polygon point lists dominate the file size.
 */

import { generateBoard, type SyntheticBoardSpec } from '../../../../scripts/gen-synthetic-board.mjs'

export interface LargeBoardOptions {
  segments: number
  zonePoints: number
  zones?: number
  footprints?: number
}

export function largeBoardText(opts: LargeBoardOptions): string {
  const nets = Array.from({ length: 40 }, (_, i) => `NET_${i}`)
  const footprints: SyntheticBoardSpec['footprints'] = []
  for (let i = 0; i < (opts.footprints ?? 1000); i++) {
    footprints.push({
      ref: `R${i}`,
      value: '10k',
      lib: 'Resistor_SMD:R_0805_2012Metric',
      at: { x: (i % 50) * 3, y: Math.floor(i / 50) * 3, rot: (i % 4) * 90 },
      side: i % 2 === 0 ? 'F' : 'B',
      pads: [
        { num: '1', x: -0.9, y: 0, w: 1, h: 1.3, net: nets[i % 40] },
        { num: '2', x: 0.9, y: 0, w: 1, h: 1.3, net: nets[(i + 1) % 40] }
      ]
    })
  }
  const tracks: NonNullable<SyntheticBoardSpec['tracks']> = []
  for (let i = 0; i < opts.segments; i++) {
    const x = (i % 400) * 0.5
    const y = Math.floor(i / 400) * 0.5
    tracks.push({
      net: nets[i % 40],
      layer: i % 2 === 0 ? 'F.Cu' : 'B.Cu',
      width: 0.25,
      pts: [
        [x, y],
        [x + 0.5, y]
      ]
    })
  }
  const zones: NonNullable<SyntheticBoardSpec['zones']> = []
  for (let z = 0; z < (opts.zones ?? 4); z++) {
    const outline: [number, number][] = []
    for (let k = 0; k < opts.zonePoints; k++) {
      const a = (k / opts.zonePoints) * Math.PI * 2
      outline.push([100 + (50 + z) * Math.cos(a), 100 + (50 + z) * Math.sin(a)])
    }
    zones.push({ net: nets[z], layer: z % 2 === 0 ? 'F.Cu' : 'B.Cu', outline })
  }
  return generateBoard({
    kicad: 10,
    nets,
    outline: { x0: 0, y0: 0, x1: 200, y1: 200 },
    footprints,
    tracks,
    zones
  })
}
