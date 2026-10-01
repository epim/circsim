/**
 * renderer/panels/WindowedList.tsx (issue #72)
 *
 * A dependency-free windowed list for the long panels (Parts, Net Voltages).
 * Rows have caller-supplied fixed heights, so only the rows that intersect the
 * viewport (plus a little overscan) are mounted; the rest are two spacer divs.
 * Up to `threshold` items it renders everything with no spacers, so the small
 * boards the app is mostly used on keep a plain DOM.
 *
 * The caller owns row styling and MUST give each row exactly its declared
 * height (explicit `height`, `boxSizing: 'border-box'`, `overflow: 'hidden'`).
 * `revealIndex` + `revealNonce` scroll a row into view when the selection
 * changes from outside the list (a click on the board).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { computeOffsets, computeWindow, scrollTopToReveal } from './windowing'

export interface WindowedListProps<T> {
  items: readonly T[]
  /** Height in px of each item; same length as `items`. */
  heights: readonly number[]
  renderItem: (item: T, index: number) => React.ReactNode
  itemKey: (item: T, index: number) => string | number
  /** Render everything (no windowing) at or below this many items. */
  threshold?: number
  overscan?: number
  /** Scroll this item into view whenever `revealNonce` changes. */
  revealIndex?: number | null
  revealNonce?: unknown
  /** Scroll container style (needs a bounded height to scroll). */
  style?: React.CSSProperties
  testId?: string
}

/** Used for the first paint and in non-DOM renders, before the container is measured. */
const DEFAULT_VIEWPORT_PX = 480

export default function WindowedList<T>({
  items,
  heights,
  renderItem,
  itemKey,
  threshold = 100,
  overscan = 8,
  revealIndex = null,
  revealNonce,
  style,
  testId,
}: WindowedListProps<T>): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT_PX)
  const windowed = items.length > threshold

  const offsets = useMemo(() => computeOffsets(heights), [heights])

  // Track the container's real height (dock resizes, window resizes).
  useEffect(() => {
    const el = ref.current
    if (!el || !windowed) return
    const measure = (): void => {
      if (el.clientHeight > 0) setViewport(el.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [windowed])

  // Bring an externally selected row into view.
  useEffect(() => {
    const el = ref.current
    if (!el || !windowed || revealIndex === null || revealIndex < 0) return
    if (revealIndex >= items.length) return
    const next = scrollTopToReveal(offsets, revealIndex, el.scrollTop, el.clientHeight || viewport)
    if (next !== el.scrollTop) {
      el.scrollTop = next
      setScrollTop(next)
    }
    // Only a new reveal request should scroll; items/offsets changing must not.
  }, [revealNonce])

  const range = windowed
    ? computeWindow(offsets, scrollTop, viewport, overscan)
    : { start: 0, end: items.length, padTop: 0, padBottom: 0 }

  const rows: React.ReactNode[] = []
  for (let i = range.start; i < range.end; i++) {
    rows.push(<React.Fragment key={itemKey(items[i], i)}>{renderItem(items[i], i)}</React.Fragment>)
  }

  return (
    <div
      ref={ref}
      style={style}
      data-testid={testId}
      data-windowed={windowed || undefined}
      onScroll={windowed ? e => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop) : undefined}
    >
      {range.padTop > 0 && <div style={{ height: range.padTop }} aria-hidden />}
      {rows}
      {range.padBottom > 0 && <div style={{ height: range.padBottom }} aria-hidden />}
    </div>
  )
}
