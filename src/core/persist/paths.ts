/**
 * core/persist/paths.ts
 *
 * Path helpers for the per-board sidecar file. Plain string operations (no node
 * `path`), so they work in the renderer, the main process and tests, for both
 * `/` and `\` separated paths.
 *
 * The sidecar lives beside the board and is named after it:
 *   C:\work\blinker.kicad_pcb  ->  C:\work\blinker.circsim.json
 *
 * circsim never writes to the board file itself; the sidecar is the only file it
 * creates next to a user's project.
 */

export const BOARD_EXT = '.kicad_pcb'
export const SIDECAR_SUFFIX = '.circsim.json'

/** True when the path names a KiCad board file (case-insensitive extension). */
export function isBoardPath(path: string): boolean {
  return typeof path === 'string' && path.toLowerCase().endsWith(BOARD_EXT) && path.length > BOARD_EXT.length
}

/** True when the path names a circsim sidecar file. */
export function isSidecarPath(path: string): boolean {
  return typeof path === 'string' && path.toLowerCase().endsWith(SIDECAR_SUFFIX) && path.length > SIDECAR_SUFFIX.length
}

/**
 * The sidecar path for a board path, or null when `boardPath` is not a
 * `.kicad_pcb` path (so a caller can never derive a sidecar name, and therefore
 * never write, for an arbitrary file).
 */
export function sidecarPathFor(boardPath: string): string | null {
  if (!isBoardPath(boardPath)) return null
  return boardPath.slice(0, boardPath.length - BOARD_EXT.length) + SIDECAR_SUFFIX
}

/** Final path component, using `/` or `\` as separators. */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}
