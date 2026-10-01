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

  it('starts a new acquisition on a bench-window restart', () => {
    const rb = createRingBuffer(32)
    for (let i = 0; i < 10; i++) rb.append(i, i * 1e-3) // old epoch, t up to 9 ms
    expect(rb.newestTime).toBeCloseTo(9e-3, 12)
    // benchRestarted: ngspice restarts the transient at t = 0.
    rb.append(100, 0)
    rb.append(101, 1e-3)
    rb.append(102, 2e-3)
    // Stored times are raw sim times, so the old epoch is gone.
    expect(rb.length).toBe(3)
    expect(rb.newestTime).toBeCloseTo(2e-3, 12)
    expect(Array.from(rb.read(0, rb.length).values)).toEqual([100, 101, 102])
    expect(Array.from(rb.readWindow(0, 1).values)).toEqual([100, 101, 102])
  })

  it('restart works on a wrapped ring and keeps appending correctly', () => {
    const rb = createRingBuffer(4)
    for (let i = 0; i < 7; i++) rb.append(i, i) // wrapped
    rb.append(50, 0) // restart
    for (let i = 1; i < 6; i++) rb.append(50 + i, i) // wraps again
    expect(Array.from(rb.read(0, rb.length).times)).toEqual([2, 3, 4, 5])
    expect(Array.from(rb.readWindow(3, 4).values)).toEqual([53, 54])
  })

  it('a ring created after a restart agrees with rings that lived through it', () => {
    // Probe A lives through a bench-window restart; probe B is added after it
    // (syncRingBuffers creates its ring mid-run, fed raw sim time).
    const a = createRingBuffer(64)
    for (let t = 0; t <= 30; t++) a.append(t, t)
    for (let t = 0; t <= 5; t++) a.append(100 + t, t) // restart
    const b = createRingBuffer(64)
    for (let t = 0; t <= 5; t++) b.append(200 + t, t)
    expect(b.newestTime).toBe(a.newestTime)
    // Follow window anchored on the shared latest time shows both traces.
    const latest = Math.max(a.newestTime, b.newestTime)
    const wa = a.readWindow(latest - 1, latest)
    const wb = b.readWindow(latest - 1, latest)
    expect(Array.from(wa.times)).toEqual([4, 5])
    expect(Array.from(wb.times)).toEqual([4, 5])
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

  it('does not scan the whole ring: a small window on a full 1M ring is cheap', () => {
    const rb = createRingBuffer(1_000_000)
    const n = 1_200_000 // wrap once
    for (let i = 0; i < n; i++) rb.append(i, i * 1e-6)
    const tEnd = (n - 1) * 1e-6
    const frames = 60
    const t0 = performance.now()
    let points = 0
    for (let f = 0; f < frames; f++) points += rb.readWindow(tEnd - 10e-3, tEnd).times.length
    const elapsed = performance.now() - t0
    expect(points).toBeGreaterThan(0)
    // The linear scan cost about 1.5 ms per frame here (about 90 ms for 60).
    // A binary search plus a 10k-point copy is well under 1 ms per frame.
    expect(elapsed).toBeLessThan(25)
  })
})
