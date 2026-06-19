/**
 * core/critic/checks/clearance.ts
 *
 * Copper-clearance lint: flags different-net tracks on the same layer that come
 * closer than the minimum clearance, and tracks that run closer to the board
 * edge than the minimum. No simulation needed.
 *
 * v1 approximates arc tracks by their chord (start→end). Findings are capped to
 * keep the report readable; a trailing info note records any overflow. Pairs are
 * AABB-rejected before the precise segment-distance test (O(n²) but cheap on real
 * boards). Tracks with no net (netId 0) are skipped to avoid false positives.
 */

import type { Finding } from '../types'
import type { CriticContext } from '../context'
import type { TrackSegment, Vec2 } from '../../kicad/types'
import { segSegDistanceMm } from '../geom'

const MAX_FINDINGS = 50

interface Chord {
  a: Vec2
  b: Vec2
  layer: string
  netId: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function chordOf(t: TrackSegment): Chord {
  const a = t.start
  const b = t.end
  return {
    a,
    b,
    layer: t.layer,
    netId: t.netId,
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  }
}

/** True if the two chords' bounding boxes are more than `gap` apart (cheap reject). */
function aabbApart(s: Chord, t: Chord, gap: number): boolean {
  return (
    s.minX - t.maxX > gap ||
    t.minX - s.maxX > gap ||
    s.minY - t.maxY > gap ||
    t.minY - s.maxY > gap
  )
}

function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
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

  const chords = board.tracks.map(chordOf)

  // ── track ↔ track (same layer, different net) ──────────────────────────────
  for (let i = 0; i < chords.length; i++) {
    const s = chords[i]
    if (s.netId === 0) continue
    for (let j = i + 1; j < chords.length; j++) {
      const t = chords[j]
      if (t.netId === 0) continue
      if (s.layer !== t.layer) continue
      if (s.netId === t.netId) continue
      if (aabbApart(s, t, min)) continue
      const d = segSegDistanceMm(s.a, s.b, t.a, t.b)
      if (d < min - 1e-6) {
        const sName = board.netById.get(s.netId)?.name ?? `net ${s.netId}`
        const tName = board.netById.get(t.netId)?.name ?? `net ${t.netId}`
        push({
          id: `clearance:t${i}-t${j}`,
          check: 'clearance',
          severity: d <= 1e-6 ? 'error' : 'warn',
          title:
            d <= 1e-6
              ? `Tracks "${sName}" and "${tName}" touch or overlap on ${s.layer}`
              : `Tracks "${sName}" and "${tName}" are ${d.toFixed(3)} mm apart on ${s.layer}`,
          detail: `Minimum clearance is ${min} mm; these different-net tracks come within ${d.toFixed(3)} mm. A short or a fabrication/etch risk.`,
          location: mid(s.a, s.b),
          metrics: { gapMm: d, minClearanceMm: min },
          suggestion: 'Increase spacing or reroute one of the tracks.',
        })
      }
    }
  }

  // ── track ↔ board edge ─────────────────────────────────────────────────────
  const edges: { a: Vec2; b: Vec2 }[] = []
  for (const ring of board.outline.outer) {
    for (let i = 0; i < ring.length; i++) {
      edges.push({ a: ring[i], b: ring[(i + 1) % ring.length] })
    }
  }
  for (let i = 0; i < chords.length; i++) {
    const s = chords[i]
    if (s.netId === 0) continue
    for (const e of edges) {
      const d = segSegDistanceMm(s.a, s.b, e.a, e.b)
      if (d < min - 1e-6) {
        const sName = board.netById.get(s.netId)?.name ?? `net ${s.netId}`
        push({
          id: `clearance:edge:t${i}`,
          check: 'clearance',
          severity: 'warn',
          title: `Track "${sName}" runs ${d.toFixed(3)} mm from the board edge`,
          detail: `Copper closer than ${min} mm to the edge risks exposure/shorting after the board is cut.`,
          location: mid(s.a, s.b),
          metrics: { gapMm: d, minClearanceMm: min },
          suggestion: 'Pull the track in from the edge.',
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
