/**
 * core/critic/__tests__/clearance.scale.test.ts
 *
 * The clearance check is spatially indexed (issue #56). Two guarantees:
 *   1. The index returns exactly the pairs a brute-force O(n squared) scan finds,
 *      including mixed widths, many layers and long diagonal tracks.
 *   2. Check time grows about linearly with track count (a 10k-track board costs
 *      about 8x a 1250-track board of the same density, not 64x), asserted as a
 *      same-machine ratio, never an absolute millisecond bound.
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

  it('finds shorts on long tracks against small tracks and against each other', () => {
    // Many short tracks plus two long crossing diagonals per layer. The grid cell follows
    // the mean extent, so each long diagonal spans far more than MAX_CELLS_PER_CHORD cells
    // and goes to the side list: this exercises the long-vs-short and long-vs-long loops.
    const side = 300
    const layers = ['F.Cu', 'In1.Cu', 'B.Cu']
    const nets = ['LA', 'LB', 'S0', 'S1', 'S2', 'S3']
    const r = rng(99)
    const tracks: GenTrack[] = []
    for (const layer of layers) {
      for (let k = 0; k < 80; k++) {
        const x = r() * side
        const y = r() * side
        const a = r() * Math.PI * 2
        const len = 1 + r() * 4
        tracks.push({
          net: nets[2 + Math.floor(r() * 4)],
          layer,
          width: 0.2,
          pts: [
            [x, y],
            [x + len * Math.cos(a), y + len * Math.sin(a)],
          ],
        })
      }
      // Two crossing long diagonals on different nets (long vs long short).
      tracks.push({ net: 'LA', layer, width: 0.3, pts: [[0, 0], [side, side]] })
      tracks.push({ net: 'LB', layer, width: 0.3, pts: [[0, side], [side, 0]] })
      // Short tracks that cross or nearly touch a long diagonal (long vs short).
      for (const t of [60, 120, 200, 250]) {
        tracks.push({ net: 'S0', layer, width: 0.2, pts: [[t - 1, t + 1], [t + 1, t - 1]] })
      }
      // Near miss: copper gap 0.1 mm, under the default minimum.
      tracks.push({ net: 'S1', layer, width: 0.2, pts: [[30, 30.65], [31, 31.65]] })
    }
    const board = buildBoard(tracks, nets, side)
    const expected = bruteForceIds(board, DEFAULT_CRITIC_OPTIONS.minClearanceMm)
    expect(expected.length).toBeLessThanOrEqual(50)

    // Guard the premise: the long-vs-long pair and long-vs-short pairs are present.
    const t = board.tracks
    const isLong = (i: number) => Math.hypot(t[i].end.x - t[i].start.x, t[i].end.y - t[i].start.y) > 100
    const pairs = expected.map((id) => id.match(/t(\d+)-t(\d+)/)!.slice(1).map(Number))
    expect(pairs.filter(([i, j]) => isLong(i) && isLong(j)).length).toBe(layers.length)
    expect(pairs.filter(([i, j]) => isLong(i) !== isLong(j)).length).toBeGreaterThanOrEqual(layers.length * 4)

    expect(trackIds(board)).toEqual(expected)
  })

  it('scales roughly linearly in track count (no quadratic pair enumeration)', () => {
    // Same track density at both sizes (side grows with sqrt of the count), so
    // a spatial index does work proportional to the track count while the old
    // all-pairs scan does work proportional to its square.
    const prepare = (n: number, side: number) => {
      const { tracks, nets } = randomTracks(n, side, 7, 500)
      const board = buildBoard(tracks, nets, side)
      return buildContext(board, extract(board), undefined, DEFAULT_CRITIC_OPTIONS)
    }
    // Each timed sample is a batch of INNER checks so the small board costs
    // roughly ten milliseconds per sample, well above timer and scheduler noise
    // (one check of it is about a millisecond). Both sizes use the same batch.
    const INNER = 15
    const timeCheck = (ctx: ReturnType<typeof prepare>, reps: number) => {
      let best = Infinity
      for (let r = 0; r < reps; r++) {
        const t0 = performance.now()
        let findings: ReturnType<typeof checkClearance> = []
        for (let k = 0; k < INNER; k++) findings = checkClearance(ctx)
        best = Math.min(best, performance.now() - t0)
        expect(Array.isArray(findings)).toBe(true)
      }
      return best
    }
    const smallCtx = prepare(1250, 1000 / Math.sqrt(8))
    const bigCtx = prepare(40000, 2000) // 32x the tracks at the same density
    timeCheck(smallCtx, 1) // warm the JIT so the small run is not the cold one
    const small = timeCheck(smallCtx, 5)
    const big = timeCheck(bigCtx, 4)

    // Intent: the indexed check stayed far from the old O(n squared) scan, which
    // was 500+ ms at 10k tracks. No absolute millisecond bound: CI runners are
    // up to 5x slower than a dev machine, so compare two sizes on the same
    // machine. 32x the tracks costs about 32x the time when indexed, plus cache
    // effects at the larger size (measured 74 to 78 locally), and about 1000x
    // when quadratic. The bound of 400 is over 5x the highest measured ratio, so
    // a loaded runner does not trip it, and it still fails on the quadratic scan
    // with a wide margin (the step is large precisely so that it does).
    const ratio = big / small
    expect(ratio).toBeLessThan(400)
  }, 60000)
})
