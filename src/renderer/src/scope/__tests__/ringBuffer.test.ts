/**
 * src/renderer/src/scope/__tests__/ringBuffer.test.ts — Task 23
 *
 * Unit tests for the per-probe ring buffer. Covers:
 *   - O(1) append (mutates in-place, no allocation)
 *   - Overwrite semantics (wrap-around)
 *   - windowed read: read(offset, length) → Float64Array view
 *   - Multiple probes independent
 *   - Fed from samples events (time + value channels)
 */

import { describe, it, expect } from 'vitest'
import { createRingBuffer, feedSamples } from '../ringBuffer'
import { createBenchTimeline } from '../benchTimeline'

describe('RingBuffer', () => {
  it('starts empty with correct capacity', () => {
    const rb = createRingBuffer(1024)
    expect(rb.capacity).toBe(1024)
    expect(rb.length).toBe(0)
  })

  it('appends single value O(1) — length grows', () => {
    const rb = createRingBuffer(8)
    rb.append(1.0, 0.0)
    expect(rb.length).toBe(1)
    rb.append(2.0, 0.001)
    expect(rb.length).toBe(2)
  })

  it('windowed read returns correct values before wrap', () => {
    const rb = createRingBuffer(16)
    for (let i = 0; i < 5; i++) {
      rb.append(i * 10, i * 0.001)
    }
    // read all
    const { values, times } = rb.read(0, 5)
    expect(values.length).toBe(5)
    expect(times.length).toBe(5)
    for (let i = 0; i < 5; i++) {
      expect(values[i]).toBeCloseTo(i * 10, 10)
      expect(times[i]).toBeCloseTo(i * 0.001, 10)
    }
  })

  it('read with offset and length returns slice', () => {
    const rb = createRingBuffer(16)
    for (let i = 0; i < 8; i++) {
      rb.append(i * 1.0, i * 0.01)
    }
    const { values } = rb.read(2, 4) // [2, 3, 4, 5]
    expect(values.length).toBe(4)
    expect(values[0]).toBeCloseTo(2.0, 10)
    expect(values[3]).toBeCloseTo(5.0, 10)
  })

  it('wraps around — oldest samples overwritten', () => {
    const rb = createRingBuffer(4)
    // Fill: [10, 20, 30, 40]
    rb.append(10, 0.0)
    rb.append(20, 0.1)
    rb.append(30, 0.2)
    rb.append(40, 0.3)
    expect(rb.length).toBe(4)
    // Append one more — overwrites oldest (10), ring = [20, 30, 40, 50]
    rb.append(50, 0.4)
    expect(rb.length).toBe(4) // stays capped at capacity
    const { values } = rb.read(0, 4)
    expect(values[0]).toBeCloseTo(20, 10)
    expect(values[3]).toBeCloseTo(50, 10)
  })

  it('wrap-around read is contiguous — no corruption', () => {
    const cap = 8
    const rb = createRingBuffer(cap)
    // Fill to 1.5x capacity so we wrap
    for (let i = 0; i < 12; i++) {
      rb.append(i * 1.0, i * 0.01)
    }
    expect(rb.length).toBe(cap) // capped
    // Last 8 values are 4..11
    const { values } = rb.read(0, cap)
    for (let i = 0; i < cap; i++) {
      expect(values[i]).toBeCloseTo(4 + i, 10)
    }
  })

  it('default capacity is 1M points', () => {
    const rb = createRingBuffer()
    expect(rb.capacity).toBe(1_000_000)
  })

  it('readWindow returns the last N time-units of data', () => {
    const rb = createRingBuffer(100)
    // 100 points from t=0 to t=0.099 s (step 1ms)
    for (let i = 0; i < 100; i++) {
      rb.append(Math.sin(2 * Math.PI * 1000 * i * 0.001), i * 0.001)
    }
    // Window of last 10ms starting from t=0.09
    const { times } = rb.readWindow(0.09, 0.099)
    expect(times.length).toBeGreaterThanOrEqual(9)
    expect(times[0]).toBeGreaterThanOrEqual(0.09)
    expect(times[times.length - 1]).toBeLessThanOrEqual(0.1)
  })
})

describe('feedSamples', () => {
  it('appends time-aligned samples to the ring buffer', () => {
    const rb = createRingBuffer(16)
    const times = new Float64Array([0.0, 0.001, 0.002])
    const values = new Float64Array([1.0, 2.0, 3.0])
    feedSamples(rb, times, values)
    expect(rb.length).toBe(3)
    const { values: out } = rb.read(0, 3)
    expect(out[0]).toBeCloseTo(1.0, 10)
    expect(out[2]).toBeCloseTo(3.0, 10)
  })

  it('handles multiple feedSamples calls (streaming)', () => {
    const rb = createRingBuffer(16)
    feedSamples(rb, new Float64Array([0, 1, 2]), new Float64Array([10, 20, 30]))
    feedSamples(rb, new Float64Array([3, 4, 5]), new Float64Array([40, 50, 60]))
    expect(rb.length).toBe(6)
    const { values } = rb.read(0, 6)
    expect(values[5]).toBeCloseTo(60, 10)
  })
})

// ─── issue #59: bounded readWindow, bench-window restarts ──────────────────────

/** Reference implementation: the old linear scan over the logical ring. */
function linearWindow(
  rb: ReturnType<typeof createRingBuffer>,
  tStart: number,
  tEnd: number,
): { values: number[]; times: number[] } {
  const all = rb.read(0, rb.length)
  const values: number[] = []
  const times: number[] = []
  for (let i = 0; i < all.times.length; i++) {
    if (all.times[i] >= tStart && all.times[i] <= tEnd) {
      times.push(all.times[i])
      values.push(all.values[i])
    }
  }
  return { values, times }
}

describe('RingBuffer.readWindow (issue #59)', () => {
  it('matches a linear scan on a wrapped ring for many windows', () => {
    const rb = createRingBuffer(64)
    // 150 samples into a 64-slot ring: wrapped, oldest is t = 86e-6.
    for (let i = 0; i < 150; i++) rb.append(i * 3, i * 1e-6)
    const windows: [number, number][] = [
      [0, 1], // everything
      [0, 50e-6], // entirely before the oldest retained sample
      [140e-6, 1], // tail
      [86e-6, 86e-6], // exactly the oldest
      [149e-6, 149e-6], // exactly the newest
      [100.5e-6, 110.5e-6], // between samples
      [120e-6, 119e-6], // inverted
      [2, 3], // after everything
    ]
    for (const [a, b] of windows) {
      const got = rb.readWindow(a, b)
      const want = linearWindow(rb, a, b)
      expect(Array.from(got.times)).toEqual(want.times)
      expect(Array.from(got.values)).toEqual(want.values)
    }
  })

  it('keeps duplicate timestamps inside an inclusive window', () => {
    const rb = createRingBuffer(16)
    for (const t of [0, 1, 1, 1, 2, 3]) rb.append(t * 10, t)
    const { times } = rb.readWindow(1, 2)
    expect(Array.from(times)).toEqual([1, 1, 1, 2])
  })

  it('returns copies that later appends do not alias', () => {
    const rb = createRingBuffer(8)
    for (let i = 0; i < 4; i++) rb.append(i, i)
    const first = rb.readWindow(0, 3)
    rb.append(99, 4)
    rb.append(98, 5)
    expect(Array.from(first.values)).toEqual([0, 1, 2, 3])
  })

  it('append clears the ring on a time it cannot place in order', () => {
    // feedSamples never does this across a restart (it stores run time); the
    // guard keeps readWindow's binary search valid for any direct caller.
    const rb = createRingBuffer(32)
    for (let i = 0; i < 10; i++) rb.append(i, i * 1e-3)
    expect(rb.newestTime).toBeCloseTo(9e-3, 12)
    rb.append(100, 0)
    rb.append(101, 1e-3)
    rb.append(102, 2e-3)
    expect(rb.length).toBe(3)
    expect(rb.newestTime).toBeCloseTo(2e-3, 12)
    expect(Array.from(rb.read(0, rb.length).values)).toEqual([100, 101, 102])
    expect(Array.from(rb.readWindow(0, 1).values)).toEqual([100, 101, 102])
  })

  it('the ordering guard works on a wrapped ring and keeps appending correctly', () => {
    const rb = createRingBuffer(4)
    for (let i = 0; i < 7; i++) rb.append(i, i) // wrapped
    rb.append(50, 0) // out of order: cleared
    for (let i = 1; i < 6; i++) rb.append(50 + i, i) // wraps again
    expect(Array.from(rb.read(0, rb.length).times)).toEqual([2, 3, 4, 5])
    expect(Array.from(rb.readWindow(3, 4).values)).toEqual([53, 54])
  })

  it('shiftTimes moves every stored time on a wrapped ring', () => {
    const rb = createRingBuffer(4)
    for (let i = 0; i < 6; i++) rb.append(i, i) // wrapped: times 2..5
    rb.shiftTimes(10)
    expect(Array.from(rb.read(0, rb.length).times)).toEqual([12, 13, 14, 15])
    expect(rb.newestTime).toBe(15)
    rb.append(9, 16)
    expect(rb.length).toBe(4)
    expect(Array.from(rb.readWindow(14, 16).values)).toEqual([4, 5, 9])
  })

  it('equal times are not a restart', () => {
    const rb = createRingBuffer(8)
    rb.append(1, 1)
    rb.append(2, 1)
    expect(rb.length).toBe(2)
  })

  it('newestTime is NaN when empty', () => {
    expect(createRingBuffer(4).newestTime).toBeNaN()
  })

  it('does not scan the whole ring: a small window costs the same on a 50x larger ring', () => {
    /**
     * Best-of-7 wall time (ms) for 300 frames of the same 10 ms window on a
     * wrapped ring. 300 frames of a 10k-point copy is several milliseconds even
     * on the small ring, so the measurement sits well above timer and scheduler
     * noise instead of at a sub-millisecond value.
     */
    const timeFrames = (capacity: number) => {
      const rb = createRingBuffer(capacity)
      const n = Math.floor(capacity * 1.2) // wrap once
      for (let i = 0; i < n; i++) rb.append(i, i * 1e-6)
      const tEnd = (n - 1) * 1e-6
      let best = Infinity
      let points = 0
      for (let rep = 0; rep < 7; rep++) {
        points = 0
        const t0 = performance.now()
        for (let f = 0; f < 300; f++) points += rb.readWindow(tEnd - 10e-3, tEnd).times.length
        best = Math.min(best, performance.now() - t0)
      }
      return { best, points }
    }
    timeFrames(40_000) // warm the JIT so the small run is not the cold one
    const small = timeFrames(40_000)
    const big = timeFrames(2_000_000)
    expect(small.points).toBeGreaterThan(0)
    expect(big.points).toBe(small.points) // same window, same points

    // Intent: the read is a binary search plus a copy of the window, so its cost
    // depends on the window, not the ring size. No absolute millisecond bound: CI
    // runners are up to 5x slower than a dev machine, so compare two ring sizes
    // on the same machine. The window is identical, so the expected ratio is
    // about 1. A whole-ring scan grows with capacity: on a 50x larger ring it
    // would cost many times the shared window copy (expected ratio well above 10
    // under that regression). The bound of 5 is 5x the expected ratio, leaving
    // room for cache effects and runner noise, and still fails on the scan.
    const ratio = big.best / small.best
    expect(ratio).toBeLessThan(5)
  })
})

// ─── issue #59 / Spec 7.5: one run time axis across bench-window restarts ─────

/** A samples batch: one shared time column, as ingestSamples passes it. */
function batch(...times: number[]): Float64Array {
  return new Float64Array(times)
}

/** Feed the same batch to several rings, in order, through one timeline. */
function feedAll(
  timeline: ReturnType<typeof createBenchTimeline>,
  simTime: Float64Array,
  rings: ReturnType<typeof createRingBuffer>[],
): void {
  for (const rb of rings) {
    feedSamples(rb, simTime, simTime.map(t => t * 10), timeline)
  }
}

function times(rb: ReturnType<typeof createRingBuffer>): number[] {
  return Array.from(rb.read(0, rb.length).times)
}

describe('feedSamples with a bench timeline (Spec 7.5)', () => {
  it('keeps history across a restart and continues the axis', () => {
    const tl = createBenchTimeline()
    const a = createRingBuffer(64)
    feedAll(tl, batch(0, 1, 2), [a])
    feedAll(tl, batch(3, 4), [a])
    feedAll(tl, batch(0, 1), [a]) // restart: raw time back to 0
    expect(times(a)).toEqual([0, 1, 2, 3, 4, 4, 5])
    // Values are the raw readings; the old window is still readable.
    expect(Array.from(a.readWindow(0, 3).values)).toEqual([0, 10, 20, 30])
    expect(Array.from(a.readWindow(4.5, 5).values)).toEqual([10])
  })

  it('a ring created after a restart lands on the same axis', () => {
    const tl = createBenchTimeline()
    const a = createRingBuffer(64)
    feedAll(tl, batch(0, 10, 20, 30), [a])
    feedAll(tl, batch(0, 5), [a]) // restart
    const b = createRingBuffer(64) // probe added mid-window
    feedAll(tl, batch(6, 7), [a, b])
    expect(times(b)).toEqual([36, 37])
    expect(b.newestTime).toBe(a.newestTime)
    const latest = Math.max(a.newestTime, b.newestTime)
    expect(Array.from(a.readWindow(latest - 1, latest).times)).toEqual([36, 37])
    expect(Array.from(b.readWindow(latest - 1, latest).times)).toEqual([36, 37])
  })

  it('a fresh ring fed first in the restart batch is moved onto the run axis', () => {
    const tl = createBenchTimeline()
    const a = createRingBuffer(64)
    feedAll(tl, batch(0, 10, 20, 30), [a])
    const b = createRingBuffer(64)
    feedAll(tl, batch(0, 5), [b, a]) // b (empty) is fed before a (history)
    expect(times(a)).toEqual([0, 10, 20, 30, 30, 35])
    expect(times(b)).toEqual([30, 35])
    feedAll(tl, batch(6), [b, a])
    expect(times(b)).toEqual([30, 35, 36])
    expect(a.newestTime).toBe(36)
  })

  it('a regression where every ring is empty is a fresh run at zero', () => {
    const tl = createBenchTimeline()
    const old = createRingBuffer(64)
    feedAll(tl, batch(0, 30), [old])
    feedAll(tl, batch(0, 5), [old]) // restart: offset 30
    // Fresh Run: the store drops the old rings and creates empty ones.
    const a = createRingBuffer(64)
    const b = createRingBuffer(64)
    feedAll(tl, batch(0, 1), [a, b])
    feedAll(tl, batch(2), [a, b])
    expect(times(a)).toEqual([0, 1, 2])
    expect(times(b)).toEqual([0, 1, 2])
  })

  it('one batch fed to many rings counts once, as the same array or a copy', () => {
    const tl = createBenchTimeline()
    const a = createRingBuffer(64)
    const b = createRingBuffer(64)
    const c = createRingBuffer(64)
    const first = batch(0, 1, 2)
    feedAll(tl, first, [a, b])
    feedAll(tl, batch(0, 1, 2), [c]) // an equal copy of the same batch
    const next = batch(3, 4)
    feedAll(tl, next, [a, b, c])
    for (const rb of [a, b, c]) expect(times(rb)).toEqual([0, 1, 2, 3, 4])
  })

  it('a restart batch equal to the previous batch is still a restart', () => {
    // One batch per window: the first batch after the restart repeats the
    // previous window's batch exactly.
    const tl = createBenchTimeline()
    const a = createRingBuffer(64)
    feedAll(tl, batch(0, 30), [a])
    feedAll(tl, batch(0, 30), [a])
    feedAll(tl, batch(0, 30), [a])
    expect(times(a)).toEqual([0, 30, 30, 60, 60, 90])
  })

  it('an empty batch changes nothing', () => {
    const tl = createBenchTimeline()
    const a = createRingBuffer(8)
    feedAll(tl, batch(0, 1), [a])
    feedSamples(a, new Float64Array(0), new Float64Array(0), tl)
    feedAll(tl, batch(2), [a])
    expect(times(a)).toEqual([0, 1, 2])
  })

  it('readWindow across restarts on a wrapped ring matches a linear scan', () => {
    const tl = createBenchTimeline()
    const a = createRingBuffer(50)
    // Three windows of 30 samples each (raw 0..29 us): 90 samples, wrapped.
    for (let w = 0; w < 3; w++) {
      for (let k = 0; k < 30; k += 10) {
        const t = new Float64Array(10)
        for (let i = 0; i < 10; i++) t[i] = (k + i) * 1e-6
        feedSamples(a, t, t.map((_, i) => w * 100 + k + i), tl)
      }
    }
    expect(a.length).toBe(50)
    const stored = times(a)
    for (let i = 1; i < stored.length; i++) expect(stored[i]).toBeGreaterThanOrEqual(stored[i - 1])
    const windows: [number, number][] = [
      [0, 1],
      [40e-6, 60e-6],
      [58e-6, 58e-6],
      [29e-6, 31e-6],
      [80e-6, 90e-6],
    ]
    for (const [lo, hi] of windows) {
      const got = a.readWindow(lo, hi)
      const want = linearWindow(a, lo, hi)
      expect(Array.from(got.times)).toEqual(want.times)
      expect(Array.from(got.values)).toEqual(want.values)
    }
  })
})
