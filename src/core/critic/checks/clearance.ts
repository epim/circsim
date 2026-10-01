/**
 * core/critic/checks/clearance.ts
 *
 * Copper-clearance lint: flags different-net tracks on the same layer whose
 * COPPER comes closer than the minimum clearance, and tracks whose copper runs
 * closer to the board edge than the minimum. No simulation needed.
 *
 * Gaps are measured between copper edges, not centerlines: the gap between two
 * tracks is the centerline distance minus (w1 + w2) / 2, and the gap to the
 * board edge is the centerline distance minus w / 2. A gap at or below zero
 * means the copper touches or overlaps (an error); a positive gap under the
 * minimum is a warning.
 *
 * NOT ASSESSED: track-to-pad, pad-to-pad, via and zone clearance. Only
 * track-to-track and track-to-edge are checked (see website/docs).
 *
 * v1 approximates arc tracks by their chord (start to end). Findings are capped
 * to keep the report readable; a trailing info note records any overflow.
 *
 * Candidate pairs come from a uniform grid per copper layer, so the cost is
 * proportional to the number of nearby pairs rather than the square of the
 * track count. Each track's box is inflated by its half width plus half the
 * minimum clearance; two tracks can only violate when their inflated boxes
 * overlap, and each such pair is tested exactly once, in the grid cell that
 * holds the lower-left corner of the boxes' overlap. Tracks that would span too
 * many cells (long diagonals) are kept in a small side list and tested against
 * every track on their layer. Tracks with no net (netId 0) are skipped to avoid
 * false positives.
 */

import type { Finding } from '../types'
import type { CriticContext } from '../context'
import type { TrackSegment, Vec2 } from '../../kicad/types'
import { segSegDistanceMm } from '../geom'

const MAX_FINDINGS = 50

const ASSUMPTION =
  'Generic minimum clearance (not your net-class rules), measured between copper edges; arcs approximated by their chord; pad, via and zone clearance not assessed.'

/** Tolerance (mm) on the clearance comparison and the touch/overlap threshold. */
const EPS = 1e-6

/** A track spanning more than this many grid cells goes to the side list. */
const MAX_CELLS_PER_CHORD = 256

/** Smallest grid cell edge (mm), so degenerate boards do not explode the grid. */
const MIN_CELL_MM = 0.5

interface Chord {
  a: Vec2
  b: Vec2
  layer: string
  netId: number
  halfW: number
  /** Bounding box of the centerline. */
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Bounding box inflated by halfW + min / 2 (+ EPS): the conflict reach. */
  ix0: number
  iy0: number
  ix1: number
  iy1: number
}

function chordOf(t: TrackSegment, min: number): Chord {
  const a = t.start
  const b = t.end
  const halfW = Math.max(0, t.widthMm) / 2
  const r = halfW + min / 2 + EPS
  const minX = Math.min(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxX = Math.max(a.x, b.x)
  const maxY = Math.max(a.y, b.y)
  return {
    a,
    b,
    layer: t.layer,
    netId: t.netId,
    halfW,
    minX,
    minY,
    maxX,
    maxY,
    ix0: minX - r,
    iy0: minY - r,
    ix1: maxX + r,
    iy1: maxY + r,
  }
}

function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

interface Violation {
  i: number
  j: number
  /** Copper-edge gap in mm (negative when the copper overlaps). */
  gap: number
}

/** True if the inflated boxes of two chords overlap. */
function reachOverlaps(s: Chord, t: Chord): boolean {
  return s.ix0 <= t.ix1 && t.ix0 <= s.ix1 && s.iy0 <= t.iy1 && t.iy0 <= s.iy1
}

/** Exact copper gap between two chords, or undefined when it meets the minimum. */
function violation(
  chords: Chord[],
  i: number,
  j: number,
  min: number,
): Violation | undefined {
  const s = chords[i]
  const t = chords[j]
  if (s.netId === t.netId) return undefined
  if (!reachOverlaps(s, t)) return undefined
  const gap = segSegDistanceMm(s.a, s.b, t.a, t.b) - (s.halfW + t.halfW)
  if (gap < min - EPS) return i < j ? { i, j, gap } : { i: j, j: i, gap }
  return undefined
}

/** Track-to-track violations on one layer. `idx` holds chord indices, ascending. */
function layerViolations(chords: Chord[], idx: number[], min: number, out: Violation[]): void {
  if (idx.length < 2) return

  let gx0 = Infinity
  let gy0 = Infinity
  let gx1 = -Infinity
  let gy1 = -Infinity
  let extent = 0
  for (const i of idx) {
    const c = chords[i]
    gx0 = Math.min(gx0, c.ix0)
    gy0 = Math.min(gy0, c.iy0)
    gx1 = Math.max(gx1, c.ix1)
    gy1 = Math.max(gy1, c.iy1)
    extent += Math.max(c.ix1 - c.ix0, c.iy1 - c.iy0)
  }
  const cell = Math.max(MIN_CELL_MM, extent / idx.length)
  const nx = Math.floor((gx1 - gx0) / cell) + 1
  const cellX = (x: number) => Math.floor((x - gx0) / cell)
  const cellY = (y: number) => Math.floor((y - gy0) / cell)

  const grid = new Map<number, number[]>()
  const big: number[] = []
  const small: number[] = []
  for (const i of idx) {
    const c = chords[i]
    const cx0 = cellX(c.ix0)
    const cx1 = cellX(c.ix1)
    const cy0 = cellY(c.iy0)
    const cy1 = cellY(c.iy1)
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CELLS_PER_CHORD) {
      big.push(i)
      continue
    }
    small.push(i)
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cy * nx + cx
        const list = grid.get(key)
        if (list) list.push(i)
        else grid.set(key, [i])
      }
    }
  }

  // Small chords: test each overlapping pair once, in its canonical cell.
  for (const [key, list] of grid) {
    if (list.length < 2) continue
    const cy = Math.floor(key / nx)
    const cx = key - cy * nx
    for (let p = 0; p < list.length; p++) {
      const s = chords[list[p]]
      for (let q = p + 1; q < list.length; q++) {
        const t = chords[list[q]]
        if (cellX(Math.max(s.ix0, t.ix0)) !== cx || cellY(Math.max(s.iy0, t.iy0)) !== cy) continue
        const v = violation(chords, list[p], list[q], min)
        if (v) out.push(v)
      }
    }
  }

  // Long chords: against every small chord and every other long chord.
  for (let p = 0; p < big.length; p++) {
    for (const j of small) {
      const v = violation(chords, big[p], j, min)
      if (v) out.push(v)
    }
    for (let q = p + 1; q < big.length; q++) {
      const v = violation(chords, big[p], big[q], min)
      if (v) out.push(v)
    }
  }
}

export function checkClearance(ctx: CriticContext): Finding[] {
  const { board, opts } = ctx
  const min = opts.minClearanceMm
  const findings: Finding[] = []
  let overflow = 0

  const push = (f: Finding) => {
    if (findings.length < MAX_FINDINGS) findings.push(f)
    else overflow++
  }

  const chords = board.tracks.map((t) => chordOf(t, min))

  // ── track ↔ track (same layer, different net) ──────────────────────────────
  const byLayer = new Map<string, number[]>()
  for (let i = 0; i < chords.length; i++) {
    if (chords[i].netId === 0) continue
    const list = byLayer.get(chords[i].layer)
    if (list) list.push(i)
    else byLayer.set(chords[i].layer, [i])
  }
  const violations: Violation[] = []
  for (const idx of byLayer.values()) layerViolations(chords, idx, min, violations)
  // Report in track order so the finding cap and ids are deterministic.
  violations.sort((p, q) => p.i - q.i || p.j - q.j)

  for (const { i, j, gap } of violations) {
    const s = chords[i]
    const t = chords[j]
    const sName = board.netById.get(s.netId)?.name ?? `net ${s.netId}`
    const tName = board.netById.get(t.netId)?.name ?? `net ${t.netId}`
    const overlap = gap <= EPS
    push({
      id: `clearance:t${i}-t${j}`,
      check: 'clearance',
      severity: overlap ? 'error' : 'warn',
      title: overlap
        ? `Tracks "${sName}" and "${tName}" touch or overlap on ${s.layer}`
        : `Tracks "${sName}" and "${tName}" are ${gap.toFixed(3)} mm apart on ${s.layer}`,
      detail: overlap
        ? `The copper of these different-net tracks touches or overlaps (copper gap ${gap.toFixed(3)} mm, minimum clearance ${min} mm). A short.`
        : `Minimum clearance is ${min} mm; the copper of these different-net tracks comes within ${gap.toFixed(3)} mm. A short or a fabrication/etch risk.`,
      location: mid(s.a, s.b),
      metrics: { gapMm: gap, minClearanceMm: min },
      suggestion: 'Increase spacing or reroute one of the tracks.',
      assumption: ASSUMPTION,
    })
  }

  // ── track ↔ board edge ─────────────────────────────────────────────────────
  const edges: { a: Vec2; b: Vec2; minX: number; minY: number; maxX: number; maxY: number }[] = []
  for (const ring of board.outline.outer) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      edges.push({
        a,
        b,
        minX: Math.min(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x),
        maxY: Math.max(a.y, b.y),
      })
    }
  }
  for (let i = 0; i < chords.length; i++) {
    const s = chords[i]
    if (s.netId === 0) continue
    const reach = s.halfW + min + EPS
    for (const e of edges) {
      // Cheap reject: the edge's box is farther than the copper can reach.
      if (
        e.minX - s.maxX > reach ||
        s.minX - e.maxX > reach ||
        e.minY - s.maxY > reach ||
        s.minY - e.maxY > reach
      ) {
        continue
      }
      const gap = segSegDistanceMm(s.a, s.b, e.a, e.b) - s.halfW
      if (gap < min - EPS) {
        const sName = board.netById.get(s.netId)?.name ?? `net ${s.netId}`
        const overlap = gap <= EPS
        push({
          id: `clearance:edge:t${i}`,
          check: 'clearance',
          severity: overlap ? 'error' : 'warn',
          title: overlap
            ? `Track "${sName}" touches or crosses the board edge`
            : `Track "${sName}" runs ${gap.toFixed(3)} mm from the board edge`,
          detail: `Copper closer than ${min} mm to the edge risks exposure/shorting after the board is cut (copper gap ${gap.toFixed(3)} mm).`,
          location: mid(s.a, s.b),
          metrics: { gapMm: gap, minClearanceMm: min },
          suggestion: 'Pull the track in from the edge.',
          assumption: ASSUMPTION,
        })
        break // one edge finding per track is enough
      }
    }
  }

  if (overflow > 0) {
    findings.push({
      id: 'clearance:overflow',
      check: 'clearance',
      severity: 'info',
      title: `+${overflow} more clearance issues not shown`,
      detail: `Showing the first ${MAX_FINDINGS}. Tighten the design rules or fix these first, then re-run.`,
      metrics: { hidden: overflow },
    })
  }

  return findings
}
