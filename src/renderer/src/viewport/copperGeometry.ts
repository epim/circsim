/**
 * viewport/copperGeometry.ts
 *
 * Task 17 — Copper geometry builder.
 *
 * Exports:
 *   buildCopper(board)       → Map<netId, { F?: BufferGeometry; B?: BufferGeometry }>
 *   buildViaInstances(board) → { mesh: InstancedMesh; netIds: number[]; count: number }
 *
 * Design principles (spec §10.1, §10.3):
 *   - All KiCad coords converted via kicadToWorld (imported from boardGeometry).
 *   - Copper grouped per (net, layer) — enabling picking + per-net voltage tinting.
 *   - Merged via BufferGeometryUtils.mergeGeometries.
 *   - No WebGL context required — THREE core geometry runs headless in tests.
 *
 * Track segments:
 *   kind:'segment' → quad strip (rect) + two semicircular end-caps (12-segment fans each).
 *   kind:'arc'     → tessellated from three-point start/mid/end form (compute circumcenter);
 *                    ≥8 points per 90° of arc, then rendered as a polyline strip with caps.
 *
 * Pad shapes:
 *   circle    → CircleGeometry
 *   rect      → PlaneGeometry
 *   oval      → capsule-style Shape (two semicircles + rect)
 *   roundrect → Shape with rounded corners (corner radius = min(w,h) * rratio, rratio≈0.25)
 *   custom    → bounding rect fallback + console.warn
 *
 * Zones:
 *   Earcut-triangulated via THREE.ShapeUtils.triangulateShape (same as ExtrudeGeometry).
 *   Thin extrusion (0.035 mm ~ 1 oz copper).
 *
 * Vias:
 *   One InstancedMesh of CylinderGeometry; instance→netId array alongside.
 *
 * Spec §10.1
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { BoardModel, Pad, Via } from '../../../core/kicad/types'
import { kicadToWorld } from './boardGeometry'

// ─── constants ─────────────────────────────────────────────────────────────────

/** Copper layer thickness (1 oz copper ≈ 0.035 mm). Reserved for future extrusion. */
// const COPPER_THICKNESS_MM = 0.035

/** Segments per half-circle for round caps (12 → 24-segment full circle). */
const CAP_SEGMENTS = 12

/** Minimum arc points per 90° of arc sweep. */
const ARC_POINTS_PER_90 = 8

/** Default roundrect corner ratio when not parsed from file. */
const DEFAULT_RRATIO = 0.25

// ─── copper material (PBR, spec §10.1) ────────────────────────────────────────

/** Base copper MeshStandardMaterial template. One clone per net for per-net tinting. */
export const copperBaseMaterial = new THREE.MeshStandardMaterial({
  color: 0xb87333,   // copper
  metalness: 0.9,
  roughness: 0.3,
})

/**
 * Create a per-net copper material (clone of base so tinting is per-net).
 * The caller stores this and can later set .color to apply voltage tinting.
 */
export function makeCopperMaterial(): THREE.MeshStandardMaterial {
  return copperBaseMaterial.clone()
}

// ─── math helpers ──────────────────────────────────────────────────────────────

/** Circumcenter of three 2-D points (undefined when points are collinear). */
function circumcenter(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): { x: number; y: number } | null {
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(D) < 1e-12) return null
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D
  return { x: ux, y: uy }
}

/**
 * Tessellate a KiCad three-point arc (start/mid/end are points ON the arc) into
 * a polyline of world-space {x,y} points.
 *
 * Algorithm:
 *   1. Compute circumcenter from the three points.
 *   2. Determine start angle and end angle in KiCad space.
 *   3. Determine sweep direction (mid point must lie on the arc).
 *   4. Sample ≥ ARC_POINTS_PER_90 points per 90° of sweep.
 */
function tessellateArc(
  startK: { x: number; y: number },
  midK: { x: number; y: number },
  endK: { x: number; y: number }
): { x: number; y: number }[] {
  const center = circumcenter(startK.x, startK.y, midK.x, midK.y, endK.x, endK.y)
  if (!center) {
    // Collinear — treat as a straight segment
    return [kicadToWorld(startK.x, startK.y), kicadToWorld(endK.x, endK.y)]
  }

  const r = Math.sqrt((startK.x - center.x) ** 2 + (startK.y - center.y) ** 2)
  const aStart = Math.atan2(startK.y - center.y, startK.x - center.x)
  const aMid = Math.atan2(midK.y - center.y, midK.x - center.x)
  const aEnd = Math.atan2(endK.y - center.y, endK.x - center.x)

  // Determine sweep direction by checking which way passes through mid.
  // Try CCW: if aStart → aEnd going CCW contains aMid, use CCW; else CW.
  function angleBetweenCCW(from: number, to: number, check: number): boolean {
    // Normalize all angles relative to `from`
    const to2 = ((to - from) + 2 * Math.PI) % (2 * Math.PI)
    const ch2 = ((check - from) + 2 * Math.PI) % (2 * Math.PI)
    return ch2 <= to2
  }

  const ccwContainsMid = angleBetweenCCW(aStart, aEnd, aMid)

  let sweep: number
  if (ccwContainsMid) {
    // CCW sweep
    sweep = ((aEnd - aStart) + 2 * Math.PI) % (2 * Math.PI)
    if (sweep === 0) sweep = 2 * Math.PI
  } else {
    // CW sweep (negative)
    sweep = -(((aStart - aEnd) + 2 * Math.PI) % (2 * Math.PI))
    if (sweep === 0) sweep = -2 * Math.PI
  }

  // Number of segments: at least ARC_POINTS_PER_90 per 90°
  const sweepDeg = Math.abs(sweep) * (180 / Math.PI)
  const nSeg = Math.max(4, Math.ceil(sweepDeg / 90) * ARC_POINTS_PER_90)

  const pts: { x: number; y: number }[] = []
  for (let i = 0; i <= nSeg; i++) {
    const angle = aStart + sweep * (i / nSeg)
    const kx = center.x + r * Math.cos(angle)
    const ky = center.y + r * Math.sin(angle)
    pts.push(kicadToWorld(kx, ky))
  }
  return pts
}

// ─── segment-strip geometry ────────────────────────────────────────────────────

/**
 * Build a flat (Z=0) strip geometry for a polyline with round caps.
 *
 * For each consecutive pair of points: produce a quad (two triangles).
 * At each end: produce a semicircular fan (CAP_SEGMENTS triangles).
 *
 * Returns a non-indexed BufferGeometry in the XY plane (Z=0).
 */
function buildStripGeometry(
  pts: { x: number; y: number }[],
  halfW: number
): THREE.BufferGeometry {
  if (pts.length < 2 || halfW <= 0) return new THREE.BufferGeometry()

  const verts: number[] = []
  const addTri = (
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number
  ) => {
    verts.push(ax, ay, 0, bx, by, 0, cx, cy, 0)
  }

  // For each segment, compute perpendicular offsets
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]
    const p1 = pts[i + 1]
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 1e-10) continue

    const nx = (-dy / len) * halfW
    const ny = (dx / len) * halfW

    // Quad: two triangles
    // v0 = p0 + n, v1 = p0 - n, v2 = p1 + n, v3 = p1 - n
    const x00 = p0.x + nx, y00 = p0.y + ny
    const x01 = p0.x - nx, y01 = p0.y - ny
    const x10 = p1.x + nx, y10 = p1.y + ny
    const x11 = p1.x - nx, y11 = p1.y - ny

    addTri(x00, y00, x01, y01, x10, y10)
    addTri(x01, y01, x11, y11, x10, y10)
  }

  // Round cap at start
  {
    const p0 = pts[0]
    const p1 = pts[1]
    const dx = p0.x - p1.x  // pointing away from segment
    const dy = p0.y - p1.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len > 1e-10) {
      const baseAngle = Math.atan2(dy, dx)
      for (let k = 0; k < CAP_SEGMENTS; k++) {
        const a0 = baseAngle + (k / CAP_SEGMENTS) * Math.PI
        const a1 = baseAngle + ((k + 1) / CAP_SEGMENTS) * Math.PI
        addTri(
          p0.x, p0.y,
          p0.x + Math.cos(a0) * halfW, p0.y + Math.sin(a0) * halfW,
          p0.x + Math.cos(a1) * halfW, p0.y + Math.sin(a1) * halfW
        )
      }
    }
  }

  // Round cap at end
  {
    const pN = pts[pts.length - 1]
    const pN1 = pts[pts.length - 2]
    const dx = pN.x - pN1.x  // pointing away from segment
    const dy = pN.y - pN1.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len > 1e-10) {
      const baseAngle = Math.atan2(dy, dx)
      for (let k = 0; k < CAP_SEGMENTS; k++) {
        const a0 = baseAngle + (k / CAP_SEGMENTS) * Math.PI
        const a1 = baseAngle + ((k + 1) / CAP_SEGMENTS) * Math.PI
        addTri(
          pN.x, pN.y,
          pN.x + Math.cos(a0) * halfW, pN.y + Math.sin(a0) * halfW,
          pN.x + Math.cos(a1) * halfW, pN.y + Math.sin(a1) * halfW
        )
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  return geo
}

// ─── pad geometry ──────────────────────────────────────────────────────────────

/** Convert a pad to a flat geometry in the XY plane, centered at world (cx, cy). */
function buildPadGeometry(
  pad: Pad,
  footprintAtX: number,
  footprintAtY: number,
  footprintRotDeg: number
): THREE.BufferGeometry | null {
  const { w, h } = pad.size
  if (w <= 0 || h <= 0) return null

  // Pad local position + global footprint position
  // Rotate pad.at by footprint rotation around footprint origin
  const fpRad = (footprintRotDeg * Math.PI) / 180
  const pxLocal = pad.at.x
  const pyLocal = pad.at.y

  // Apply footprint rotation to pad position
  const cosA = Math.cos(fpRad)
  const sinA = Math.sin(fpRad)
  const pxFp = cosA * pxLocal - sinA * pyLocal
  const pyFp = sinA * pxLocal + cosA * pyLocal

  const kx = footprintAtX + pxFp
  const ky = footprintAtY + pyFp
  const world = kicadToWorld(kx, ky)

  // Total rotation for the pad itself
  const padRotDeg = footprintRotDeg + pad.at.rotDeg
  const padRad = (padRotDeg * Math.PI) / 180

  const { shape } = pad

  let geo: THREE.BufferGeometry | null = null

  if (shape === 'circle') {
    const radius = Math.min(w, h) / 2
    // CircleGeometry: flat disk in XY plane
    const cGeo = new THREE.CircleGeometry(radius, 24)
    cGeo.translate(world.x, world.y, 0)
    geo = cGeo

  } else if (shape === 'rect') {
    geo = buildRectGeometry(w, h, world.x, world.y, padRad)

  } else if (shape === 'oval') {
    geo = buildOvalGeometry(w, h, world.x, world.y, padRad)

  } else if (shape === 'roundrect') {
    const rratio = DEFAULT_RRATIO
    const r = Math.min(w, h) * rratio
    geo = buildRoundRectGeometry(w, h, r, world.x, world.y, padRad)

  } else {
    // custom — bounding rect fallback
    console.warn(`copperGeometry: custom pad shape for pad ${pad.number}, using bounding rect`)
    geo = buildRectGeometry(w, h, world.x, world.y, padRad)
  }

  return geo
}

/** Build a flat rectangular geometry centered at (cx,cy) rotated by rotRad. */
function buildRectGeometry(
  w: number, h: number,
  cx: number, cy: number,
  rotRad: number
): THREE.BufferGeometry {
  const hw = w / 2, hh = h / 2
  const corners = [
    { x: -hw, y: -hh },
    { x:  hw, y: -hh },
    { x:  hw, y:  hh },
    { x: -hw, y:  hh },
  ].map(c => {
    const rx = Math.cos(rotRad) * c.x - Math.sin(rotRad) * c.y + cx
    const ry = Math.sin(rotRad) * c.x + Math.cos(rotRad) * c.y + cy
    return { x: rx, y: ry }
  })
  const verts = [
    corners[0].x, corners[0].y, 0,
    corners[1].x, corners[1].y, 0,
    corners[2].x, corners[2].y, 0,
    corners[0].x, corners[0].y, 0,
    corners[2].x, corners[2].y, 0,
    corners[3].x, corners[3].y, 0,
  ]
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  return geo
}

/** Build a flat oval geometry centered at (cx,cy) rotated by rotRad.
 *  An oval is a rectangle with two semicircles at either end. */
function buildOvalGeometry(
  w: number, h: number,
  cx: number, cy: number,
  rotRad: number
): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  if (w >= h) {
    // Long axis is X: two semicircles on left/right
    const r = h / 2
    const halfLen = (w - h) / 2
    shape.absarc(-halfLen, 0, r, Math.PI / 2, -Math.PI / 2, true)
    shape.absarc( halfLen, 0, r, -Math.PI / 2, Math.PI / 2, true)
    shape.closePath()
  } else {
    // Long axis is Y: two semicircles on top/bottom
    const r = w / 2
    const halfLen = (h - w) / 2
    shape.absarc(0, -halfLen, r, 0, Math.PI, true)
    shape.absarc(0,  halfLen, r, Math.PI, 2 * Math.PI, true)
    shape.closePath()
  }

  const verts = triangulateShape(shape)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))

  // Apply rotation + translation
  if (rotRad !== 0 || cx !== 0 || cy !== 0) {
    const matrix = new THREE.Matrix4()
    matrix.makeRotationZ(rotRad)
    matrix.setPosition(cx, cy, 0)
    geo.applyMatrix4(matrix)
  }
  return geo
}

/** Build a flat roundrect geometry centered at (cx,cy) rotated by rotRad. */
function buildRoundRectGeometry(
  w: number, h: number, r: number,
  cx: number, cy: number,
  rotRad: number
): THREE.BufferGeometry {
  const clampedR = Math.min(r, Math.min(w, h) / 2)
  const shape = new THREE.Shape()
  const hw = w / 2, hh = h / 2

  shape.moveTo(-hw + clampedR, -hh)
  shape.lineTo( hw - clampedR, -hh)
  shape.absarc( hw - clampedR, -hh + clampedR, clampedR, -Math.PI / 2, 0, false)
  shape.lineTo( hw,  hh - clampedR)
  shape.absarc( hw - clampedR,  hh - clampedR, clampedR, 0, Math.PI / 2, false)
  shape.lineTo(-hw + clampedR,  hh)
  shape.absarc(-hw + clampedR,  hh - clampedR, clampedR, Math.PI / 2, Math.PI, false)
  shape.lineTo(-hw, -hh + clampedR)
  shape.absarc(-hw + clampedR, -hh + clampedR, clampedR, Math.PI, -Math.PI / 2, false)
  shape.closePath()

  const verts = triangulateShape(shape)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))

  // Apply rotation + translation
  const matrix = new THREE.Matrix4()
  matrix.makeRotationZ(rotRad)
  matrix.setPosition(cx, cy, 0)
  geo.applyMatrix4(matrix)
  return geo
}

/**
 * Triangulate a THREE.Shape into a flat array of [x,y,0] triples
 * using THREE.ShapeUtils (earcut), same as ExtrudeGeometry uses.
 */
function triangulateShape(shape: THREE.Shape): number[] {
  const pts = shape.extractPoints(12)
  const faces = THREE.ShapeUtils.triangulateShape(pts.shape, pts.holes)
  const verts: number[] = []
  for (const [a, b, c] of faces) {
    verts.push(pts.shape[a].x, pts.shape[a].y, 0)
    verts.push(pts.shape[b].x, pts.shape[b].y, 0)
    verts.push(pts.shape[c].x, pts.shape[c].y, 0)
  }
  return verts
}

// ─── zone geometry ──────────────────────────────────────────────────────────────

/** Build a flat (Z=0) geometry from a zone polygon (outer + optional holes).
 *  polygon[0] = outer, polygon[1..] = holes. */
function buildZoneGeometry(polygon: { x: number; y: number }[][]): THREE.BufferGeometry | null {
  if (!polygon[0] || polygon[0].length < 3) return null

  // Build a THREE.Shape from the outer loop
  const outerWorld = polygon[0].map(p => kicadToWorld(p.x, p.y))
  const shape = new THREE.Shape(outerWorld.map(p => new THREE.Vector2(p.x, p.y)))

  // Add holes
  for (let h = 1; h < polygon.length; h++) {
    if (polygon[h].length < 3) continue
    const holeWorld = polygon[h].map(p => kicadToWorld(p.x, p.y))
    const holePath = new THREE.Path(holeWorld.map(p => new THREE.Vector2(p.x, p.y)))
    shape.holes.push(holePath)
  }

  const pts = shape.extractPoints(12)
  const faces = THREE.ShapeUtils.triangulateShape(pts.shape, pts.holes)
  const verts: number[] = []
  for (const [a, b, c] of faces) {
    verts.push(pts.shape[a].x, pts.shape[a].y, 0)
    verts.push(pts.shape[b].x, pts.shape[b].y, 0)
    verts.push(pts.shape[c].x, pts.shape[c].y, 0)
  }

  if (verts.length === 0) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  return geo
}

// ─── layer helpers ─────────────────────────────────────────────────────────────

/** Map a KiCad layer string to 'F' or 'B' (or null for non-copper). */
function layerSide(layer: string): 'F' | 'B' | null {
  if (layer === 'F.Cu' || layer === 'F_Cu') return 'F'
  if (layer === 'B.Cu' || layer === 'B_Cu') return 'B'
  return null
}

// ─── main buildCopper ──────────────────────────────────────────────────────────

export type CopperEntry = { F?: THREE.BufferGeometry; B?: THREE.BufferGeometry }

/**
 * Build copper geometry for a board.
 *
 * Returns Map<netId, { F?, B? }> where F and B are merged BufferGeometries
 * for front/back copper layers respectively.
 *
 * One geometry per (net, layer) so it can be tinted per net for voltage overlay.
 */
export function buildCopper(board: BoardModel): Map<number, CopperEntry> {
  // Accumulate geometries: netId → layer → BufferGeometry[]
  const accum = new Map<number, { F: THREE.BufferGeometry[]; B: THREE.BufferGeometry[] }>()

  function getAccum(netId: number) {
    if (!accum.has(netId)) accum.set(netId, { F: [], B: [] })
    return accum.get(netId)!
  }

  function addGeo(netId: number, side: 'F' | 'B', geo: THREE.BufferGeometry) {
    getAccum(netId)[side].push(geo)
  }

  // ── Tracks ──
  for (const track of board.tracks) {
    const side = layerSide(track.layer)
    if (!side) continue
    const halfW = track.widthMm / 2
    if (halfW <= 0) continue

    let pts: { x: number; y: number }[]

    if (track.kind === 'segment') {
      // Two-point segment: convert to world coords
      pts = [
        kicadToWorld(track.start.x, track.start.y),
        kicadToWorld(track.end.x, track.end.y),
      ]
    } else {
      // arc: tessellate from three-point form
      pts = tessellateArc(track.start, track.mid, track.end)
    }

    const geo = buildStripGeometry(pts, halfW)
    if (geo.getAttribute('position')?.count > 0) {
      addGeo(track.netId, side, geo)
    }
  }

  // ── Pads ──
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (pad.netId === undefined || pad.netId === 0) continue

      // Determine which copper layer this pad is on
      // SMD pads: use pad.layers which includes "F.Cu" or "B.Cu"
      // Thru-hole pads: appear on both sides
      const padSides = new Set<'F' | 'B'>()
      for (const l of pad.layers) {
        const s = layerSide(l)
        if (s) padSides.add(s)
      }

      if (padSides.size === 0) continue

      const geo = buildPadGeometry(pad, fp.at.x, fp.at.y, fp.at.rotDeg)
      if (!geo) continue

      for (const side of padSides) {
        addGeo(pad.netId, side, geo.clone())
      }
    }
  }

  // ── Zones ──
  for (const zone of board.zones) {
    if (zone.netId === undefined || zone.netId === 0) continue
    const side = layerSide(zone.layer)
    if (!side) continue

    const geo = buildZoneGeometry(zone.polygon)
    if (geo) addGeo(zone.netId, side, geo)
  }

  // ── Merge per (net, layer) ──
  const result = new Map<number, CopperEntry>()

  for (const [netId, { F, B }] of accum) {
    const entry: CopperEntry = {}
    if (F.length > 0) {
      entry.F = F.length === 1 ? F[0] : mergeGeometries(F)
    }
    if (B.length > 0) {
      entry.B = B.length === 1 ? B[0] : mergeGeometries(B)
    }
    if (entry.F || entry.B) {
      result.set(netId, entry)
    }
  }

  return result
}

// ─── via instancing ────────────────────────────────────────────────────────────

export interface ViaInstances {
  /** The InstancedMesh (geometry = CylinderGeometry, material = copper-like). */
  mesh: THREE.InstancedMesh
  /** Per-instance netId array (index matches instanceId). */
  netIds: number[]
  /** Total number of instances. */
  count: number
}

/**
 * Build one InstancedMesh of cylinder vias from the board's via list.
 *
 * Each via is a cylinder at its board position, sized by via.sizeMm.
 * The caller can later tint via materials by iterating setColorAt(i, color)
 * per-net using the netIds array.
 */
export function buildViaInstances(board: BoardModel): ViaInstances {
  const vias: Via[] = board.vias

  // Use a median via size for the shared cylinder geometry;
  // if sizes vary we scale each instance via the matrix.
  const defaultRadius = vias.length > 0 ? vias[0].sizeMm / 2 : 0.4
  const defaultHeight = board.boardThicknessMm > 0 ? board.boardThicknessMm : 1.6

  // CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)
  const cylinderGeo = new THREE.CylinderGeometry(defaultRadius, defaultRadius, defaultHeight, 16)

  // The cylinder's axis is Y by default; we want Z-up so rotate it
  cylinderGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2))

  const material = makeCopperMaterial()
  const mesh = new THREE.InstancedMesh(cylinderGeo, material, Math.max(vias.length, 1))
  mesh.count = vias.length

  const netIds: number[] = []
  const dummy = new THREE.Object3D()

  for (let i = 0; i < vias.length; i++) {
    const via = vias[i]
    const world = kicadToWorld(via.at.x, via.at.y)

    // Scale to actual via size relative to default geometry
    const scale = via.sizeMm / (defaultRadius * 2)

    dummy.position.set(world.x, world.y, defaultHeight / 2)
    dummy.scale.set(scale, scale, 1)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)

    netIds.push(via.netId ?? 0)
  }

  if (vias.length > 0) {
    mesh.instanceMatrix.needsUpdate = true
  }

  return { mesh, netIds, count: vias.length }
}
