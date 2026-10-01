/**
 * windowing.test.ts: the pure range math behind WindowedList (issue #72).
 */

import { describe, it, expect } from 'vitest'
import { computeOffsets, computeWindow, scrollTopToReveal } from '../windowing'

describe('computeOffsets', () => {
  it('returns prefix sums with a leading 0 and the total last', () => {
    expect(computeOffsets([10, 20, 5])).toEqual([0, 10, 30, 35])
    expect(computeOffsets([])).toEqual([0])
  })
})

describe('computeWindow', () => {
  const offsets = computeOffsets(Array.from({ length: 1000 }, () => 20)) // 20 000 px

  it('at the top renders only the first screenful plus overscan', () => {
    const w = computeWindow(offsets, 0, 200, 3)
    expect(w.start).toBe(0)
    expect(w.end).toBe(13) // 10 visible rows + 3 overscan
    expect(w.padTop).toBe(0)
    expect(w.padBottom).toBe(20000 - 13 * 20)
  })

  it('mid-list keeps spacers equal to the skipped rows', () => {
    const w = computeWindow(offsets, 5000, 200, 2)
    // row 250 is the first fully visible row; 2 overscan above
    expect(w.start).toBe(248)
    expect(w.end).toBe(250 + 10 + 2)
    expect(w.padTop).toBe(248 * 20)
    expect(w.padTop + (w.end - w.start) * 20 + w.padBottom).toBe(20000)
  })

  it('clamps at the bottom', () => {
    const w = computeWindow(offsets, 999999, 200, 5)
    expect(w.end).toBe(1000)
    expect(w.padBottom).toBe(0)
    expect(w.start).toBeLessThan(1000)
  })

  it('handles variable heights', () => {
    const o = computeOffsets([30, 20, 20, 60, 20])
    const w = computeWindow(o, 55, 30, 0)
    // scrollTop 55 sits inside row 2 (offsets 50..70); viewport ends at 85 (row 3 spans 70..130)
    expect(w.start).toBe(2)
    expect(w.end).toBe(4)
  })

  it('an empty list yields an empty range', () => {
    const w = computeWindow(computeOffsets([]), 0, 100, 3)
    expect(w).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })
})

describe('scrollTopToReveal', () => {
  const offsets = computeOffsets(Array.from({ length: 100 }, () => 20))

  it('leaves scrollTop alone when the row is already fully visible', () => {
    expect(scrollTopToReveal(offsets, 5, 0, 200)).toBe(0)
  })

  it('scrolls up so a row above the viewport lands at the top', () => {
    expect(scrollTopToReveal(offsets, 2, 500, 200)).toBe(40)
  })

  it('scrolls down so a row below the viewport lands at the bottom edge', () => {
    expect(scrollTopToReveal(offsets, 50, 0, 200)).toBe(51 * 20 - 200)
  })
})
