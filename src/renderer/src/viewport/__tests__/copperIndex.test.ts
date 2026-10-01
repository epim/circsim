/**
 * copperIndex.test.ts
 *
 * #58: planar copper picking through a 2D triangle grid instead of
 * Mesh.raycast over every triangle.
 */

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { CopperHitIndex } from '../copperIndex'

/** A flat quad mesh centered at (cx, cy, z), w by h, in world space. */
function quad(cx: number, cy: number, w: number, h: number, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial())
  mesh.position.set(cx, cy, z)
  mesh.updateMatrixWorld(true)
  return mesh
}

/** A ray straight down onto (x, y) from z = 100. */
function down(x: number, y: number): THREE.Ray {
  return new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))
}

describe('CopperHitIndex', () => {
  it('returns the net of the mesh under the ray and misses elsewhere', () => {
    const idx = new CopperHitIndex()
    idx.add(quad(0, 0, 4, 4), () => 7)
    idx.add(quad(20, 0, 4, 4), () => 9)

    expect(idx.query(down(1, 1)).map(h => h.netId)).toEqual([7])
    expect(idx.query(down(20, -1)).map(h => h.netId)).toEqual([9])
    expect(idx.query(down(10, 0))).toEqual([])
    expect(idx.query(down(-30, 40))).toEqual([])
  })

  it('reports the hit point on the plane and the distance along the ray', () => {
    const idx = new CopperHitIndex()
    idx.add(quad(0, 0, 4, 4, 1.6), () => 1)
    const [hit] = idx.query(down(0.5, -0.5))
    expect(hit.point.x).toBeCloseTo(0.5)
    expect(hit.point.y).toBeCloseTo(-0.5)
    expect(hit.point.z).toBeCloseTo(1.6)
    expect(hit.distance).toBeCloseTo(100 - 1.6)
  })

  it('returns one hit per plane, nearest first', () => {
    const idx = new CopperHitIndex()
    idx.add(quad(0, 0, 10, 10, 0), () => 2)     // back copper
    idx.add(quad(0, 0, 10, 10, 1.6), () => 1)   // front copper
    const hits = idx.query(down(0, 0))
    expect(hits.map(h => h.netId)).toEqual([1, 2])
    expect(hits[0].distance).toBeLessThan(hits[1].distance)
  })

  it('prefers the smaller feature where a pour and a track overlap on one plane', () => {
    const idx = new CopperHitIndex()
    idx.add(quad(0, 0, 40, 40), () => 100)   // big pour
    idx.add(quad(0, 0, 1, 1), () => 5)       // pad on top of it
    expect(idx.query(down(0, 0))[0].netId).toBe(5)
    expect(idx.query(down(10, 10))[0].netId).toBe(100)
  })

  it('honors the mesh world transform', () => {
    const group = new THREE.Group()
    group.position.set(-15, 10, 1.6)
    const mesh = quad(0, 0, 2, 2)
    mesh.position.set(5, -3, 0)
    group.add(mesh)
    group.updateMatrixWorld(true)

    const idx = new CopperHitIndex()
    idx.add(mesh, () => 3)
    expect(idx.query(down(-10, 7))[0].netId).toBe(3)   // (5-15, -3+10)
    expect(idx.query(down(5, -3))).toEqual([])
  })

  it('ignores triangle winding (copper is double sided)', () => {
    const geo = new THREE.BufferGeometry()
    // Clockwise seen from +z
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 2, 0, 2, 0, 0], 3))
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
    mesh.updateMatrixWorld(true)
    const idx = new CopperHitIndex()
    idx.add(mesh, () => 4)
    expect(idx.query(down(0.5, 0.5))[0].netId).toBe(4)
  })

  it('skips a ray parallel to the plane and a ray pointing away from it', () => {
    const idx = new CopperHitIndex()
    idx.add(quad(0, 0, 4, 4), () => 1)
    expect(idx.query(new THREE.Ray(new THREE.Vector3(-10, 0, 0), new THREE.Vector3(1, 0, 0)))).toEqual([])
    expect(idx.query(new THREE.Ray(new THREE.Vector3(0, 0, 100), new THREE.Vector3(0, 0, 1)))).toEqual([])
  })

  it('maps vertices to nets for a merged multi-net mesh', () => {
    // Two disjoint triangles in one non-indexed geometry, nets 11 and 12.
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 2, 0, 0, 0, 2, 0,
      10, 0, 0, 12, 0, 0, 10, 2, 0,
    ], 3))
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
    mesh.updateMatrixWorld(true)
    const idx = new CopperHitIndex()
    idx.add(mesh, v => (v < 3 ? 11 : 12))
    expect(idx.query(down(0.4, 0.4))[0].netId).toBe(11)
    expect(idx.query(down(10.4, 0.4))[0].netId).toBe(12)
  })

  it('works on indexed geometry', () => {
    const mesh = quad(0, 0, 4, 4)   // PlaneGeometry is indexed
    expect(mesh.geometry.getIndex()).not.toBeNull()
    const idx = new CopperHitIndex()
    idx.add(mesh, () => 8)
    expect(idx.query(down(1.9, 1.9))[0].netId).toBe(8)
    expect(idx.query(down(2.1, 0))).toEqual([])
  })

  it('rebuilds after a new source is added and empties on clear', () => {
    const idx = new CopperHitIndex()
    idx.add(quad(0, 0, 2, 2), () => 1)
    expect(idx.query(down(10, 0))).toEqual([])
    idx.add(quad(10, 0, 2, 2), () => 2)
    expect(idx.query(down(10, 0))[0].netId).toBe(2)
    idx.clear()
    expect(idx.sourceCount).toBe(0)
    expect(idx.query(down(10, 0))).toEqual([])
  })

  it('agrees with a brute-force point-in-triangle scan on random triangles', () => {
    let s = 7
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
    const verts: number[] = []
    const tris: number[][] = []
    for (let i = 0; i < 400; i++) {
      const x = rnd() * 100, y = rnd() * 100
      const t = [x, y, x + rnd() * 4, y + rnd() * 4, x + rnd() * 4, y - rnd() * 4]
      tris.push(t)
      verts.push(t[0], t[1], 0, t[2], t[3], 0, t[4], t[5], 0)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
    mesh.updateMatrixWorld(true)
    const idx = new CopperHitIndex()
    idx.add(mesh, v => Math.floor(v / 3))

    const inside = (px: number, py: number, t: number[]) => {
      const d1 = (px - t[2]) * (t[1] - t[3]) - (t[0] - t[2]) * (py - t[3])
      const d2 = (px - t[4]) * (t[3] - t[5]) - (t[2] - t[4]) * (py - t[5])
      const d3 = (px - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (py - t[1])
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
    }
    for (let k = 0; k < 500; k++) {
      const px = rnd() * 104 - 2, py = rnd() * 104 - 2
      const expected = new Set<number>()
      tris.forEach((t, i) => { if (inside(px, py, t)) expected.add(i) })
      const hit = idx.query(down(px, py))
      if (expected.size === 0) expect(hit).toEqual([])
      else expect(expected.has(hit[0].netId)).toBe(true)
    }
  })
})
