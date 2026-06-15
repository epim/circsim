/**
 * overlay.test.ts — Task 20
 *
 * Tests for overlay.ts:
 *   - setOverlay mode switching (realistic / voltage / highlight)
 *   - applyNetVoltages: per-net color lerp blue→red
 *   - legend data exposed correctly
 *   - perf: 500-net color-write loop ≤ 16 ms (no GL context needed)
 *
 * THREE.MeshStandardMaterial works headlessly; no WebGL context required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  createOverlayController,
  type OverlayController,
  type LegendData,
} from '../overlay'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a fake net→material map with N entries. */
function makeNetMaterials(count: number): Map<number, THREE.MeshStandardMaterial> {
  const map = new Map<number, THREE.MeshStandardMaterial>()
  for (let i = 1; i <= count; i++) {
    map.set(i, new THREE.MeshStandardMaterial({ color: 0xb87333 }))
  }
  return map
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OverlayController — mode switching', () => {
  let overlay: OverlayController
  let netMaterials: Map<number, THREE.MeshStandardMaterial>

  beforeEach(() => {
    netMaterials = makeNetMaterials(3)
    overlay = createOverlayController(netMaterials)
  })

  it('starts in realistic mode', () => {
    expect(overlay.getMode()).toBe('realistic')
  })

  it('setOverlay("voltage") switches mode', () => {
    overlay.setOverlay('voltage')
    expect(overlay.getMode()).toBe('voltage')
  })

  it('setOverlay("highlight") switches mode', () => {
    overlay.setOverlay('highlight')
    expect(overlay.getMode()).toBe('highlight')
  })

  it('setOverlay("realistic") restores copper colors', () => {
    // Capture original copper color from a fresh material
    const refMat = new THREE.MeshStandardMaterial({ color: 0xb87333 })
    const expectedR = refMat.color.r
    const expectedG = refMat.color.g
    const expectedB = refMat.color.b

    overlay.setOverlay('voltage')
    // Apply some voltages so materials are tinted
    overlay.applyNetVoltages(new Map([[1, 5], [2, 2.5], [3, 0]]), 0, 5)
    overlay.setOverlay('realistic')

    // All materials should be restored to copper base color
    for (const mat of netMaterials.values()) {
      expect(mat.color.r).toBeCloseTo(expectedR, 5)
      expect(mat.color.g).toBeCloseTo(expectedG, 5)
      expect(mat.color.b).toBeCloseTo(expectedB, 5)
    }
  })
})

describe('OverlayController — voltage tinting', () => {
  let overlay: OverlayController
  let netMaterials: Map<number, THREE.MeshStandardMaterial>

  beforeEach(() => {
    netMaterials = makeNetMaterials(3)
    overlay = createOverlayController(netMaterials)
    overlay.setOverlay('voltage')
  })

  it('applyNetVoltages: min voltage → blue', () => {
    overlay.applyNetVoltages(new Map([[1, 0]]), 0, 5)
    const mat = netMaterials.get(1)!
    // Blue: r≈0, g≈0, b≈1
    expect(mat.color.b).toBeGreaterThan(0.7)
    expect(mat.color.r).toBeLessThan(0.3)
  })

  it('applyNetVoltages: max voltage → red', () => {
    overlay.applyNetVoltages(new Map([[2, 5]]), 0, 5)
    const mat = netMaterials.get(2)!
    // Red: r≈1, g≈0, b≈0
    expect(mat.color.r).toBeGreaterThan(0.7)
    expect(mat.color.b).toBeLessThan(0.3)
  })

  it('applyNetVoltages: midpoint voltage → intermediate color (r≈g, neither pure R nor B)', () => {
    overlay.applyNetVoltages(new Map([[3, 2.5]]), 0, 5)
    const mat = netMaterials.get(3)!
    // At t=0.5, lerp from blue to red: neither fully red nor fully blue
    expect(mat.color.r).toBeGreaterThan(0.1)
    expect(mat.color.b).toBeGreaterThan(0.1)
  })

  it('applyNetVoltages: only tints nets present in the map; untouched nets unchanged', () => {
    const originalColor = netMaterials.get(2)!.color.clone()
    overlay.applyNetVoltages(new Map([[1, 0]]), 0, 5)  // only net 1
    const mat2 = netMaterials.get(2)!
    // Net 2 color should still equal originalColor (no change)
    expect(mat2.color.r).toBeCloseTo(originalColor.r, 5)
    expect(mat2.color.g).toBeCloseTo(originalColor.g, 5)
    expect(mat2.color.b).toBeCloseTo(originalColor.b, 5)
  })

  it('applyNetVoltages: min === max → all nets treated as "max" without crashing', () => {
    // When min === max, avoid division by zero; treat all as t=1 (or t=0)
    expect(() => {
      overlay.applyNetVoltages(new Map([[1, 5], [2, 5]]), 5, 5)
    }).not.toThrow()
  })

  it('voltage outside [min, max] is clamped', () => {
    overlay.applyNetVoltages(new Map([[1, -99], [2, 999]]), 0, 5)
    const mat1 = netMaterials.get(1)!
    const mat2 = netMaterials.get(2)!
    // -99 → clamped to 0 → blue
    expect(mat1.color.b).toBeGreaterThan(0.7)
    // 999 → clamped to 5 → red
    expect(mat2.color.r).toBeGreaterThan(0.7)
  })
})

describe('OverlayController — legend data', () => {
  it('getLegend returns null when not in voltage mode', () => {
    const overlay = createOverlayController(makeNetMaterials(3))
    expect(overlay.getLegend()).toBeNull()
  })

  it('getLegend returns min/max/stops after applyNetVoltages', () => {
    const netMaterials = makeNetMaterials(3)
    const overlay = createOverlayController(netMaterials)
    overlay.setOverlay('voltage')
    overlay.applyNetVoltages(new Map([[1, 0], [2, 2.5], [3, 5]]), 0, 5)

    const legend = overlay.getLegend() as LegendData
    expect(legend).not.toBeNull()
    expect(legend.minVolts).toBe(0)
    expect(legend.maxVolts).toBe(5)
    expect(legend.stops.length).toBeGreaterThanOrEqual(2)
    // First stop is blue (min), last stop is red (max)
    const first = legend.stops[0]
    const last  = legend.stops[legend.stops.length - 1]
    expect(first.color.b).toBeGreaterThan(0.7)
    expect(last.color.r).toBeGreaterThan(0.7)
  })

  it('getLegend clears after switching back to realistic', () => {
    const overlay = createOverlayController(makeNetMaterials(2))
    overlay.setOverlay('voltage')
    overlay.applyNetVoltages(new Map([[1, 0]]), 0, 5)
    overlay.setOverlay('realistic')
    expect(overlay.getLegend()).toBeNull()
  })
})

describe('OverlayController — performance', () => {
  it('color-write loop for 500 nets completes in ≤ 16 ms', () => {
    const netMaterials = makeNetMaterials(500)
    const overlay = createOverlayController(netMaterials)
    overlay.setOverlay('voltage')

    // Build a voltages map for all 500 nets
    const voltages = new Map<number, number>()
    for (let i = 1; i <= 500; i++) {
      voltages.set(i, (i / 500) * 5)
    }

    const start = performance.now()
    overlay.applyNetVoltages(voltages, 0, 5)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(16)
  })
})
