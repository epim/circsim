/**
 * core/kicad/outline.ts
 *
 * Edge.Cuts outline stitching — Task 4.
 *
 * Collects gr_line/gr_arc/gr_circle/gr_rect EdgePrimitives,
 * tessellates arcs, chains segments into closed loops,
 * classifies outer boundary vs cutout holes by area and containment.
 *
 * Spec §8.2 "Edge.Cuts stitching"
 *
 * Algorithm:
 *   1. Tessellate each primitive into a polyline (list of Vec2 endpoints).
 *   2. Chain polylines into closed loops via endpoint matching with tolerance.
 *   3. Separate circles (always-closed) from chained loops.
 *   4. Compute signed area of each loop; classify outer (larger) vs holes
 *      by containment test (point-in-polygon).
 *   5. Normalize winding: outer CCW, holes CW (in KiCad Y-down coordinates,
 *      CCW outer = positive signed area).
 *   6. If chaining fails (open chains remain > tolerance), fall back to
 *      bounding box and emit a warning containing "outline".
 */

import type { EdgePrimitive, OutlineGeometry, Vec2 } from './types'

// ─── constants ────────────────────────────────────────────────────────────────

/** Default endpoint-matching tolerance in mm */
const DEFAULT_TOLERANCE_MM = 0.01

/**
 * Minimum number of tessellation steps per 90° of arc.
 * This guarantees ≥ 8 points per 90° arc as required by the spec.
 */
const STEPS_PER_90_DEG = 8

// ─── math helpers ─────────────────────────────────────────────────────────────

function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

/** Signed polygon area. Positive = CCW in standard (Y-up) coords.
 *  In KiCad's Y-down screen coords, CCW on screen = negative signed area here. */
function signedArea(pts: Vec2[]): number {
  let area = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += pts[i].x * pts[j].y
    area -= pts[j].x * pts[i].y
  }
  return area / 2
}

/** Ray-casting point-in-polygon */
function pointInPolygon(pt: Vec2, polygon: Vec2[]): boolean {
  let inside = false
  const n = polygon.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// ─── arc tessellation ─────────────────────────────────────────────────────────

/**
 * Compute the circumcenter of three points.
 * Returns null if the three points are collinear (can't form an arc).
 */
function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const ax = a.x, ay = a.y
  const bx = b.x, by = b.y
  const cx = c.x, cy = c.y

  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(D) < 1e-10) return null

  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    D
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    D

  return { x: ux, y: uy }
}

/**
 * Tessellate a KiCad three-point arc (start/mid/end are points ON the arc)
 * into a sequence of Vec2 points (inclusive of start, exclusive of end so
 * chaining works correctly).
 *
 * Returns ≥ STEPS_PER_90_DEG points per 90° of arc.
 */
function tessellateArc(
  start: Vec2,
  mid: Vec2,
  end: Vec2,
  stepsPerQuarter = STEPS_PER_90_DEG
): Vec2[] {
  const center = circumcenter(start, mid, end)
  if (!center) {
    // Degenerate arc (collinear points) → treat as a line
    return [start]
  }

  const r = dist(center, start)

  // Angles from center
  let startAngle = Math.atan2(start.y - center.y, start.x - center.x)
  let midAngle = Math.atan2(mid.y - center.y, mid.x - center.x)
  let endAngle = Math.atan2(end.y - center.y, end.x - center.x)

  // Determine sweep direction.
  // The midpoint of the arc must lie on the arc between start and end.
  // We try both CW and CCW, pick the one where midAngle lies between startAngle and endAngle.
  function sweepContainsMid(
    from: number,
    to: number,
    isPositive: boolean
  ): boolean {
    // Normalize mid angle relative to from
    let m = midAngle - from
    let t = to - from
    if (isPositive) {
      // CCW (positive sweep)
      if (m < 0) m += 2 * Math.PI
      if (t <= 0) t += 2 * Math.PI
    } else {
      // CW (negative sweep)
      if (m > 0) m -= 2 * Math.PI
      if (t >= 0) t -= 2 * Math.PI
    }
    return isPositive ? m >= 0 && m <= t + 1e-9 : m <= 0 && m >= t - 1e-9
  }

  let sweep: number
  if (sweepContainsMid(startAngle, endAngle, true)) {
    // CCW sweep
    sweep = endAngle - startAngle
    if (sweep <= 0) sweep += 2 * Math.PI
  } else {
    // CW sweep
    sweep = endAngle - startAngle
    if (sweep >= 0) sweep -= 2 * Math.PI
  }

  // Number of steps: ≥ stepsPerQuarter per 90°
  const absAngle = Math.abs(sweep)
  const steps = Math.max(1, Math.ceil((absAngle / (Math.PI / 2)) * stepsPerQuarter))

  const points: Vec2[] = []
  for (let i = 0; i < steps; i++) {
    const t = i / steps
    const angle = startAngle + sweep * t
    points.push({
      x: center.x + r * Math.cos(angle),
      y: center.y + r * Math.sin(angle),
    })
  }
  // Note: end point is NOT added here — it will be the start of the next primitive
  return points
}

/**
 * Tessellate a full circle into a closed polygon.
 * Returns points for the full circle (NOT including a repeated final point).
 */
function tessellateCircle(
  center: Vec2,
  radius: number,
  stepsPerQuarter = STEPS_PER_90_DEG
): Vec2[] {
  const steps = stepsPerQuarter * 4 // full circle = 4 quarters
  const points: Vec2[] = []
  for (let i = 0; i < steps; i++) {
    const angle = (2 * Math.PI * i) / steps
    points.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    })
  }
  return points
}

// ─── primitive → polyline conversion ─────────────────────────────────────────

interface Segment {
  points: Vec2[]  // does NOT include the closing/last point (which is startOf next)
  isClosedCircle: boolean
}

/**
 * Convert an EdgePrimitive into a sequence of points for chaining.
 * For arcs: returns tessellated points (start inclusive, end exclusive).
 * For circles: returns a complete closed polygon (isClosedCircle=true).
 */
function primitiveToSegment(prim: EdgePrimitive): Segment {
  switch (prim.kind) {
    case 'line':
      return { points: [prim.start], isClosedCircle: false }

    case 'arc':
      return {
        points: tessellateArc(prim.start, prim.mid, prim.end),
        isClosedCircle: false,
      }

    case 'circle': {
      const radius = dist(prim.center, prim.radiusPoint)
      return {
        points: tessellateCircle(prim.center, radius),
        isClosedCircle: true,
      }
    }

    case 'rect': {
      // Expand rect into 4 line segments
      const { start, end } = prim
      return {
        points: [
          { x: start.x, y: start.y },
          { x: end.x, y: start.y },
          { x: end.x, y: end.y },
          { x: start.x, y: end.y },
        ],
        isClosedCircle: false, // treat as a closed loop (4 points = closed rect)
      }
    }
  }
}

// ─── chain builder ─────────────────────────────────────────────────────────────

/**
 * The "end" point of a segment for chaining purposes is the last point of the
 * NEXT segment's start (since each segment omits its own end).
 * We need to track end explicitly so we know what the segment chains to.
 */
/**
 * Collect all open (non-circle) primitives and build chains via
 * greedy endpoint matching. Returns:
 *   - closedLoops: chains that were successfully closed
 *   - openChains: chains that couldn't be closed (gap > tolerance)
 */
function buildChains(
  segments: Array<{ seg: Segment; endPt: Vec2 }>,
  toleranceMm: number
): { closedLoops: Vec2[][]; openChains: Vec2[][] } {
  // Each work item is a chain with a current start point and end point
  type Work = { pts: Vec2[]; startPt: Vec2; endPt: Vec2 }

  // Initialize: each segment starts its own chain
  const remaining: Work[] = segments.map(({ seg, endPt }) => ({
    pts: [...seg.points],
    startPt: seg.points[0],
    endPt,
  }))

  const closedLoops: Vec2[][] = []

  // Greedy chain assembly: try to extend each chain by finding the next segment
  // whose start/end is within tolerance of the chain's end point.
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < remaining.length; i++) {
      const chain = remaining[i]

      // Check if chain is already closed
      if (dist(chain.endPt, chain.startPt) <= toleranceMm) {
        // Closed loop
        closedLoops.push(chain.pts)
        remaining.splice(i, 1)
        i--
        changed = true
        continue
      }

      // Try to find a segment to attach to end of chain
      for (let j = 0; j < remaining.length; j++) {
        if (i === j) continue
        const candidate = remaining[j]

        if (dist(chain.endPt, candidate.startPt) <= toleranceMm) {
          // Candidate starts where chain ends — attach it
          chain.pts.push(...candidate.pts)
          chain.endPt = candidate.endPt
          remaining.splice(j, 1)
          if (j < i) i--
          changed = true
          break
        } else if (dist(chain.endPt, candidate.endPt) <= toleranceMm) {
          // Candidate ends where chain ends — reverse and attach
          const reversed = [...candidate.pts].reverse()
          // After reversal, candidate's original start becomes the new end
          chain.pts.push(...reversed)
          chain.endPt = candidate.startPt
          remaining.splice(j, 1)
          if (j < i) i--
          changed = true
          break
        }
      }
    }
  }

  // Final pass: close any chains that are now within tolerance
  for (let i = remaining.length - 1; i >= 0; i--) {
    const chain = remaining[i]
    if (dist(chain.endPt, chain.startPt) <= toleranceMm) {
      closedLoops.push(chain.pts)
      remaining.splice(i, 1)
    }
  }

  return {
    closedLoops,
    openChains: remaining.map(w => [...w.pts, w.endPt]),
  }
}

// ─── bounding box fallback ────────────────────────────────────────────────────

function boundingBoxOf(allPoints: Vec2[]): Vec2[] {
  if (allPoints.length === 0) return []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of allPoints) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
}

// ─── winding normalization ─────────────────────────────────────────────────────

/**
 * KiCad uses Y-down screen coordinates.
 * In Y-down coordinates, a polygon traversed CW on screen has POSITIVE
 * signed area in the mathematical formula (because Y axis is flipped).
 *
 * Spec says: "outer CCW, holes CW"
 * In KiCad Y-down coords:
 *   CCW on screen = negative signed area (by standard formula)
 *   CW  on screen = positive signed area
 *
 * However, for the substrate builder, Three.js uses Y-up, so we flip Y.
 * After flip: CW on screen becomes CCW in 3D space.
 *
 * To keep things consistent and testable, we define:
 *   - Outer loops: positive signed area (CW in screen, CCW after Y-flip to 3D)
 *   - Holes: negative signed area (CCW in screen, CW after Y-flip to 3D)
 *
 * This is the convention used by Three.js ShapeUtils and earcut for holes.
 */
function ensurePositiveArea(pts: Vec2[]): Vec2[] {
  return signedArea(pts) >= 0 ? pts : [...pts].reverse()
}

function ensureNegativeArea(pts: Vec2[]): Vec2[] {
  return signedArea(pts) <= 0 ? pts : [...pts].reverse()
}

// ─── containment: determine if a closed loop is a hole ───────────────────────

/**
 * Check whether smallLoop is contained within bigLoop.
 * Uses the first point of smallLoop as the test point.
 */
function isContainedIn(smallLoop: Vec2[], bigLoop: Vec2[]): boolean {
  if (smallLoop.length === 0 || bigLoop.length === 0) return false
  return pointInPolygon(smallLoop[0], bigLoop)
}

// ─── main API ─────────────────────────────────────────────────────────────────

/**
 * Stitch Edge.Cuts primitives into an OutlineGeometry.
 *
 * @param primitives  - Array of EdgePrimitive from parseBoard()
 * @param toleranceMm - Endpoint matching tolerance (default 0.01 mm)
 * @returns OutlineGeometry with outer loops, holes, and any warnings
 */
export function stitchOutline(
  primitives: EdgePrimitive[],
  toleranceMm = DEFAULT_TOLERANCE_MM
): OutlineGeometry {
  const warnings: string[] = []

  if (primitives.length === 0) {
    return { outer: [], holes: [], warnings }
  }

  // Step 1: Separate circles from chainable primitives
  const circles: Vec2[][] = []
  const chainSegs: Array<{ seg: Segment; endPt: Vec2 }> = []

  for (const prim of primitives) {
    const seg = primitiveToSegment(prim)
    if (seg.isClosedCircle) {
      circles.push(seg.points)
    } else {
      // Compute the "end" point for chaining
      let endPt: Vec2
      switch (prim.kind) {
        case 'line':
          endPt = prim.end
          break
        case 'arc':
          endPt = prim.end
          break
        case 'rect':
          endPt = { x: prim.start.x, y: prim.start.y } // rect is self-closing
          break
        default:
          endPt = seg.points[seg.points.length - 1] ?? { x: 0, y: 0 }
      }
      // Special case: rect is pre-closed (4 corners)
      if (prim.kind === 'rect') {
        // Treat it as a closed loop directly
        circles.push(seg.points)
      } else {
        chainSegs.push({ seg, endPt })
      }
    }
  }

  // Collect all points for bounding box fallback
  const allPoints: Vec2[] = []
  for (const { seg } of chainSegs) allPoints.push(...seg.points)
  for (const prim of primitives) {
    if (prim.kind === 'line') { allPoints.push(prim.end) }
    if (prim.kind === 'arc') { allPoints.push(prim.end) }
  }
  for (const loop of circles) allPoints.push(...loop)

  // Step 2: Chain open segments into closed loops
  const { closedLoops, openChains } = buildChains(chainSegs, toleranceMm)

  // Step 3: Handle open chains — try to close them by snapping the endpoint
  //         to the chain's start (fallback if within 1mm or the gap is "close")
  //         For anything still open, use bounding box fallback.
  let usedFallback = false
  if (openChains.length > 0) {
    // There are uncloseable chains — emit warning and fall back to bounding box
    warnings.push(
      `outline: ${openChains.length} open chain(s) found (gap > ${toleranceMm}mm tolerance). Falling back to bounding-box outline.`
    )
    usedFallback = true
  }

  // Step 4: All closed loops = chained loops + self-closed circles (from circles array)
  let allLoops: Vec2[][] = [...closedLoops, ...circles]

  if (usedFallback || allLoops.length === 0) {
    // Bounding box fallback
    const bbox = boundingBoxOf(allPoints)
    if (bbox.length === 0) {
      return { outer: [], holes: [], warnings }
    }
    // If we have some closed loops AND some open chains, keep the closed loops
    // but also add the warning
    if (allLoops.length === 0) {
      allLoops = [bbox]
    }
  }

  // Step 5: Classify outer vs holes by area and containment
  // Sort loops by absolute area descending so the largest is considered first
  allLoops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))

  const outerLoops: Vec2[][] = []
  const holeLoops: Vec2[][] = []

  for (const loop of allLoops) {
    if (loop.length < 3) continue

    // Check if this loop is contained within any outer loop already found
    let isHole = false
    for (const outer of outerLoops) {
      if (isContainedIn(loop, outer)) {
        isHole = true
        break
      }
    }

    if (isHole) {
      holeLoops.push(ensureNegativeArea(loop))
    } else {
      outerLoops.push(ensurePositiveArea(loop))
    }
  }

  // Emit warning if multiple outer loops
  if (outerLoops.length > 1) {
    warnings.push(
      `outline: ${outerLoops.length} disjoint outer loops found. Using all loops; the largest is listed first.`
    )
    // Sort outer loops by area descending (largest first)
    outerLoops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
  }

  return { outer: outerLoops, holes: holeLoops, warnings }
}
