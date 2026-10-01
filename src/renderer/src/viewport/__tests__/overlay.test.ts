/**
 * overlay.test.ts — Task 20
 *
 * Tests for overlay.ts:
 *   - setOverlay mode switching (realistic / voltage / highlight)
 *   - applyNetVoltages: per-net viridis ramp, violet (min) to yellow (max)
 *   - legend data exposed correctly
 *   - perf: color-write cost grows linearly with net count (ratio, no GL context needed)
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
import { NetTintTable } from '../netTint'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Create a fake net→material map with N entries. */
function makeNetMaterials(count: number): Map<number, THREE.MeshStandardMaterial> {
  const map = new Map<number, THREE.MeshStandardMaterial>()
  for (let i = 1; i <= count; i++) {
    map.set(i, new THREE.MeshStandardMaterial({ color: 0xb87333 }))
  }
  return map
}

/**
 * Best-of-5 wall time (ms) for a batch of 500 applyNetVoltages calls over `count`
 * nets. The batch is large so even the 500-net case costs several milliseconds
 * per sample, well above timer noise. The range end changes every call so no
 * per-call result can be reused.
 * Wall time is only ever compared between two sizes on the same machine, never
 * against an absolute millisecond bound: CI runners are up to 5x slower than a
 * dev machine.
 */
function timeApply(overlay: OverlayController, count: number, iters: number): number {
  overlay.setOverlay('voltage')
  const voltages = new Map<number, number>()
  for (let i = 1; i <= count; i++) voltages.set(i, (i / count) * 5)
  let best = Infinity
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now()
    for (let k = 0; k < iters; k++) overlay.applyNetVoltages(voltages, 0, 5 + (k % 20) * 0.01)
    best = Math.min(best, (performance.now() - t0) / iters)
  }
  return best
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OverlayController: mode switching', () => {
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

describe('OverlayController: voltage tinting', () => {
  let overlay: OverlayController
  let netMaterials: Map<number, THREE.MeshStandardMaterial>

  beforeEach(() => {
    netMaterials = makeNetMaterials(3)
    overlay = createOverlayController(netMaterials)
    overlay.setOverlay('voltage')
  })

  it('applyNetVoltages: min voltage → dark violet end of the ramp', () => {
    overlay.applyNetVoltages(new Map([[1, 0]]), 0, 5)
    const mat = netMaterials.get(1)!
    // Viridis low end (#482878): blue-dominant, dark, green well below blue.
    expect(mat.color.b).toBeGreaterThan(mat.color.g)
    expect(mat.color.g).toBeLessThan(0.1)
  })

  it('applyNetVoltages: max voltage → yellow end of the ramp', () => {
    overlay.applyNetVoltages(new Map([[2, 5]]), 0, 5)
    const mat = netMaterials.get(2)!
    // Viridis high end (#fde725): red and green bright, blue near zero.
    expect(mat.color.r).toBeGreaterThan(0.8)
    expect(mat.color.g).toBeGreaterThan(0.7)
    expect(mat.color.b).toBeLessThan(0.1)
  })

  it('applyNetVoltages: no red-to-blue hue pair (issue #70: colorblind-safe ramp)', () => {
    overlay.applyNetVoltages(new Map([[1, 0], [2, 5]]), 0, 5)
    const lo = netMaterials.get(1)!.color
    const hi = netMaterials.get(2)!.color
    // The old ramp was pure blue (0,0,1) to pure red (1,0,0): green stayed ~0 at both ends.
    expect(hi.g).toBeGreaterThan(0.5)
    // Lightness (a luminance proxy) must rise from low to high so it reads without hue.
    const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    expect(lum(hi)).toBeGreaterThan(lum(lo) * 3)
  })

  it('applyNetVoltages: luminance rises monotonically with voltage', () => {
    const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    let prev = -1
    for (let i = 0; i <= 10; i++) {
      overlay.applyNetVoltages(new Map([[1, i / 2]]), 0, 5)
      const l = lum(netMaterials.get(1)!.color)
      expect(l).toBeGreaterThan(prev)
      prev = l
    }
  })

  it('applyNetVoltages: midpoint voltage → intermediate teal-green', () => {
    overlay.applyNetVoltages(new Map([[3, 2.5]]), 0, 5)
    const mat = netMaterials.get(3)!
    // Viridis midpoint (#1f9e89 region): green dominant, red low, blue present.
    expect(mat.color.g).toBeGreaterThan(mat.color.r)
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
    // -99 → clamped to 0 → low end (violet)
    expect(mat1.color.g).toBeLessThan(0.1)
    // 999 → clamped to 5 → high end (yellow)
    expect(mat2.color.r).toBeGreaterThan(0.8)
  })
})

describe('OverlayController: legend data', () => {
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
    // First stop is the violet low end (min), last stop the yellow high end (max)
    const first = legend.stops[0]
    const last  = legend.stops[legend.stops.length - 1]
    expect(first.color.b).toBeGreaterThan(first.color.g)
    expect(last.color.r).toBeGreaterThan(0.8)
    expect(last.color.g).toBeGreaterThan(0.7)
  })

  it('getLegend clears after switching back to realistic', () => {
    const overlay = createOverlayController(makeNetMaterials(2))
    overlay.setOverlay('voltage')
    overlay.applyNetVoltages(new Map([[1, 0]]), 0, 5)
    overlay.setOverlay('realistic')
    expect(overlay.getLegend()).toBeNull()
  })
})

describe('OverlayController: performance', () => {
  it('color-write cost grows linearly with net count (100 to 10000 nets)', () => {
    // Per-update cost (ms), so the small case runs many more updates than the
    // big one and both samples last several milliseconds, well above timer noise.
    timeApply(createOverlayController(makeNetMaterials(100)), 100, 5000) // warm the JIT
    const small = timeApply(createOverlayController(makeNetMaterials(100)), 100, 5000)
    const big = timeApply(createOverlayController(makeNetMaterials(10000)), 10000, 50)

    // Intent: the color-write loop stays a single pass over the nets, so a
    // frame update on a big board fits the 16 ms spec budget. 100x the nets
    // costs about 100x the time (measured 170 to 195 locally, cache effects at
    // the larger size); a quadratic loop would cost about 10000x. The bound of
    // 1000 is over 5x the highest locally measured ratio, so a loaded runner
    // does not trip it, and it still fails on quadratic work with a wide margin.
    const ratio = big / small
    expect(ratio).toBeLessThan(1000)
  })
})

describe('OverlayController: uniform-only writes (#77)', () => {
  it('applyNetVoltages and setOverlay never bump a material version', () => {
    const netMaterials = makeNetMaterials(50)
    const overlay = createOverlayController(netMaterials)
    const before = [...netMaterials.values()].map(m => m.version)

    overlay.setOverlay('voltage')
    const voltages = new Map<number, number>()
    for (let i = 1; i <= 50; i++) voltages.set(i, (i / 50) * 5)
    overlay.applyNetVoltages(voltages, 0, 5)
    overlay.applyNetVoltages(voltages, 0, 5)
    overlay.setOverlay('realistic')

    const after = [...netMaterials.values()].map(m => m.version)
    expect(after).toEqual(before)
  })
})

describe('OverlayController: NetTintTable target (#57)', () => {
  const COPPER = new THREE.Color(0xb87333)

  it('tints nets through the table and restores them in realistic mode', () => {
    const tints = new NetTintTable([1, 2, 3], COPPER)
    const overlay = createOverlayController(tints)
    overlay.setOverlay('voltage')
    overlay.applyNetVoltages(new Map([[1, 0], [2, 5]]), 0, 5)

    // Viridis ramp (#70): violet at the low end, yellow at the high end.
    const low = tints.getColor(1)!
    expect(low.b).toBeGreaterThan(low.r)
    expect(low.b).toBeGreaterThan(low.g)
    const high = tints.getColor(2)!
    expect(high.r).toBeGreaterThan(0.7)
    expect(high.g).toBeGreaterThan(0.6)
    expect(high.b).toBeLessThan(0.2)
    // net 3 was not in the map: still copper
    expect(tints.getColor(3)!.r).toBeCloseTo(COPPER.r, 5)

    overlay.setOverlay('realistic')
    for (const id of [1, 2, 3]) {
      expect(tints.getColor(id)!.r).toBeCloseTo(COPPER.r, 5)
      expect(tints.getColor(id)!.g).toBeCloseTo(COPPER.g, 5)
      expect(tints.getColor(id)!.b).toBeCloseTo(COPPER.b, 5)
    }
  })

  it('a tint update grows linearly with net count (150 to 15000 nets)', () => {
    const tintTime = (count: number, iters: number) =>
      timeApply(createOverlayController(new NetTintTable(Array.from({ length: count }, (_, i) => i + 1), COPPER)), count, iters)
    tintTime(150, 5000) // warm the JIT
    const small = tintTime(150, 5000)
    const big = tintTime(15000, 50)

    // Intent: tinting through the table is one uniform write per net (no
    // per-net material, no version bump), so the 16 ms spec budget holds at
    // 1500 nets. Same-machine ratio: 100x the nets costs about 100x the time
    // (measured 150 to 160 locally, cache effects at the larger size); a
    // quadratic update would cost about 10000x. The bound of 1000 is over 5x the
    // highest locally measured ratio, so a loaded runner does not trip it, and
    // it still fails on quadratic work with a wide margin.
    const ratio = big / small
    expect(ratio).toBeLessThan(1000)
  })

  it('does not tint outside voltage mode', () => {
    const tints = new NetTintTable([1], COPPER)
    const overlay = createOverlayController(tints)
    overlay.applyNetVoltages(new Map([[1, 5]]), 0, 5)
    expect(tints.getColor(1)!.r).toBeCloseTo(COPPER.r, 5)
  })
})
