/**
 * viewport/copperIndex.ts
 *
 * Spatial index for copper picking (#58).
 *
 * three.js Mesh.raycast has no acceleration structure: it walks every triangle
 * of any mesh whose bounds the ray crosses, and a power net's bounds cover the
 * whole board. Copper is planar, so a pick does not need a 3D raycast at all:
 * intersect the ray with the plane each copper layer lies in, then ask a 2D
 * uniform grid which triangle contains that point.
 *
 * Triangles are bucketed into grid cells by their bounding box (CSR layout in
 * typed arrays). A query reads one cell and runs a point-in-triangle test on
 * its few triangles. When several triangles of different nets contain the
 * point (a pour under a track), the smallest wins, so a track or pad is
 * pickable on top of a zone.
 *
 * Copper is treated as double sided: the triangle winding is ignored, unlike
 * Mesh.raycast on a FrontSide material.
 *
 * Sources are registered with a function that maps a vertex index to its net.
 * The index is built lazily on the first query, from the sources' world
 * matrices at that moment, and rebuilt only after a new source is added.
 *
 * Pure THREE math, no WebGL context needed.
 */

import * as THREE from 'three'

export interface CopperRayHit {
  /** Distance along the ray (ray directions from Raycaster are unit length). */
  distance: number
  point: THREE.Vector3
  netId: number
}

interface CopperSource {
  mesh: THREE.Mesh
  /** Net of the triangle whose first vertex index is `vertexIndex`. */
  netAt: (vertexIndex: number) => number
}

/** Triangles per grid cell the grid is sized for. */
const TARGET_TRIS_PER_CELL = 3
/** Hard cap on grid cells so a pathological layer cannot exhaust memory. */
const MAX_CELLS = 1 << 21

class PlaneIndex {
  readonly z: number
  private readonly tris: Float32Array
  private readonly nets: Int32Array
  private readonly count: number
  private minX = Infinity
  private minY = Infinity
  private gx = 1
  private gy = 1
  private cell = 1
  private cellStart: Int32Array = new Int32Array(2)
  private cellItems: Int32Array = new Int32Array(0)

  constructor(z: number, tris: Float32Array, nets: Int32Array, count: number) {
    this.z = z
    this.tris = tris
    this.nets = nets
    this.count = count
    this.build()
  }

  private build(): void {
    const { tris, count } = this
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let t = 0; t < count; t++) {
      const o = t * 6
      for (let k = 0; k < 6; k += 2) {
        const x = tris[o + k], y = tris[o + k + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (count === 0) return
    const w = Math.max(maxX - minX, 1e-6)
    const h = Math.max(maxY - minY, 1e-6)
    const targetCells = Math.max(1, Math.floor(count / TARGET_TRIS_PER_CELL))
    let cell = Math.max(Math.sqrt((w * h) / targetCells), Math.max(w, h) / 4096)
    let gx = Math.floor(w / cell) + 1
    let gy = Math.floor(h / cell) + 1
    while (gx * gy > MAX_CELLS) {
      cell *= 1.5
      gx = Math.floor(w / cell) + 1
      gy = Math.floor(h / cell) + 1
    }
    this.minX = minX
    this.minY = minY
    this.gx = gx
    this.gy = gy
    this.cell = cell

    const cellStart = new Int32Array(gx * gy + 1)

    // Pass 1: count entries per cell.
    for (let t = 0; t < count; t++) {
      const [x0, x1, y0, y1] = this.cellRange(t)
      for (let cy = y0; cy <= y1; cy++) {
        const row = cy * gx
        for (let cx = x0; cx <= x1; cx++) cellStart[row + cx + 1]++
      }
    }
    for (let i = 0; i < gx * gy; i++) cellStart[i + 1] += cellStart[i]

    // Pass 2: fill.
    const items = new Int32Array(cellStart[gx * gy])
    const fill = cellStart.slice(0, gx * gy)
    for (let t = 0; t < count; t++) {
      const [x0, x1, y0, y1] = this.cellRange(t)
      for (let cy = y0; cy <= y1; cy++) {
        const row = cy * gx
        for (let cx = x0; cx <= x1; cx++) items[fill[row + cx]++] = t
      }
    }
    this.cellStart = cellStart
    this.cellItems = items
  }

  /** Inclusive cell range [x0, x1, y0, y1] covered by triangle t's bounding box. */
  private cellRange(t: number): [number, number, number, number] {
    const o = t * 6
    const tr = this.tris
    const xa = tr[o], xb = tr[o + 2], xc = tr[o + 4]
    const ya = tr[o + 1], yb = tr[o + 3], yc = tr[o + 5]
    const inv = 1 / this.cell
    const clampX = (v: number) => Math.min(this.gx - 1, Math.max(0, Math.floor((v - this.minX) * inv)))
    const clampY = (v: number) => Math.min(this.gy - 1, Math.max(0, Math.floor((v - this.minY) * inv)))
    return [
      clampX(Math.min(xa, xb, xc)), clampX(Math.max(xa, xb, xc)),
      clampY(Math.min(ya, yb, yc)), clampY(Math.max(ya, yb, yc)),
    ]
  }

  /** Net of the smallest triangle containing (x, y), or null. */
  query(x: number, y: number): number | null {
    if (this.count === 0) return null
    const fx = (x - this.minX) / this.cell
    const fy = (y - this.minY) / this.cell
    if (fx < 0 || fy < 0) return null
    const cx = Math.floor(fx), cy = Math.floor(fy)
    if (cx >= this.gx || cy >= this.gy) return null
    const c = cy * this.gx + cx
    const tr = this.tris
    let best = -1
    let bestArea = Infinity
    for (let i = this.cellStart[c]; i < this.cellStart[c + 1]; i++) {
      const t = this.cellItems[i]
      const o = t * 6
      const ax = tr[o], ay = tr[o + 1]
      const bx = tr[o + 2], by = tr[o + 3]
      const cx2 = tr[o + 4], cy2 = tr[o + 5]
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
      const d2 = (x - cx2) * (by - cy2) - (bx - cx2) * (y - cy2)
      const d3 = (x - ax) * (cy2 - ay) - (cx2 - ax) * (y - ay)
      const neg = d1 < 0 || d2 < 0 || d3 < 0
      const pos = d1 > 0 || d2 > 0 || d3 > 0
      if (neg && pos) continue
      const area = Math.abs((bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay))
      if (area < bestArea) {
        bestArea = area
        best = t
      }
    }
    return best < 0 ? null : this.nets[best]
  }
}

export class CopperHitIndex {
  private readonly sources: CopperSource[] = []
  private planes: PlaneIndex[] | null = null

  /** Register a planar mesh whose triangles belong to nets given by `netAt`. */
  add(mesh: THREE.Mesh, netAt: (vertexIndex: number) => number): void {
    this.sources.push({ mesh, netAt })
    this.planes = null
  }

  clear(): void {
    this.sources.length = 0
    this.planes = null
  }

  get sourceCount(): number {
    return this.sources.length
  }

  /** Force the lazy build now (so the first hover does not pay for it). */
  warm(): void {
    this.ensureBuilt()
  }

  private ensureBuilt(): PlaneIndex[] {
    if (this.planes) return this.planes

    // Pass 1: find each source's plane (keyed by world z in microns) and count
    // triangles per plane, so pass 2 can fill exactly-sized typed arrays.
    interface Prepared { source: CopperSource; key: number; triCount: number }
    const prepared: Prepared[] = []
    const planeTris = new Map<number, { z: number; count: number; filled: number }>()
    const v = new THREE.Vector3()
    for (const source of this.sources) {
      const { mesh } = source
      mesh.updateWorldMatrix(true, false)
      const geo = mesh.geometry
      const pos = geo.getAttribute('position')
      if (!pos) continue
      const index = geo.getIndex()
      const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3)
      if (triCount === 0) continue
      v.fromBufferAttribute(pos, index ? index.getX(0) : 0).applyMatrix4(mesh.matrixWorld)
      const key = Math.round(v.z * 1000)
      let plane = planeTris.get(key)
      if (!plane) {
        plane = { z: v.z, count: 0, filled: 0 }
        planeTris.set(key, plane)
      }
      plane.count += triCount
      prepared.push({ source, key, triCount })
    }

    const buffers = new Map<number, { tris: Float32Array; nets: Int32Array }>()
    for (const [key, p] of planeTris) {
      buffers.set(key, { tris: new Float32Array(p.count * 6), nets: new Int32Array(p.count) })
    }

    // Pass 2: transform each triangle to world XY and record its net.
    for (const { source, key, triCount } of prepared) {
      const { mesh, netAt } = source
      const geo = mesh.geometry
      const pos = geo.getAttribute('position')
      const index = geo.getIndex()
      const e = mesh.matrixWorld.elements
      const plane = planeTris.get(key)!
      const buf = buffers.get(key)!
      const px = (i: number) => e[0] * pos.getX(i) + e[4] * pos.getY(i) + e[8] * pos.getZ(i) + e[12]
      const py = (i: number) => e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13]
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
        const o = plane.filled * 6
        buf.tris[o] = px(i0)
        buf.tris[o + 1] = py(i0)
        buf.tris[o + 2] = px(i1)
        buf.tris[o + 3] = py(i1)
        buf.tris[o + 4] = px(i2)
        buf.tris[o + 5] = py(i2)
        buf.nets[plane.filled] = netAt(i0)
        plane.filled++
      }
    }

    this.planes = [...planeTris].map(([key, p]) => {
      const buf = buffers.get(key)!
      return new PlaneIndex(p.z, buf.tris, buf.nets, p.count)
    })
    return this.planes
  }

  /**
   * Intersect a ray with every copper plane and return a hit for each plane
   * whose point lies on copper, nearest first.
   */
  query(ray: THREE.Ray): CopperRayHit[] {
    const planes = this.ensureBuilt()
    const hits: CopperRayHit[] = []
    const { origin, direction } = ray
    if (Math.abs(direction.z) < 1e-12) return hits
    for (const plane of planes) {
      const t = (plane.z - origin.z) / direction.z
      if (t < 0) continue
      const x = origin.x + direction.x * t
      const y = origin.y + direction.y * t
      const netId = plane.query(x, y)
      if (netId === null) continue
      hits.push({ distance: t, point: new THREE.Vector3(x, y, plane.z), netId })
    }
    hits.sort((a, b) => a.distance - b.distance)
    return hits
  }
}
