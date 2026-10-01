/**
 * ui/layoutPrefs.ts: center-column layout constants and remembered collapse
 * state (issue #33).
 *
 * The center column stacks the 3D viewport, the bench shelf and the bottom
 * dock. Only the viewport is the product's differentiator, so it carries a hard
 * minimum height and the shelf and dock yield space to it. Both can also be
 * collapsed to a header strip; the choice is remembered per user in
 * localStorage (every access is guarded: storage can be missing or throw).
 */

import { useCallback, useState } from 'react'

/** The board canvas never gets shorter than this (CSS px). */
export const MIN_VIEWPORT_H = 240

/** Height of the bench shelf header strip, the shelf's collapsed height (CSS px). */
export const SHELF_HEADER_H = 36

/** Height of the collapsed bottom dock strip (CSS px). */
export const DOCK_COLLAPSED_H = 26

/** Expanded bottom dock height: scales with the window, bounded either side. */
export const DOCK_HEIGHT = 'clamp(120px, 24vh, 240px)'

/** Below this window size the page scrolls instead of crushing the board. */
export const APP_MIN_WIDTH = 960
export const APP_MIN_HEIGHT = 520

export type CollapsibleRegion = 'shelf' | 'dock'

const KEY_PREFIX = 'circsim.layout.collapsed.'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Read a region's remembered collapse flag; false (expanded) when unknown. */
export function readCollapsed(region: CollapsibleRegion, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(KEY_PREFIX + region) === '1'
  } catch {
    return false
  }
}

/** Remember a region's collapse flag; silently a no-op when storage is unavailable. */
export function writeCollapsed(
  region: CollapsibleRegion,
  collapsed: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(KEY_PREFIX + region, collapsed ? '1' : '0')
  } catch {
    // quota or privacy mode: the flag just does not persist
  }
}

/** Collapse state for a region, initialised from and saved to localStorage. */
export function useCollapsed(region: CollapsibleRegion): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed(region))
  const set = useCallback(
    (next: boolean) => {
      setCollapsed(next)
      writeCollapsed(region, next)
    },
    [region],
  )
  return [collapsed, set]
}
