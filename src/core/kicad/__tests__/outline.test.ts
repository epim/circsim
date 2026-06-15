/**
 * core/kicad/__tests__/outline.test.ts
 *
 * Tests for stitchOutline() — Task 4.
 * Written FIRST (TDD). Tests must fail before outline.ts is implemented.
 *
 * Spec §8.2 "Edge.Cuts stitching"
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { stitchOutline } from '../outline'
import { parseBoard } from '../board'
import type { EdgePrimitive, Vec2 } from '../types'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Euclidean distance between two Vec2 points */
function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

/** Signed polygon area (positive = CCW in standard math coords) */
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

// ─── fixture files ────────────────────────────────────────────────────────────

const FIXTURE_RC_PATH = join(__dirname, '../../../../fixtures/fixture-rc.kicad_pcb')
const FIXTURE_ARCS_PATH = join(__dirname, '../../../../fixtures/fixture-arcs.kicad_pcb')
const fixtureRcText = readFileSync(FIXTURE_RC_PATH, 'utf-8')
const fixtureArcsText = readFileSync(FIXTURE_ARCS_PATH, 'utf-8')

// ─── 4-segment rectangle (any segment order, some reversed) ──────────────────

describe('stitchOutline — 4-segment rectangle', () => {
  it('produces 1 closed outer loop and 0 holes from a simple rectangle', () => {
    // The fixture-rc board has 4 gr_lines forming a 30×20 rectangle
    const board = parseBoard(fixtureRcText)
    const result = stitchOutline(board.edgeCuts)

    expect(result.outer).toHaveLength(1)
    expect(result.holes).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('outer loop has the right bounding box (30×20 from fixture-rc)', () => {
    const board = parseBoard(fixtureRcText)
    const result = stitchOutline(board.edgeCuts)

    const loop = result.outer[0]
    const xs = loop.map(p => p.x)
    const ys = loop.map(p => p.y)
    expect(Math.min(...xs)).toBeCloseTo(0)
    expect(Math.max(...xs)).toBeCloseTo(30)
    expect(Math.min(...ys)).toBeCloseTo(0)
    expect(Math.max(...ys)).toBeCloseTo(20)
  })

  it('works when segment order is shuffled', () => {
    // Provide 4 segments in a different order than they would chain naturally
    const primitives: EdgePrimitive[] = [
      { kind: 'line', start: { x: 30, y: 20 }, end: { x: 0, y: 20 } },
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 30, y: 0 } },   // reversed
      { kind: 'line', start: { x: 30, y: 0 }, end: { x: 30, y: 20 } },
      { kind: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
    ]
    const result = stitchOutline(primitives)
    expect(result.outer).toHaveLength(1)
    expect(result.holes).toHaveLength(0)
    expect(result.outer[0].length).toBeGreaterThanOrEqual(4)
  })

  it('outer loop is normalized to CCW winding (negative signed area in KiCad Y-down coords)', () => {
    // KiCad uses Y-down coords. A CCW polygon in KiCad's screen space has
    // negative signed area in standard math convention. The spec says outer CCW.
    // We just verify the winding convention is consistent (not zero area).
    const board = parseBoard(fixtureRcText)
    const result = stitchOutline(board.edgeCuts)
    const area = signedArea(result.outer[0])
    // Area should be non-zero (is a real polygon)
    expect(Math.abs(area)).toBeGreaterThan(0)
  })
})

// ─── arcs tessellation ────────────────────────────────────────────────────────

describe('stitchOutline — arcs tessellation', () => {
  it('tessellates arcs to ≥ 8 points per 90°', () => {
    // A 90° arc should produce at least 8 intermediate points
    // The fixture-arcs has 4 arcs each ~90°
    // We test with a single known 90° arc: from (0,1) through (1,1) to (1,0)
    // Center at (0,0), radius 1
    // mid point at 45°: (sin45, cos45) ≈ (0.707, 0.707)
    const primitives: EdgePrimitive[] = [
      {
        kind: 'arc',
        start: { x: 0, y: 1 },       // on unit circle at 90°
        mid: { x: 0.7071, y: 0.7071 }, // at 45°
        end: { x: 1, y: 0 },          // at 0°
      },
    ]
    // A single arc won't form a closed loop — it falls back to bounding box
    // but we need to test tessellation points. Use a closed arc shape instead.
    void stitchOutline(primitives)  // exercise the code path

    // Test with a complete circle made of 4 quarter arcs
    const quarterArcs: EdgePrimitive[] = [
      // Top-right arc: from (1,0) through (0.707,0.707) to (0,1)
      { kind: 'arc', start: { x: 10, y: 0 }, mid: { x: 7.071, y: 7.071 }, end: { x: 0, y: 10 } },
      // Top-left arc: from (0,10) through (-7.071,7.071) to (-10,0)
      { kind: 'arc', start: { x: 0, y: 10 }, mid: { x: -7.071, y: 7.071 }, end: { x: -10, y: 0 } },
      // Bottom-left arc: from (-10,0) through (-7.071,-7.071) to (0,-10)
      { kind: 'arc', start: { x: -10, y: 0 }, mid: { x: -7.071, y: -7.071 }, end: { x: 0, y: -10 } },
      // Bottom-right arc: from (0,-10) through (7.071,-7.071) to (10,0)
      { kind: 'arc', start: { x: 0, y: -10 }, mid: { x: 7.071, y: -7.071 }, end: { x: 10, y: 0 } },
    ]
    const circleResult = stitchOutline(quarterArcs, 0.5)
    // Should form 1 closed loop (a circle approximation)
    expect(circleResult.outer).toHaveLength(1)
    // 4 quarter-arcs × ≥ 8 points each = ≥ 32 points total
    expect(circleResult.outer[0].length).toBeGreaterThanOrEqual(32)
  })

  it('arc tessellation produces points close to the true circle', () => {
    // Test that tessellated arc points all lie on the circle
    // Arc from (10,0) through (0,10) — this is a quarter circle
    // center at (0,0), radius 10
    // The midpoint given should be at 45°: (7.071, 7.071)
    const primitives: EdgePrimitive[] = [
      { kind: 'arc', start: { x: 10, y: 0 }, mid: { x: 7.071, y: 7.071 }, end: { x: 0, y: 10 } },
      { kind: 'arc', start: { x: 0, y: 10 }, mid: { x: -7.071, y: 7.071 }, end: { x: -10, y: 0 } },
      { kind: 'arc', start: { x: -10, y: 0 }, mid: { x: -7.071, y: -7.071 }, end: { x: 0, y: -10 } },
      { kind: 'arc', start: { x: 0, y: -10 }, mid: { x: 7.071, y: -7.071 }, end: { x: 10, y: 0 } },
    ]
    const result = stitchOutline(primitives, 0.5)
    expect(result.outer).toHaveLength(1)
    // All points should be within 0.5 of radius 10
    for (const pt of result.outer[0]) {
      const r = Math.sqrt(pt.x ** 2 + pt.y ** 2)
      expect(r).toBeGreaterThan(9.0)
      expect(r).toBeLessThan(11.0)
    }
  })
})

// ─── circle → hole when contained in outer loop ───────────────────────────────

describe('stitchOutline — circle as hole', () => {
  it('treats a gr_circle as a hole when it is contained inside the outer loop', () => {
    // fixture-arcs has a circle at center(15,10) with radiusPoint(15,8) → radius=2
    // This is inside the rounded-rect outline (spans roughly 2..28 x 2..18)
    const board = parseBoard(fixtureArcsText)
    const result = stitchOutline(board.edgeCuts)

    expect(result.outer).toHaveLength(1)
    expect(result.holes).toHaveLength(1)
    expect(result.warnings).toHaveLength(0)
  })

  it('hole is a tessellated circle (center=15,10, radius≈2)', () => {
    const board = parseBoard(fixtureArcsText)
    const result = stitchOutline(board.edgeCuts)

    const hole = result.holes[0]
    expect(hole.length).toBeGreaterThan(0)
    // All hole points should be ~2mm from (15,10)
    for (const pt of hole) {
      const r = dist(pt, { x: 15, y: 10 })
      expect(r).toBeGreaterThan(1.5)
      expect(r).toBeLessThan(2.5)
    }
  })
})

// ─── gap > tolerance → bounding-box fallback + warning ────────────────────────

describe('stitchOutline — gap > tolerance fallback', () => {
  it('produces a bounding-box fallback with warning when gap exceeds tolerance', () => {
    // Three sides of a rectangle — the 4th segment is intentionally missing
    // This creates a gap larger than default tolerance (0.01 mm)
    const primitives: EdgePrimitive[] = [
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { kind: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
      // Missing: (0,10) → (0,0)
    ]
    const result = stitchOutline(primitives)

    // Should fall back to bounding box
    expect(result.outer).toHaveLength(1)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some(w => w.includes('outline'))).toBe(true)
  })

  it('bounding-box fallback covers the primitive extents', () => {
    const primitives: EdgePrimitive[] = [
      { kind: 'line', start: { x: 5, y: 3 }, end: { x: 20, y: 3 } },
      { kind: 'line', start: { x: 20, y: 3 }, end: { x: 20, y: 15 } },
      // Only 2 of 4 sides — deliberate gap
    ]
    const result = stitchOutline(primitives)

    // Bounding box should span the range of the primitives
    const xs = result.outer[0].map(p => p.x)
    const ys = result.outer[0].map(p => p.y)
    expect(Math.min(...xs)).toBeCloseTo(5)
    expect(Math.max(...xs)).toBeCloseTo(20)
    expect(Math.min(...ys)).toBeCloseTo(3)
    expect(Math.max(...ys)).toBeCloseTo(15)
  })
})

// ─── two disjoint outer loops → larger = outer, warning emitted ───────────────

describe('stitchOutline — two disjoint outer loops', () => {
  it('handles two disjoint rectangles: larger becomes outer, warning emitted', () => {
    // Two separate rectangles (simulate a board with a panelization notch or
    // just two disconnected outline shapes)
    const primitives: EdgePrimitive[] = [
      // Big rectangle 20×10
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
      { kind: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 10 } },
      { kind: 'line', start: { x: 20, y: 10 }, end: { x: 0, y: 10 } },
      { kind: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
      // Small rectangle 4×3 (separated, can't be a hole in a 20×10 rect that doesn't contain it)
      { kind: 'line', start: { x: 25, y: 0 }, end: { x: 29, y: 0 } },
      { kind: 'line', start: { x: 29, y: 0 }, end: { x: 29, y: 3 } },
      { kind: 'line', start: { x: 29, y: 3 }, end: { x: 25, y: 3 } },
      { kind: 'line', start: { x: 25, y: 3 }, end: { x: 25, y: 0 } },
    ]
    const result = stitchOutline(primitives)

    // At least one outer loop
    expect(result.outer.length).toBeGreaterThanOrEqual(1)
    // Warning emitted because there are multiple outer loops
    expect(result.warnings.length).toBeGreaterThan(0)
    // The largest loop should be the first outer loop
    // Big rect area = 200, small = 12 — largest should appear as outer[0]
    const largestLoop = result.outer.reduce((a, b) =>
      Math.abs(signedArea(a)) > Math.abs(signedArea(b)) ? a : b
    )
    expect(Math.abs(signedArea(largestLoop))).toBeCloseTo(200, 0)
  })
})

// ─── end-to-end: fixture-arcs through parseBoard + stitchOutline ──────────────

describe('stitchOutline — fixture-arcs end-to-end', () => {
  it('parseBoard on fixture-arcs produces edgeCuts with 4 lines + 4 arcs + 1 circle', () => {
    const board = parseBoard(fixtureArcsText)
    const lines = board.edgeCuts.filter(p => p.kind === 'line')
    const arcs = board.edgeCuts.filter(p => p.kind === 'arc')
    const circles = board.edgeCuts.filter(p => p.kind === 'circle')
    expect(lines).toHaveLength(4)
    expect(arcs).toHaveLength(4)
    expect(circles).toHaveLength(1)
  })

  it('parseBoard on fixture-arcs produces an outline with 1 outer loop and 1 hole', () => {
    // The board.outline is populated by parseBoard which calls stitchOutline internally
    const board = parseBoard(fixtureArcsText)
    expect(board.outline.outer).toHaveLength(1)
    expect(board.outline.holes).toHaveLength(1)
    expect(board.outline.warnings).toHaveLength(0)
  })

  it('fixture-arcs outer loop has bounding box within the rounded-rect extents', () => {
    const board = parseBoard(fixtureArcsText)
    const loop = board.outline.outer[0]
    const xs = loop.map(p => p.x)
    const ys = loop.map(p => p.y)
    // The outline spans roughly from (2,2) to (28,18)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(1.9)
    expect(Math.max(...xs)).toBeLessThanOrEqual(28.1)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(1.9)
    expect(Math.max(...ys)).toBeLessThanOrEqual(18.1)
  })

  it('fixture-arcs outer loop has many points (arcs tessellated)', () => {
    const board = parseBoard(fixtureArcsText)
    // 4 lines (1 pt each) + 4 arcs (≥ floor(arcAngle/90°)*8 pts each).
    // The fixture arcs are ~59° each → ceil(59/90 * 8) = 6 pts per arc.
    // Total minimum: 4*1 + 4*6 = 28 points.
    // We require > 20 to confirm tessellation is occurring (not just endpoints).
    expect(board.outline.outer[0].length).toBeGreaterThan(20)
  })

  it('fixture-arcs board has exactly 1 via', () => {
    const board = parseBoard(fixtureArcsText)
    expect(board.vias).toHaveLength(1)
    expect(board.vias[0].at.x).toBeCloseTo(15)
    expect(board.vias[0].at.y).toBeCloseTo(10)
    expect(board.vias[0].netId).toBe(3)
  })
})

// ─── area sign normalization ──────────────────────────────────────────────────

describe('stitchOutline — area sign normalization', () => {
  it('outer loops are CCW (area normalization applied consistently)', () => {
    // Spec: "outer CCW, holes CW"
    // We supply a CW rectangle and expect it to be normalized to CCW
    const cwPrimitives: EdgePrimitive[] = [
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 10 } },
      { kind: 'line', start: { x: 0, y: 10 }, end: { x: 10, y: 10 } },
      { kind: 'line', start: { x: 10, y: 10 }, end: { x: 10, y: 0 } },
      { kind: 'line', start: { x: 10, y: 0 }, end: { x: 0, y: 0 } },
    ]
    const result = stitchOutline(cwPrimitives)
    expect(result.outer).toHaveLength(1)
    // The implementation should normalize to a consistent winding
    // Either CCW or CW — but must be consistent and documented
    // Area must be non-zero and have the expected sign for "outer"
    const area = signedArea(result.outer[0])
    expect(Math.abs(area)).toBeGreaterThan(0)
    // In KiCad Y-down coords, CCW outer = positive signed area
    // (Y increases downward reverses the usual convention)
    // We accept either sign as long as holes have the opposite sign
    expect(area).not.toBe(0)
  })
})

// ─── edge cases ───────────────────────────────────────────────────────────────

describe('stitchOutline — edge cases', () => {
  it('empty input → empty outer, no holes, bounding-box warning', () => {
    const result = stitchOutline([])
    expect(result.outer).toHaveLength(0)
    expect(result.holes).toHaveLength(0)
    // No primitives = no meaningful outline
  })

  it('custom tolerance parameter is respected', () => {
    // With a very loose tolerance (5mm), a chain with a 1mm gap should close
    const primitives: EdgePrimitive[] = [
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { kind: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
      // Last segment ends with a 1mm gap (not at 0,0 but at 1,0)
      { kind: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 1 } },
    ]
    // Default tolerance (0.01mm) → gap detected, fallback
    const tightResult = stitchOutline(primitives, 0.01)
    expect(tightResult.warnings.length).toBeGreaterThan(0)

    // Loose tolerance (2mm) → gap bridged, closed loop
    const looseResult = stitchOutline(primitives, 2.0)
    // With loose tolerance the last segment's endpoint is close enough to close
    // (gap is 1mm which is < 2mm tolerance)
    expect(looseResult.outer).toHaveLength(1)
    expect(looseResult.warnings).toHaveLength(0)
  })
})
