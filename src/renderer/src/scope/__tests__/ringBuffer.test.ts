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
