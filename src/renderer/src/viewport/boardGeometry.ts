/**
 * viewport/boardGeometry.ts
 *
 * Task 16 — board substrate geometry builder.
 *
 * Exports:
 *   kicadToWorld(x, y) — ONE canonical conversion from KiCad coords to world.
 *     KiCad: Y grows downward (screen-space).
 *     World:  Z-up right-handed; Y grows upward.
 *     Result: x stays the same, y = -y (flip Y), Z is handled by extrusion.
 *
 *   buildSubstrate(outline, thicknessMm) — ExtrudeGeometry per outer loop,
 *     holes assigned by containment, all merged into one BufferGeometry.
 *
 * No WebGL context is required — THREE core geometry runs headless.
 *
 * Spec §10.1 (substrate row), §10.3
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { OutlineGeometry, Vec2 } from '../../../core/kicad/types'

// ─── coordinate conversion ────────────────────────────────────────────────────

/**
 * Convert a KiCad board coordinate to world space.
 *
 * KiCad Y grows downward; the viewport is Z-up right-handed where Y grows
 * upward. This is the ONE canonical conversion used by ALL geometry builders.
 *
 * @param x - KiCad X coordinate in mm
 * @param y - KiCad Y coordinate in mm (positive = down in KiCad)
 * @returns World-space { x, y } where Y is flipped
 */
export function kicadToWorld(x: number, y: number): { x: number; y: number } {
  return { x, y: -y }
}

// ─── point-in-polygon helper (same algorithm as outline.ts) ──────────────────

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

// ─── substrate builder ────────────────────────────────────────────────────────

/**
 * Build the FR4 board substrate geometry.
 *
 * For each outer outline loop:
 *   1. Create a THREE.Shape from the outer loop vertices (after kicadToWorld).
 *   2. Find any holes whose representative point lies inside this outer loop.
 *   3. Add those holes as THREE.Path holes on the Shape.
 *   4. Create an ExtrudeGeometry with depth = thicknessMm.
 *
 * All per-outer-loop geometries are merged into a single BufferGeometry.
 *
 * @param outline     - OutlineGeometry from stitchOutline()
 * @param thicknessMm - Board thickness (e.g. 1.6 mm)
 * @returns Merged THREE.BufferGeometry
 */
export function buildSubstrate(
  outline: OutlineGeometry,
  thicknessMm: number
): THREE.BufferGeometry {
  if (outline.outer.length === 0) {
    // Return empty geometry for boards with no outline
    return new THREE.BufferGeometry()
  }

  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: thicknessMm,
    bevelEnabled: false,
  }

  const perLoopGeometries: THREE.BufferGeometry[] = []

  for (const outerLoop of outline.outer) {
    if (outerLoop.length < 3) continue

    // Build THREE.Shape from outer loop
    // kicadToWorld: x stays, y = -y
    const shape = new THREE.Shape()
    const firstW = kicadToWorld(outerLoop[0].x, outerLoop[0].y)
    shape.moveTo(firstW.x, firstW.y)
    for (let i = 1; i < outerLoop.length; i++) {
      const w = kicadToWorld(outerLoop[i].x, outerLoop[i].y)
      shape.lineTo(w.x, w.y)
    }
    shape.closePath()

    // Assign holes to this outer loop by containment test
    // (use original KiCad coords for the containment check since stitchOutline
    // works in KiCad space)
    for (const holeLoop of outline.holes) {
      if (holeLoop.length < 3) continue

      // Test the first point of the hole against the outer loop
      if (pointInPolygon(holeLoop[0], outerLoop)) {
        // This hole belongs to this outer loop
        const holePath = new THREE.Path()
        const firstHW = kicadToWorld(holeLoop[0].x, holeLoop[0].y)
        holePath.moveTo(firstHW.x, firstHW.y)
        for (let i = 1; i < holeLoop.length; i++) {
          const hw = kicadToWorld(holeLoop[i].x, holeLoop[i].y)
          holePath.lineTo(hw.x, hw.y)
        }
        holePath.closePath()
        shape.holes.push(holePath)
      }
    }

    const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings)
    perLoopGeometries.push(geo)
  }

  if (perLoopGeometries.length === 0) {
    return new THREE.BufferGeometry()
  }

  if (perLoopGeometries.length === 1) {
    return perLoopGeometries[0]
  }

  // Merge all per-loop geometries into one
  return mergeGeometries(perLoopGeometries)
}
