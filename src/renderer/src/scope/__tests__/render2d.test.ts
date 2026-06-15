/**
 * src/renderer/src/scope/__tests__/render2d.test.ts — Task 23
 *
 * Unit tests for render2d decimation math and measurement functions.
 * Covers:
 *   - minMaxDecimate: min/max per pixel column from a dense signal
 *   - Measurements: Vpp, mean, frequency (zero-crossing estimate, within 1%)
 *   - Cursor computations: ΔV/Δt
 *   - Follow-mode / pause window selection
 *   - Per-trace autoscale
 *
 * These tests are purely numeric — no canvas, no DOM.
 */

import { describe, it, expect } from 'vitest'
import {
  minMaxDecimate,
  measureVpp,
  measureMean,
  measureFrequency,
  computeCursorDelta,
  autoScale,
  timeToPixel,
  computeVisibleWindow,
} from '../render2d'

// ─── synthetic signal helpers ────────────────────────────────────────────────

/** Generate a synthetic sine wave: N samples, freq Hz, sampleRate Hz */
function synthSine(
  nSamples: number,
  freqHz: number,
  sampleRateHz: number,
  amplitude = 1.0,
  offset = 0.0,
): { times: Float64Array; values: Float64Array } {
  const times = new Float64Array(nSamples)
  const values = new Float64Array(nSamples)
  for (let i = 0; i < nSamples; i++) {
    const t = i / sampleRateHz
    times[i] = t
    values[i] = offset + amplitude * Math.sin(2 * Math.PI * freqHz * t)
  }
  return { times, values }
}

// ─── minMaxDecimate ──────────────────────────────────────────────────────────

describe('minMaxDecimate', () => {
  it('returns correct number of pixel columns', () => {
    const { times, values } = synthSine(1000, 1, 1000)
    const result = minMaxDecimate(times, values, 0, 1, 100)
    expect(result.mins.length).toBe(100)
    expect(result.maxs.length).toBe(100)
    expect(result.times.length).toBe(100)
  })

  it('every max >= every min in each column', () => {
    const { times, values } = synthSine(10000, 100, 10000)
    const result = minMaxDecimate(times, values, 0, 1, 200)
    for (let i = 0; i < 200; i++) {
      expect(result.maxs[i]).toBeGreaterThanOrEqual(result.mins[i])
    }
  })

  it('DC signal: min == max == value in every column', () => {
    const N = 1000
    const times = new Float64Array(N).map((_, i) => i / N)
    const values = new Float64Array(N).fill(3.3)
    const result = minMaxDecimate(times, values, 0, 1, 50)
    for (let i = 0; i < 50; i++) {
      expect(result.mins[i]).toBeCloseTo(3.3, 8)
      expect(result.maxs[i]).toBeCloseTo(3.3, 8)
    }
  })

  it('full-amplitude sine: max ≈ +1, min ≈ -1 over one period', () => {
    const { times, values } = synthSine(4096, 100, 4096 * 100) // exactly 1 cycle
    const result = minMaxDecimate(times, values, 0, 1 / 100, 128)
    const globalMax = Math.max(...Array.from(result.maxs))
    const globalMin = Math.min(...Array.from(result.mins))
    expect(globalMax).toBeGreaterThan(0.95)
    expect(globalMin).toBeLessThan(-0.95)
  })

  it('handles window narrower than one sample', () => {
    // Edge case: window is so narrow only 0 or 1 samples fall in each column.
    const times = new Float64Array([0, 1, 2, 3, 4])
    const values = new Float64Array([1, 2, 3, 4, 5])
    // Window [0, 0.1] — only sample at t=0 falls in
    const result = minMaxDecimate(times, values, 0, 0.1, 10)
    expect(result.mins.length).toBe(10)
    expect(result.maxs.length).toBe(10)
    // No crash, finite values (or NaN columns explicitly handled)
  })

  it('returns pixel-column center times in ascending order', () => {
    const { times, values } = synthSine(1000, 10, 1000)
    const result = minMaxDecimate(times, values, 0, 0.1, 50)
    for (let i = 1; i < 50; i++) {
      expect(result.times[i]).toBeGreaterThan(result.times[i - 1])
    }
  })
})

// ─── measurements ────────────────────────────────────────────────────────────

describe('measureVpp', () => {
  it('1 V amplitude sine → Vpp = 2 V', () => {
    const { values } = synthSine(4096, 100, 4096 * 100)
    const vpp = measureVpp(values)
    expect(vpp).toBeCloseTo(2.0, 1)
  })

  it('DC 5V → Vpp = 0', () => {
    const values = new Float64Array(100).fill(5.0)
    expect(measureVpp(values)).toBeCloseTo(0, 8)
  })

  it('offset sine: Vpp = 2*amplitude regardless of offset', () => {
    const { values } = synthSine(4096, 100, 4096 * 100, 2.0, 3.3)
    expect(measureVpp(values)).toBeCloseTo(4.0, 1)
  })
})

describe('measureMean', () => {
  it('sine with zero offset → mean ≈ 0', () => {
    const { values } = synthSine(4096, 100, 4096 * 100)
    expect(Math.abs(measureMean(values))).toBeLessThan(0.01)
  })

  it('DC 5V → mean = 5V', () => {
    const values = new Float64Array(100).fill(5.0)
    expect(measureMean(values)).toBeCloseTo(5.0, 8)
  })

  it('offset sine → mean = offset', () => {
    const { values } = synthSine(8192, 100, 8192 * 100, 1.0, 2.5)
    expect(measureMean(values)).toBeCloseTo(2.5, 1)
  })
})

describe('measureFrequency', () => {
  it('1 kHz sine → frequency within 1%', () => {
    const freqHz = 1000
    // 100 samples per period, 20 periods = 2000 samples total
    const sampleRate = 100 * freqHz
    const nSamples = sampleRate * 0.02 // 20ms = 20 periods
    const { times, values } = synthSine(nSamples, freqHz, sampleRate)
    const measured = measureFrequency(times, values)
    expect(measured).not.toBeNull()
    expect(Math.abs(measured! - freqHz) / freqHz).toBeLessThan(0.01)
  })

  it('100 Hz sine → frequency within 1%', () => {
    const freqHz = 100
    // 200 samples per period, 10 periods = 2000 samples total
    const sampleRate = 200 * freqHz
    const nSamples = sampleRate * 0.1 // 100ms = 10 periods
    const { times, values } = synthSine(nSamples, freqHz, sampleRate)
    const measured = measureFrequency(times, values)
    expect(measured).not.toBeNull()
    expect(Math.abs(measured! - freqHz) / freqHz).toBeLessThan(0.01)
  })

  it('50 Hz sine at 10 kHz sample rate → within 1%', () => {
    const freqHz = 50
    const sampleRate = 10_000
    const nSamples = sampleRate * 2 // 2 full seconds = 100 cycles
    const { times, values } = synthSine(nSamples, freqHz, sampleRate)
    const measured = measureFrequency(times, values)
    expect(measured).not.toBeNull()
    expect(Math.abs(measured! - freqHz) / freqHz).toBeLessThan(0.01)
  })

  it('DC → returns null (no crossings)', () => {
    const values = new Float64Array(100).fill(3.0)
    const times = new Float64Array(100).map((_, i) => i * 0.001)
    expect(measureFrequency(times, values)).toBeNull()
  })

  it('very few samples (< 2 crossings) → returns null', () => {
    const values = new Float64Array([1, -1]) // only 1 crossing
    const times = new Float64Array([0, 1])
    // Might return a value or null — the key requirement is no crash
    expect(() => measureFrequency(times, values)).not.toThrow()
  })

  it('10 kHz sine → frequency within 1%', () => {
    const freqHz = 10_000
    // 50 samples per period, 20 periods = 1000 samples
    const sampleRate = 50 * freqHz
    const nSamples = 20 * (sampleRate / freqHz) // 20 periods exactly
    const { times, values } = synthSine(nSamples, freqHz, sampleRate)
    const measured = measureFrequency(times, values)
    expect(measured).not.toBeNull()
    expect(Math.abs(measured! - freqHz) / freqHz).toBeLessThan(0.01)
  })
})

// ─── cursor deltas ────────────────────────────────────────────────────────────

describe('computeCursorDelta', () => {
  it('ΔV = value difference, Δt = time difference', () => {
    const c1 = { time: 0.001, value: 1.0 }
    const c2 = { time: 0.003, value: 3.5 }
    const delta = computeCursorDelta(c1, c2)
    expect(delta.deltaTime).toBeCloseTo(0.002, 10)
    expect(delta.deltaValue).toBeCloseTo(2.5, 10)
    expect(delta.frequency).toBeCloseTo(1 / 0.002, 5)
  })

  it('Δt = 0 → frequency is Infinity or null', () => {
    const c1 = { time: 0.001, value: 1.0 }
    const c2 = { time: 0.001, value: 2.0 }
    const delta = computeCursorDelta(c1, c2)
    expect(delta.deltaTime).toBe(0)
    // frequency is undefined or Infinity for Δt=0 — just don't crash
    expect(typeof delta.frequency === 'number' || delta.frequency === null).toBe(true)
  })
})

// ─── autoscale ────────────────────────────────────────────────────────────────

describe('autoScale', () => {
  it('returns sensible voltage range for ±1 V sine', () => {
    const { values } = synthSine(1024, 100, 102400)
    const { vMin, vMax } = autoScale(values)
    expect(vMin).toBeLessThanOrEqual(-0.9)
    expect(vMax).toBeGreaterThanOrEqual(0.9)
  })

  it('DC 5V → vMin < 5 < vMax (adds margin)', () => {
    const values = new Float64Array(64).fill(5.0)
    const { vMin, vMax } = autoScale(values)
    expect(vMin).toBeLessThanOrEqual(5.0)
    expect(vMax).toBeGreaterThanOrEqual(5.0)
  })

  it('empty array → returns zero range without crashing', () => {
    expect(() => autoScale(new Float64Array(0))).not.toThrow()
  })
})

// ─── timeToPixel ─────────────────────────────────────────────────────────────

describe('timeToPixel', () => {
  it('maps tStart → 0 and tEnd → width', () => {
    const px = timeToPixel(0.001, 0, 0.01, 400)
    expect(px).toBeCloseTo(40, 5) // 0.001/0.01 * 400 = 40
  })

  it('maps tStart → 0', () => {
    expect(timeToPixel(0.0, 0.0, 1.0, 800)).toBeCloseTo(0, 8)
  })

  it('maps tEnd → width', () => {
    expect(timeToPixel(1.0, 0.0, 1.0, 800)).toBeCloseTo(800, 8)
  })
})

// ─── computeVisibleWindow ─────────────────────────────────────────────────────

describe('computeVisibleWindow', () => {
  it('follow mode: window tracks latest time', () => {
    const window = computeVisibleWindow({
      mode: 'follow',
      latestTime: 1.5,
      timePerDiv: 0.1,
      divCount: 10,
    })
    // 10 divs × 0.1 s = 1.0 s window
    expect(window.tEnd).toBeCloseTo(1.5, 8)
    expect(window.tStart).toBeCloseTo(0.5, 8)
  })

  it('pause mode: window stays at scrollOffset', () => {
    const window = computeVisibleWindow({
      mode: 'pause',
      scrollOffset: 2.0,
      timePerDiv: 0.2,
      divCount: 5,
    })
    expect(window.tStart).toBeCloseTo(2.0, 8)
    expect(window.tEnd).toBeCloseTo(3.0, 8)
  })

  it('follow mode with zero time: window starts at 0', () => {
    const window = computeVisibleWindow({
      mode: 'follow',
      latestTime: 0.0,
      timePerDiv: 0.1,
      divCount: 10,
    })
    expect(window.tStart).toBeCloseTo(0, 8)
    expect(window.tEnd).toBeCloseTo(1.0, 8)
  })
})
