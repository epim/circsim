/**
 * core/critic/checks/loopArea.ts
 *
 * Signal↔return loop-area heuristic for clock/high-speed nets (spec §5 item 7,
 * stretch — explicitly a v1 HEURISTIC, and every finding says so). Large
 * current loops radiate and pick up EMI in proportion to their enclosed area.
 *
 * v1 estimate: for each track segment of a high-speed-looking net, take the
 * distance from the segment (chord for arcs, like clearance v1) to the nearest
 * ground copper — a ground track chord or a ground-zone edge; a ground zone
 * whose polygon contains the segment's midpoint (a pour under/around it)
 * counts as distance 0. Loop area ≈ Σ(segment length × that distance). No
 * layer stackup or field solving — hence heuristic v1.
 *
 * Nets are matched by NAME (HIGH_SPEED_NET_RE, exported for tests) against the
 * full hierarchical net name; classified power/ground rails are never
 * candidates. When the board has no ground copper at all the check is silent —
 * there is no return path to measure against (the floating/decoupling checks
 * cover that class of problem).
 *
 * No simulation needed. Pure core; deterministic (nets iterated in sorted id
 * order).
 */

import type { CheckOutput, Finding } from '../types'
import type { CriticContext } from '../context'
import type { OutlineGeometry, TrackSegment, Vec2 } from '../../kicad/types'
import { classifyRails } from '../classify'
import { pointInOutline, segLengthMm, segSegDistanceMm } from '../geom'

/**
 * Net names that look like clocks / high-speed signals. Substring match,
 * case-insensitive, applied to the full (hierarchical) net name. Deliberately
 * loose — this is a screening heuristic, not a protocol detector.
 */
export const HIGH_SPEED_NET_RE = /clk|clock|sck|scl|mosi|miso|tx|rx|usb|d\+|d-|xtal|osc/i

/** Segments shorter than this (mm) contribute nothing (degenerate copper). */
const MIN_SEG_LENGTH_MM = 1e-6

interface GroundCopper {
  /** Ground track chords (arcs approximated by their start→end chord). */
  chords: { a: Vec2; b: Vec2 }[]
  /** Ground zone outer rings as OutlineGeometry (for containment) + edge list. */
  zones: { outline: OutlineGeometry; edges: { a: Vec2; b: Vec2 }[] }[]
}

function collectGroundCopper(ctx: CriticContext, groundNetIds: Set<number>): GroundCopper {
  const chords: GroundCopper['chords'] = []
  for (const t of ctx.board.tracks) {
    if (t.netId !== 0 && groundNetIds.has(t.netId)) chords.push({ a: t.start, b: t.end })
  }
  const zones: GroundCopper['zones'] = []
  for (const z of ctx.board.zones) {
    if (z.netId === undefined || !groundNetIds.has(z.netId)) continue
    const outer = z.polygon[0]
    if (!outer || outer.length < 3) continue
    const edges: { a: Vec2; b: Vec2 }[] = []
    for (let i = 0; i < outer.length; i++) {
      edges.push({ a: outer[i], b: outer[(i + 1) % outer.length] })
    }
    zones.push({
      outline: { outer: [outer], holes: z.polygon.slice(1), warnings: [] },
      edges,
    })
  }
  return { chords, zones }
}

/**
 * Distance (mm) from a signal chord to the nearest ground copper. 0 when a
 * ground zone contains the chord's midpoint (pour under/around the segment —
 * the return current flows right beneath it, so the enclosed loop is ~nil).
 */
function distToGround(a: Vec2, b: Vec2, gnd: GroundCopper): number {
  const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  let best = Infinity
  for (const z of gnd.zones) {
    if (pointInOutline(mid, z.outline)) return 0
    for (const e of z.edges) best = Math.min(best, segSegDistanceMm(a, b, e.a, e.b))
  }
  for (const c of gnd.chords) best = Math.min(best, segSegDistanceMm(a, b, c.a, c.b))
  return best
}

export function checkLoopArea(ctx: CriticContext): CheckOutput {
  const { board, circuit, opts } = ctx
  const { powerNetIds, groundNetIds } = classifyRails(circuit, ctx)

  const gnd = collectGroundCopper(ctx, groundNetIds)
  if (gnd.chords.length === 0 && gnd.zones.length === 0) {
    // No ground copper anywhere → no return path to measure against. If the
    // board actually has high-speed nets, this is the dangerous silent case
    // (a signal with no return plane): surface it as "not assessed" rather
    // than letting an empty result read as "checked and clean". With no
    // high-speed nets there is nothing to assess, so stay quiet.
    const hasHighSpeed = circuit.nets.some(
      (net) =>
        !powerNetIds.has(net.id) &&
        !groundNetIds.has(net.id) &&
        HIGH_SPEED_NET_RE.test(net.kicadName) &&
        board.tracks.some((t) => t.netId === net.id),
    )
    if (!hasHighSpeed) return []
    return {
      findings: [],
      notAssessed: 'not assessed (no ground copper on this board to measure loops against)',
    }
  }

  const findings: Finding[] = []

  for (const net of [...circuit.nets].sort((a, b) => a.id - b.id)) {
    if (powerNetIds.has(net.id) || groundNetIds.has(net.id)) continue
    if (!HIGH_SPEED_NET_RE.test(net.kicadName)) continue

    const segs: TrackSegment[] = board.tracks.filter((t) => t.netId === net.id)
    if (segs.length === 0) continue

    let areaMm2 = 0
    let trackLengthMm = 0
    let worstMid: Vec2 | undefined
    let worstContribution = -Infinity
    for (const t of segs) {
      const lengthMm = segLengthMm(t)
      if (lengthMm < MIN_SEG_LENGTH_MM) continue
      const d = distToGround(t.start, t.end, gnd)
      if (!Number.isFinite(d)) continue
      const contribution = lengthMm * d
      areaMm2 += contribution
      trackLengthMm += lengthMm
      if (contribution > worstContribution) {
        worstContribution = contribution
        worstMid = { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 }
      }
    }

    if (areaMm2 <= opts.loopAreaWarnMm2) continue
    const severity = areaMm2 > opts.loopAreaErrMm2 ? 'error' : 'warn'
    const netName = board.netById.get(net.id)?.name ?? net.kicadName

    findings.push({
      id: `loop-area:${net.id}`,
      check: 'loop-area',
      severity,
      title: `"${netName}" loop area ≈ ${areaMm2.toFixed(0)} mm² — route a ground return alongside or add a ground pour`,
      detail:
        `${netName} looks like a clock/high-speed signal, and its ${trackLengthMm.toFixed(0)} mm ` +
        `of track encloses roughly ${areaMm2.toFixed(0)} mm² against the nearest ground copper ` +
        `(threshold: ${opts.loopAreaWarnMm2} mm²). Big signal↔return loops radiate and pick up ` +
        `EMI in proportion to their area. This is a coarse v1 heuristic — it sums each segment's ` +
        `length × distance to the nearest ground track/zone (a ground pour under a segment counts ` +
        `as zero) and does not model the layer stack or actual return-current spread.`,
      assumption:
        'heuristic v1: loop area ≈ Σ(segment length × distance to nearest ground copper); ' +
        'net matched by name; no field solver',
      netId: net.id,
      location: worstMid,
      suggestion: 'Route a ground return alongside the signal or add a ground pour under it.',
      metrics: {
        loopAreaMm2: areaMm2,
        trackLengthMm,
        warnMm2: opts.loopAreaWarnMm2,
        errMm2: opts.loopAreaErrMm2,
      },
    })
  }

  return findings
}
