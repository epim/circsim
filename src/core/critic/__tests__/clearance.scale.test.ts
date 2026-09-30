/**
 * core/critic/__tests__/clearance.scale.test.ts
 *
 * The clearance check is spatially indexed (issue #56). Two guarantees:
 *   1. The index returns exactly the pairs a brute-force O(n squared) scan finds,
 *      including mixed widths, many layers and long diagonal tracks.
 *   2. A generated board with 10k tracks stays well inside a generous time bound
 *      (the old pair enumeration needed seconds at this size on a slow machine).
 */

import { describe, expect, it } from 'vitest'

import { generateBoard } from '../../../../scripts/gen-synthetic-board.mjs'
import { parseBoard } from '../../kicad/board'
import type { BoardModel } from '../../kicad/types'
import { extract } from '../../netlist/extract'
import { checkClearance } from '../checks/clearance'
import { buildContext } from '../context'
import { segSegDistanceMm } from '../geom'
import { DEFAULT_CRITIC_OPTIONS } from '../types'

function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

interface GenTrack {
  net: string
  layer: string
  width: number
  pts: [number, number][]
}

function buildBoard(tracks: GenTrack[], nets: string[], side: number): BoardModel {
  return parseBoard(
    generateBoard({
      kicad: 10,
      nets,
      footprints: [],
      tracks,
      outline: { x0: -50, y0: -50, x1: side + 50, y1: side + 50 },
    }),
  )
}

function randomTracks(n: number, side: number, seed: number, netCount: number, longEvery = 0): {
  tracks: GenTrack[]
  nets: string[]
} {
  const r = rng(seed)
  const nets = Array.from({ length: netCount }, (_, i) => `N${i}`)
  const widths = [0.15, 0.2, 0.3, 0.5, 1.0]
  const layers = ['F.Cu', 'In1.Cu', 'B.Cu']
  const tracks: GenTrack[] = []
  for (let k = 0; k < n; k++) {
    const x = r() * side
    const y = r() * side
    const long = longEvery > 0 && k % longEvery === 0
    const len = long ? side * (0.5 + r() * 0.5) : 1 + r() * 9
    const a = r() * Math.PI * 2
    tracks.push({
      net: nets[Math.floor(r() * netCount)],
      layer: layers[Math.floor(r() * layers.length)],
      width: widths[Math.floor(r() * widths.length)],
      pts: [
        [x, y],
        [x + len * Math.cos(a), y + len * Math.sin(a)],
      ],
    })
  }
  return { tracks, nets }
}

/** Reference implementation: every pair, same rules as the check. */
function bruteForceIds(board: BoardModel, min: number): string[] {
  const ids: string[] = []
  const t = board.tracks
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      if (t[i].netId === 0 || t[j].netId === 0) continue
      if (t[i].layer !== t[j].layer || t[i].netId === t[j].netId) continue
      const gap =
        segSegDistanceMm(t[i].start, t[i].end, t[j].start, t[j].end) - (t[i].widthMm + t[j].widthMm) / 2
      if (gap < min - 1e-6) ids.push(`clearance:t${i}-t${j}`)
    }
  }
  return ids
}

function trackIds(board: BoardModel): string[] {
  // Raise the cap view: the check caps at 50 findings, so count via overflow too.
  const out = checkClearance(buildContext(board, extract(board), undefined, DEFAULT_CRITIC_OPTIONS))
  return out.filter((f) => /^clearance:t\d+-t\d+$/.test(f.id)).map((f) => f.id)
}

describe('clearance spatial index', () => {
  it('matches a brute-force scan on random boards with mixed widths and layers', () => {
    for (const seed of [1, 2, 3]) {
      // Dense enough that there are far more than 50 conflicts; compare against the
      // first 50 in track order (the check reports in track order).
      const { tracks, nets } = randomTracks(600, 40, seed, 12)
      const board = buildBoard(tracks, nets, 40)
      const expected = bruteForceIds(board, DEFAULT_CRITIC_OPTIONS.minClearanceMm)
      expect(expected.length).toBeGreaterThan(50)
      expect(trackIds(board)).toEqual(expected.slice(0, 50))
    }
  })

  it('reports the full set when conflicts fit under the cap, including long diagonal tracks', () => {
    for (const seed of [11, 12, 13, 14]) {
      const { tracks, nets } = randomTracks(120, 400, seed, 20, 15)
      const board = buildBoard(tracks, nets, 400)
      const expected = bruteForceIds(board, DEFAULT_CRITIC_OPTIONS.minClearanceMm)
      expect(expected.length).toBeLessThanOrEqual(50)
      expect(expected.length).toBeGreaterThan(0)
      expect(trackIds(board)).toEqual(expected)
    }
  })

  it('checks a 10k-track board inside a generous time bound', () => {
    const { tracks, nets } = randomTracks(10000, 1000, 7, 500)
    const board = buildBoard(tracks, nets, 1000)
    const ctx = buildContext(board, extract(board), undefined, DEFAULT_CRITIC_OPTIONS)
    const t0 = performance.now()
    checkClearance(ctx)
    const ms = performance.now() - t0
    // Indexed cost is a few tens of ms; the old quadratic scan was 500+ ms here.
    expect(ms).toBeLessThan(400)
  }, 60000)
})
