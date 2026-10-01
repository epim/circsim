import { describe, it, expect } from 'vitest'
import {
  MIN_VIEWPORT_H, SHELF_HEADER_H, DOCK_COLLAPSED_H, APP_MIN_HEIGHT,
  readCollapsed, writeCollapsed,
} from '../layoutPrefs'

function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
  }
}

describe('layoutPrefs collapse persistence (#33)', () => {
  it('defaults to expanded when nothing is stored', () => {
    expect(readCollapsed('shelf', fakeStorage())).toBe(false)
    expect(readCollapsed('dock', fakeStorage())).toBe(false)
  })

  it('round-trips each region independently', () => {
    const s = fakeStorage()
    writeCollapsed('shelf', true, s)
    expect(readCollapsed('shelf', s)).toBe(true)
    expect(readCollapsed('dock', s)).toBe(false)
    writeCollapsed('shelf', false, s)
    expect(readCollapsed('shelf', s)).toBe(false)
  })

  it('survives missing or throwing storage', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readCollapsed('dock', null)).toBe(false)
    expect(readCollapsed('dock', throwing)).toBe(false)
    expect(() => writeCollapsed('dock', true, null)).not.toThrow()
    expect(() => writeCollapsed('dock', true, throwing)).not.toThrow()
  })
})

describe('layout budget (#33)', () => {
  it('the page minimum height leaves room for header chrome, the board minimum, the shelf strip and the dock strip', () => {
    // Header (~48) + toolbar (~40) + warnings slack: generous 100 px of chrome.
    const chrome = 100
    expect(APP_MIN_HEIGHT).toBeGreaterThanOrEqual(chrome + MIN_VIEWPORT_H + SHELF_HEADER_H + DOCK_COLLAPSED_H)
  })
})
