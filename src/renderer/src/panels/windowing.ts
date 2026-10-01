/**
 * renderer/panels/windowing.ts (issue #72)
 *
 * Pure range math for windowed (virtualized) lists. Rows have known heights, so
 * no measuring is needed: `computeOffsets` builds the prefix sums once, and
 * `computeWindow` binary-searches them for the rows that intersect the viewport.
 * No React, no DOM: unit-tested directly.
 */

/** Prefix sums of row heights: offsets[i] is row i's top, offsets[n] the total. */
export function computeOffsets(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1)
  out[0] = 0
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i]
  return out
}

export interface WindowRange {
  /** First rendered row index. */
  start: number
  /** One past the last rendered row index. */
  end: number
  /** Height of the spacer standing in for rows [0, start). */
  padTop: number
  /** Height of the spacer standing in for rows [end, n). */
  padBottom: number
}

/** Index of the row containing `y` (the last row whose top is <= y), clamped. */
function rowAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Rows that intersect [scrollTop, scrollTop + viewportHeight), widened by
 * `overscan` rows on each side so a fast scroll never shows a blank gap.
 */
export function computeWindow(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): WindowRange {
  const n = offsets.length - 1
  if (n <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  const total = offsets[n]
  const top = Math.max(0, Math.min(scrollTop, total))
  const firstVisible = rowAt(offsets, top)
  // First row whose top is at or below the viewport's bottom edge.
  const bottom = top + viewportHeight
  let endVisible = n
  if (bottom < total) {
    endVisible = rowAt(offsets, bottom)
    if (offsets[endVisible] < bottom) endVisible += 1
  }
  const start = Math.max(0, firstVisible - overscan)
  const end = Math.min(n, endVisible + overscan)
  return { start, end, padTop: offsets[start], padBottom: total - offsets[end] }
}

/**
 * The smallest scrollTop change that makes row `index` fully visible: unchanged
 * when it already is, otherwise row-at-top (it was above) or row-at-bottom (it
 * was below).
 */
export function scrollTopToReveal(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const top = offsets[index]
  const bottom = offsets[index + 1]
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight)
  return scrollTop
}
