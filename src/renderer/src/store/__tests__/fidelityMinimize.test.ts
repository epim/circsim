/**
 * fidelityMinimize.test.ts — Gemini finding 4 (banner blindness).
 *
 * The fidelity banner can be MINIMIZED to a badge, never dismissed. Minimize
 * is purely derivational: the store keeps the signature of the problem set at
 * minimize time; any change to that set (new part, mode change, resolution)
 * changes the signature → isFidelityMinimized flips false → banner re-expands
 * with no subscription or effect.
 */

import { describe, it, expect } from 'vitest'
import {
  createAppStore,
  fidelityBannerItems,
  fidelitySignature,
  isFidelityMinimized,
} from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Resolution } from '../../../../core/models/types'

function unresolved(ref: string): Resolution {
  return { ref, status: 'unresolved', tier: 6, warnings: [] }
}

describe('fidelitySignature', () => {
  it('is order-independent', () => {
    const a = [
      { ref: 'U1', mode: 'unresolved' },
      { ref: 'U2', mode: 'stubbed (open)' },
    ]
    const b = [a[1], a[0]]
    expect(fidelitySignature(a)).toBe(fidelitySignature(b))
  })

  it('is sensitive to mode changes on the same ref', () => {
    expect(fidelitySignature([{ ref: 'U1', mode: 'unresolved' }])).not.toBe(
      fidelitySignature([{ ref: 'U1', mode: 'stubbed (open)' }]),
    )
  })
})

describe('isFidelityMinimized', () => {
  const items = [{ ref: 'U1', mode: 'unresolved' }]

  it('false when never minimized (sig null)', () => {
    expect(isFidelityMinimized(items, null)).toBe(false)
  })

  it('true while the problem set matches the minimized signature', () => {
    expect(isFidelityMinimized(items, fidelitySignature(items))).toBe(true)
  })

  it('false when the problem set grows (auto re-expand)', () => {
    const sig = fidelitySignature(items)
    expect(isFidelityMinimized([...items, { ref: 'U2', mode: 'unresolved' }], sig)).toBe(false)
  })

  it('false when an item changes mode (auto re-expand)', () => {
    const sig = fidelitySignature(items)
    expect(isFidelityMinimized([{ ref: 'U1', mode: 'stubbed (open)' }], sig)).toBe(false)
  })
})

describe('minimizeFidelityBanner action', () => {
  it('defaults to expanded and stores the live signature on minimize', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    expect(store.getState().fidelityMinimizedSig).toBeNull()

    store.setState({ resolutions: [unresolved('U1'), unresolved('U2')] })
    store.getState().minimizeFidelityBanner()

    const items = fidelityBannerItems(store.getState().resolutions)
    expect(store.getState().fidelityMinimizedSig).toBe(fidelitySignature(items))
    expect(isFidelityMinimized(items, store.getState().fidelityMinimizedSig)).toBe(true)
  })
})
