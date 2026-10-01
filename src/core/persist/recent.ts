/**
 * core/persist/recent.ts
 *
 * Pure recent-boards list logic. The main process keeps the list in a JSON file
 * under userData; this module normalizes whatever is read from it (so a corrupt
 * or hand-edited file can never break the start screen) and applies additions.
 *
 * Most-recent first, de-duplicated (`/` and `\` separators compare equal, the
 * rest is an exact match), capped at MAX_RECENT. Only `.kicad_pcb` paths are
 * kept.
 */

import { isBoardPath } from './paths'

export const MAX_RECENT = 10

function key(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Coerce arbitrary parsed JSON into a clean list of board paths. */
export function normalizeRecent(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { boards?: unknown }).boards)
      ? (raw as { boards: unknown[] }).boards
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string' || item.length > 4096 || !isBoardPath(item)) continue
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
    if (out.length >= MAX_RECENT) break
  }
  return out
}

/** Put `path` at the front of the list (moving it if present). Non-board paths are ignored. */
export function addRecent(list: string[], path: string): string[] {
  if (typeof path !== 'string' || !isBoardPath(path)) return list
  const k = key(path)
  return [path, ...list.filter(p => key(p) !== k)].slice(0, MAX_RECENT)
}

/** Remove one path from the list. */
export function removeRecent(list: string[], path: string): string[] {
  const k = key(path)
  return list.filter(p => key(p) !== k)
}
