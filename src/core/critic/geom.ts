/**
 * core/critic/geom.ts
 *
 * Pure geometry helpers for the Board Critic (C0). Board-coordinate (KiCad mm)
 * math only — distances, track lengths/resistance, segment clearances, and
 * point-in-outline. No electron/react/three imports.
 *
 * Spec: docs/superpowers/specs/2026-06-19-circsim-board-critic-design.md §4
 */

import type { Footprint, Pad, TrackSegment, Vec2, OutlineGeometry } from '../kicad/types'

/** Copper resistivity (Ω·m) and 1 oz copper thickness (m). */
const RHO_CU = 1.68e-8
const OZ_THICKNESS_M = 34.8e-6

/** Euclidean distance between two board points. */
export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * World (board-coordinate) position of a pad center. The pad offset is rotated
 * by the FOOTPRINT rotation and translated by the footprint origin — matching
 * the convention in `renderer/.../viewport/componentGeometry.ts`
 * (px = cosA·x − sinA·y, py = sinA·x + cosA·y). The pad's own rotation affects
 * pad orientation, not its center, so it is not used here.
 */
export function padWorldPos(fp: Footprint, pad: Pad): Vec2 {
  const rad = (fp.at.rotDeg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const px = c * pad.at.x - s * pad.at.y
  const py = s * pad.at.x + c * pad.at.y
  return { x: fp.at.x + px, y: fp.at.y + py }
}

/** Length (mm) of a track — straight chord for segments, arc length for arcs. */
export function segLengthMm(seg: TrackSegment): number {
  if (seg.kind === 'segment') return dist(seg.start, seg.end)
  return arcLengthMm(seg)
}

/**
 * Arc length (mm) of a three-point arc (start/mid/end are points ON the arc).
 * Reconstructs the circle through the three points; falls back to the chord
 * (start→mid→end) when the points are (near-)collinear.
 */
export function arcLengthMm(arc: TrackSegment): number {
  if (arc.kind !== 'arc') return dist(arc.start, arc.end)
  const { x: ax, y: ay } = arc.start
  const { x: bx, y: by } = arc.mid
  const { x: cx, y: cy } = arc.end

  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) {
    // collinear → treat as straight
    return dist(arc.start, arc.mid) + dist(arc.mid, arc.end)
  }

  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)

  const angA = Math.atan2(ay - uy, ax - ux)
  const angM = Math.atan2(by - uy, bx - ux)
  const angB = Math.atan2(cy - uy, cx - ux)

  const ccw = (from: number, to: number): number => {
    let v = (to - from) % (2 * Math.PI)
    if (v < 0) v += 2 * Math.PI
    return v
  }
  const toMid = ccw(angA, angM)
  const toEnd = ccw(angA, angB)
  // If sweeping CCW from A reaches M before B, the arc is that CCW sweep;
  // otherwise it goes the other way.
  const sweep = toMid <= toEnd ? toEnd : 2 * Math.PI - toEnd
  return r * sweep
}

/**
 * DC resistance (Ω) of a copper trace of the given length/width and copper
 * weight: R = ρ·L / (w·t), t = oz × 34.8 µm. Infinity for a zero-width trace.
 */
export function trackResistanceOhms(lengthMm: number, widthMm: number, copperOz: number): number {
  if (widthMm <= 0) return Infinity
  const L = lengthMm * 1e-3
  const w = widthMm * 1e-3
  const t = copperOz * OZ_THICKNESS_M
  return (RHO_CU * L) / (w * t)
}

/** Shortest distance (mm) from point `p` to segment `a`–`b` (endpoints clamped). */
export function segPointDistanceMm(a: Vec2, b: Vec2, p: Vec2): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  let t = len2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * vx
  const cy = a.y + t * vy
  return Math.hypot(p.x - cx, p.y - cy)
}

function orient(p: Vec2, q: Vec2, r: Vec2): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
}

function onSegment(p: Vec2, q: Vec2, r: Vec2): boolean {
  return (
    Math.min(p.x, r.x) - 1e-12 <= q.x &&
    q.x <= Math.max(p.x, r.x) + 1e-12 &&
    Math.min(p.y, r.y) - 1e-12 <= q.y &&
    q.y <= Math.max(p.y, r.y) + 1e-12
  )
}

/** True if segments a1–a2 and b1–b2 intersect (including collinear overlap). */
export function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const o1 = orient(a1, a2, b1)
  const o2 = orient(a1, a2, b2)
  const o3 = orient(b1, b2, a1)
  const o4 = orient(b1, b2, a2)
  if (((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0))) return true
  if (Math.abs(o1) < 1e-12 && onSegment(a1, b1, a2)) return true
  if (Math.abs(o2) < 1e-12 && onSegment(a1, b2, a2)) return true
  if (Math.abs(o3) < 1e-12 && onSegment(b1, a1, b2)) return true
  if (Math.abs(o4) < 1e-12 && onSegment(b1, a2, b2)) return true
  return false
}

/** Shortest distance (mm) between two segments (0 if they intersect). */
export function segSegDistanceMm(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0
  return Math.min(
    segPointDistanceMm(a1, a2, b1),
    segPointDistanceMm(a1, a2, b2),
    segPointDistanceMm(b1, b2, a1),
    segPointDistanceMm(b1, b2, a2),
  )
}

function pointInPolygon(p: Vec2, ring: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x
    const yi = ring[i].y
    const xj = ring[j].x
    const yj = ring[j].y
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** True if `p` is inside the board outline (inside an outer loop, outside holes). */
export function pointInOutline(p: Vec2, outline: OutlineGeometry): boolean {
  let inOuter = false
  for (const ring of outline.outer) {
    if (pointInPolygon(p, ring)) {
      inOuter = true
      break
    }
  }
  if (!inOuter) return false
  for (const hole of outline.holes) {
    if (pointInPolygon(p, hole)) return false
  }
  return true
}
