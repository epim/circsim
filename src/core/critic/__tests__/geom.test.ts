/**
 * core/critic/__tests__/geom.test.ts
 *
 * TDD for the Board Critic geometry helpers (C0). Written before geom.ts.
 */

import { describe, it, expect } from 'vitest'
import type { Footprint, Pad, TrackSegment, OutlineGeometry } from '../../kicad/types'
import {
  padWorldPos,
  rotateKicad,
  dist,
  segLengthMm,
  arcLengthMm,
  trackResistanceOhms,
  segPointDistanceMm,
  segSegDistanceMm,
  pointInOutline,
} from '../geom'

// ─── helpers to build minimal fixtures ─────────────────────────────────────────

function pad(number: string, x: number, y: number, w = 0.5, h = 0.5): Pad {
  return {
    number,
    type: 'smd',
    shape: 'rect',
    at: { x, y, rotDeg: 0 },
    size: { w, h },
    layers: ['F.Cu'],
    netId: 1,
  }
}

function fp(x: number, y: number, rotDeg: number, pads: Pad[]): Footprint {
  return {
    ref: 'X1',
    value: '',
    libId: 'lib:fp',
    layer: 'F',
    at: { x, y, rotDeg },
    pads,
    properties: {},
  }
}

// ─── padWorldPos ────────────────────────────────────────────────────────────────

describe('padWorldPos', () => {
  it('translates by footprint origin at rot 0', () => {
    const f = fp(10, 10, 0, [pad('1', 1, 0)])
    expect(padWorldPos(f, f.pads[0])).toEqual({ x: 11, y: 10 })
  })

  it('rotates the pad offset with KiCad handedness (positive angle is counter-clockwise on screen)', () => {
    // KiCad RotatePoint, Y-down: x' = x cos + y sin, y' = -x sin + y cos.
    // (1,0) at 90 -> (0,-1) (up on screen); origin (10,10) -> (10,9)
    const f90 = fp(10, 10, 90, [pad('1', 1, 0)])
    expect(padWorldPos(f90, f90.pads[0])).toEqual({ x: 10, y: 9 })

    // (1,0) at 270 -> (0,1); origin (10,10) -> (10,11)
    const f270 = fp(10, 10, 270, [pad('1', 1, 0)])
    expect(padWorldPos(f270, f270.pads[0])).toEqual({ x: 10, y: 11 })

    // (1,0) at 180 -> (-1,0) -> (9,10)
    const f180 = fp(10, 10, 180, [pad('1', 1, 0)])
    expect(padWorldPos(f180, f180.pads[0])).toEqual({ x: 9, y: 10 })
  })

  it('handles off-axis angles and negative or over-full-turn angles', () => {
    const p45 = rotateKicad(1, 0, 45)
    expect(p45.x).toBeCloseTo(Math.SQRT1_2)
    expect(p45.y).toBeCloseTo(-Math.SQRT1_2)
    expect(rotateKicad(1, 2, -90)).toEqual(rotateKicad(1, 2, 270))
    expect(rotateKicad(1, 2, 450)).toEqual(rotateKicad(1, 2, 90))
  })
})

// ─── dist / segLengthMm ──────────────────────────────────────────────────────────

describe('dist & segLengthMm', () => {
  it('dist is Euclidean', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5)
  })

  it('segLengthMm of a 3-4-5 segment is 5', () => {
    const seg: TrackSegment = {
      kind: 'segment',
      start: { x: 0, y: 0 },
      end: { x: 3, y: 4 },
      widthMm: 0.25,
      layer: 'F.Cu',
      netId: 1,
    }
    expect(segLengthMm(seg)).toBeCloseTo(5)
  })
})

// ─── arcLengthMm ──────────────────────────────────────────────────────────────────

describe('arcLengthMm', () => {
  it('a quarter of the unit circle has length ~π/2', () => {
    const arc: TrackSegment = {
      kind: 'arc',
      start: { x: 1, y: 0 },
      mid: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
      end: { x: 0, y: 1 },
      widthMm: 0.25,
      layer: 'F.Cu',
      netId: 1,
    }
    expect(arcLengthMm(arc)).toBeCloseTo(Math.PI / 2, 3)
  })

  it('falls back to the chord length for (near-)collinear points', () => {
    const arc: TrackSegment = {
      kind: 'arc',
      start: { x: 0, y: 0 },
      mid: { x: 1, y: 0 },
      end: { x: 2, y: 0 },
      widthMm: 0.25,
      layer: 'F.Cu',
      netId: 1,
    }
    expect(arcLengthMm(arc)).toBeCloseTo(2, 3)
  })
})

// ─── trackResistanceOhms ──────────────────────────────────────────────────────────

describe('trackResistanceOhms', () => {
  it('matches the closed-form ρL/(w·t) for a 100mm × 0.5mm 1oz trace', () => {
    // ρ_Cu=1.68e-8, L=0.1m, w=0.5e-3m, t=34.8e-6m → ~0.0966 Ω
    const r = trackResistanceOhms(100, 0.5, 1)
    expect(r).toBeCloseTo(0.0966, 3)
  })

  it('halves when width doubles', () => {
    const r1 = trackResistanceOhms(100, 0.5, 1)
    const r2 = trackResistanceOhms(100, 1.0, 1)
    expect(r2).toBeCloseTo(r1 / 2, 6)
  })

  it('returns Infinity for a zero-width trace (degenerate, avoid div-by-zero)', () => {
    expect(trackResistanceOhms(100, 0, 1)).toBe(Infinity)
  })

  // Copper-weight scaling (issue #69): thickness is oz x 34.8 um, so resistance
  // is inversely proportional to weight. Independent closed form, not a ratio
  // of the function against itself.
  it('matches the closed-form rho L/(w t) at 2 oz and 0.5 oz', () => {
    const rho = 1.68e-8
    const L = 0.1
    const w = 0.5e-3
    const r2 = (rho * L) / (w * 2 * 34.8e-6)
    const rHalf = (rho * L) / (w * 0.5 * 34.8e-6)
    expect(trackResistanceOhms(100, 0.5, 2)).toBeCloseTo(r2, 9)
    expect(trackResistanceOhms(100, 0.5, 0.5)).toBeCloseTo(rHalf, 9)
    // Pinned absolute values so a wrong constant cannot hide behind the formula.
    expect(trackResistanceOhms(100, 0.5, 2)).toBeCloseTo(0.0483, 4)
    expect(trackResistanceOhms(100, 0.5, 0.5)).toBeCloseTo(0.1931, 4)
  })

  it('halves when copper weight doubles and doubles when it halves', () => {
    const r1 = trackResistanceOhms(100, 0.5, 1)
    expect(trackResistanceOhms(100, 0.5, 2)).toBeCloseTo(r1 / 2, 9)
    expect(trackResistanceOhms(100, 0.5, 0.5)).toBeCloseTo(r1 * 2, 9)
    // Heavier copper must always be strictly lower resistance.
    expect(trackResistanceOhms(100, 0.5, 2)).toBeLessThan(r1)
  })
})

// ─── segPointDistanceMm ───────────────────────────────────────────────────────────

describe('segPointDistanceMm', () => {
  it('perpendicular distance to the segment interior', () => {
    expect(segPointDistanceMm({ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(1)
  })

  it('clamps to the nearest endpoint when past the segment', () => {
    // point beyond the right end → distance to (1,0)
    expect(segPointDistanceMm({ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 4, y: 0 })).toBeCloseTo(3)
  })
})

// ─── segSegDistanceMm ─────────────────────────────────────────────────────────────

describe('segSegDistanceMm', () => {
  it('two parallel segments 0.3 mm apart', () => {
    const d = segSegDistanceMm(
      { x: 0, y: 0 }, { x: 5, y: 0 },
      { x: 0, y: 0.3 }, { x: 5, y: 0.3 },
    )
    expect(d).toBeCloseTo(0.3)
  })

  it('returns 0 for crossing segments', () => {
    const d = segSegDistanceMm(
      { x: -1, y: 0 }, { x: 1, y: 0 },
      { x: 0, y: -1 }, { x: 0, y: 1 },
    )
    expect(d).toBeCloseTo(0)
  })
})

// ─── pointInOutline ───────────────────────────────────────────────────────────────

describe('pointInOutline', () => {
  const outline: OutlineGeometry = {
    outer: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]],
    holes: [],
    warnings: [],
  }

  it('true for a point inside the square', () => {
    expect(pointInOutline({ x: 5, y: 5 }, outline)).toBe(true)
  })

  it('false for a point outside the square', () => {
    expect(pointInOutline({ x: 15, y: 5 }, outline)).toBe(false)
  })
})
