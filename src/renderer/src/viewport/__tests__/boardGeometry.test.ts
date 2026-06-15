/**
 * boardGeometry.test.ts
 *
 * Task 16 — geometry math tests.
 * Tests kicadToWorld coordinate conversion and buildSubstrate geometry.
 *
 * Three.js core geometry (Shape/ExtrudeGeometry/BufferGeometry) runs headless
 * in Node under Vitest — no WebGL context required.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { kicadToWorld, buildSubstrate } from '../boardGeometry'
import { parseBoard } from '../../../../core/kicad/board'
import type { OutlineGeometry, Vec2 } from '../../../../core/kicad/types'

// ─── kicadToWorld tests ───────────────────────────────────────────────────────

describe('kicadToWorld', () => {
  it('maps (0, 0) to world (0, 0)', () => {
    const w = kicadToWorld(0, 0)
    expect(w.x).toBeCloseTo(0)
    expect(w.y).toBeCloseTo(0)
  })

  it('flips Y axis: KiCad Y grows downward, world Y grows upward', () => {
    // In KiCad Y=10 is "below" origin; in world (Z-up right-handed) that becomes Y=-10
    const w = kicadToWorld(0, 10)
    expect(w.x).toBeCloseTo(0)
    expect(w.y).toBeCloseTo(-10)
  })

  it('preserves X axis', () => {
    const w = kicadToWorld(5, 3)
    expect(w.x).toBeCloseTo(5)
    expect(w.y).toBeCloseTo(-3)
  })

  it('handles negative KiCad coords', () => {
    const w = kicadToWorld(-2, -4)
    expect(w.x).toBeCloseTo(-2)
    expect(w.y).toBeCloseTo(4)
  })
})

// ─── fixture-rc substrate tests ───────────────────────────────────────────────

describe('buildSubstrate — fixture-rc', () => {
  const fixturePath = path.resolve(__dirname, '../../../../../fixtures/fixture-rc.kicad_pcb')
  const text = fs.readFileSync(fixturePath, 'utf-8')
  const board = parseBoard(text)

  it('produces a BufferGeometry', () => {
    const geo = buildSubstrate(board.outline, board.boardThicknessMm)
    expect(geo).toBeDefined()
    expect(geo.isBufferGeometry).toBe(true)
  })

  it('bounding box is 30×20×1.6 mm', () => {
    const geo = buildSubstrate(board.outline, board.boardThicknessMm)
    geo.computeBoundingBox()
    const bb = geo.boundingBox!
    const sizeX = bb.max.x - bb.min.x
    const sizeY = bb.max.y - bb.min.y
    const sizeZ = bb.max.z - bb.min.z
    expect(sizeX).toBeCloseTo(30, 1)
    expect(sizeY).toBeCloseTo(20, 1)
    expect(sizeZ).toBeCloseTo(1.6, 2)
  })

  it('has a non-zero position array (geometry was populated)', () => {
    const geo = buildSubstrate(board.outline, board.boardThicknessMm)
    const pos = geo.getAttribute('position')
    expect(pos).toBeDefined()
    expect(pos.count).toBeGreaterThan(0)
  })
})

// ─── fixture-arcs substrate tests (hole vertices) ────────────────────────────

describe('buildSubstrate — fixture-arcs (hole)', () => {
  const fixturePath = path.resolve(__dirname, '../../../../../fixtures/fixture-arcs.kicad_pcb')
  const text = fs.readFileSync(fixturePath, 'utf-8')
  const board = parseBoard(text)

  it('outline has at least one hole (the gr_circle cutout)', () => {
    // stitchOutline classifies the inner circle as a hole
    expect(board.outline.holes.length).toBeGreaterThan(0)
  })

  it('produces geometry with vertices', () => {
    const geo = buildSubstrate(board.outline, board.boardThicknessMm)
    geo.computeBoundingBox()
    const pos = geo.getAttribute('position')
    expect(pos.count).toBeGreaterThan(0)
  })

  it('has hole vertices present in the position buffer', () => {
    // The circle cutout center is at (15, 10) with radius 2 (radiusPoint at 15,8).
    // After kicadToWorld, the hole center in world space is (15, -10).
    // The geometry should NOT have all vertices at x=15, y=-10 (that would mean
    // the hole collapsed) — instead there should be vertices spread around it.
    const geo = buildSubstrate(board.outline, board.boardThicknessMm)
    const pos = geo.getAttribute('position')
    // Look for vertices near the expected circle boundary (radius 2, center 15,-10)
    // At least one vertex should be within ~3mm of the hole center
    let foundNearHole = false
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      // World coords after kicadToWorld: hole center at (15, -10)
      const dx = x - 15
      const dy = y - (-10)
      const distFromHoleCenter = Math.sqrt(dx * dx + dy * dy)
      if (distFromHoleCenter < 3.5) {
        foundNearHole = true
        break
      }
    }
    expect(foundNearHole).toBe(true)
  })
})

// ─── two-outer-loop synthetic input (merged geometry) ─────────────────────────

describe('buildSubstrate — two outer loops (panelized)', () => {
  // A synthetic OutlineGeometry with two separate rectangular outer loops
  // Loop 1: 10×10 square at origin
  // Loop 2: 10×10 square at x=20 offset (non-overlapping)
  const loop1: Vec2[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]
  const loop2: Vec2[] = [
    { x: 20, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 10 },
    { x: 20, y: 10 },
  ]
  const syntheticOutline: OutlineGeometry = {
    outer: [loop1, loop2],
    holes: [],
    warnings: [],
  }

  it('produces a merged BufferGeometry (not null)', () => {
    const geo = buildSubstrate(syntheticOutline, 1.6)
    expect(geo).toBeDefined()
    expect(geo.isBufferGeometry).toBe(true)
  })

  it('merged geometry spans both loops: bounding box width ≈ 30', () => {
    const geo = buildSubstrate(syntheticOutline, 1.6)
    geo.computeBoundingBox()
    const bb = geo.boundingBox!
    const sizeX = bb.max.x - bb.min.x
    // Two 10-wide loops with a 10-unit gap: total span from x=0 to x=30 → width = 30
    expect(sizeX).toBeCloseTo(30, 1)
  })

  it('merged geometry has vertices from both loops', () => {
    const geo = buildSubstrate(syntheticOutline, 1.6)
    const pos = geo.getAttribute('position')
    expect(pos.count).toBeGreaterThan(0)
    // Find the X range to confirm both loops are present
    let minX = Infinity, maxX = -Infinity
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
    expect(minX).toBeCloseTo(0, 1)
    expect(maxX).toBeCloseTo(30, 1)
  })
})
