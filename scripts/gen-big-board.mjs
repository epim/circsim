/**
 * gen-big-board.mjs - deterministic large synthetic boards (issue #55).
 *
 * Used to measure the board-open path at the sizes the council review flagged:
 * a 1500-part, 20k-track board of about 4 MB. Built with
 * scripts/gen-synthetic-board.mjs, so the text is a real .kicad_pcb that
 * parseBoard accepts; no third-party board content, nothing committed.
 */

import { generateBoard } from './gen-synthetic-board.mjs'

/** The 1500-part, 20k-track board the issue measured (about 4 MB). */
export const ISSUE_BIG = { parts: 1500, tracks: 20000, nets: 300 }

/** Small enough to keep a unit test fast, big enough that the audit dominates. */
export const TEST_MID = { parts: 400, tracks: 6000, nets: 120 }

/**
 * @param {{ parts: number, tracks: number, nets: number }} size two-pad
 *   footprints on a grid, copper segments spread over F.Cu and B.Cu, distinct nets
 * @returns {string} .kicad_pcb text
 */
export function bigBoardText(size) {
  const netNames = ['GND', 'VCC']
  for (let i = 0; i < size.nets - 2; i++) netNames.push(`N${i}`)

  // xorshift so the board is identical on every run and every machine.
  let s = 0x2545f491
  const rnd = () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }

  const cols = Math.ceil(Math.sqrt(size.parts * 1.2))
  const pitch = 4
  const signalNets = netNames.length - 2
  const footprints = []
  for (let i = 0; i < size.parts; i++) {
    const x = 5 + (i % cols) * pitch
    const y = 5 + Math.floor(i / cols) * pitch
    const a = netNames[2 + (i % signalNets)]
    const b = i % 3 === 0 ? 'GND' : i % 3 === 1 ? 'VCC' : netNames[2 + ((i + 7) % signalNets)]
    footprints.push({
      ref: i % 2 === 0 ? `R${i + 1}` : `C${i + 1}`,
      value: i % 2 === 0 ? '10k' : '100n',
      lib: i % 2 === 0 ? 'Resistor_SMD:R_0805_2012Metric' : 'Capacitor_SMD:C_0805_2012Metric',
      at: { x, y, rot: 0 },
      side: 'F',
      pads: [
        { num: '1', x: -1, y: 0, w: 1.0, h: 1.3, net: a },
        { num: '2', x: 1, y: 0, w: 1.0, h: 1.3, net: b }
      ]
    })
  }

  const extent = cols * pitch + 10
  const tracks = []
  for (let i = 0; i < size.tracks; i++) {
    const x = 3 + rnd() * extent
    const y = 3 + rnd() * extent
    const len = 0.5 + rnd() * 3
    const horizontal = rnd() < 0.5
    tracks.push({
      net: netNames[Math.floor(rnd() * netNames.length)],
      layer: i % 2 === 0 ? 'F.Cu' : 'B.Cu',
      width: 0.2,
      pts: [
        [x, y],
        horizontal ? [x + len, y] : [x, y + len]
      ]
    })
  }

  return generateBoard({
    kicad: 8,
    nets: netNames,
    outline: { x0: 0, y0: 0, x1: extent, y1: extent },
    footprints,
    tracks
  })
}
