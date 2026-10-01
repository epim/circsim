/**
 * src/main/readPolicy.ts (issue #37)
 *
 * Which files the renderer may read through the `circsim:readFile` and
 * `circsim:fileExists` IPC channels. Before this, both took any string and read
 * it, so a compromised renderer could read the whole user profile through a
 * sanctioned channel.
 *
 * The rule is "only what the user pointed at": a path becomes readable when it
 *   - came back from the native open dialog,
 *   - was dropped on the window (the preload registers it from webUtils),
 *   - is in the saved recent-boards list (written by main), or
 *   - is one of the bundled sample boards.
 * Granting a file also makes its directory's board-adjacent files readable (the
 * sibling .kicad_sch, a BOM .csv, SPICE .lib files), because opening a board
 * reads those without a second dialog. Nothing else: not other extensions, not
 * subdirectories, not a path that only reaches a granted directory through `..`.
 *
 * Pure Node `path` logic with no Electron import, so it is unit tested directly.
 * Symlinks are not resolved: a link inside a directory the user chose is the
 * user's own arrangement.
 */

import * as nodePath from 'path'

/** Largest file the renderer may read in one call (a very large board is tens of MB). */
export const MAX_READ_BYTES = 128 * 1024 * 1024

/** Longest path accepted; longer is rejected before any filesystem call. */
const MAX_PATH_CHARS = 4096

/** Extensions readable next to a granted file (the board's own companions). */
export const SIBLING_EXTENSIONS: ReadonlySet<string> = new Set([
  '.kicad_pcb',
  '.kicad_sch',
  '.csv',
  '.lib',
  '.sub',
  '.cir',
])

export class ReadGrants {
  private readonly files = new Set<string>()
  private readonly siblingDirs = new Set<string>()

  /**
   * @param pathApi   Node `path` flavor; tests pass `path.win32` or `path.posix`.
   * @param foldCase  Compare paths case-insensitively (Windows, macOS default).
   */
  constructor(
    private readonly pathApi: typeof nodePath.posix = nodePath,
    private readonly foldCase: boolean = process.platform === 'win32' || process.platform === 'darwin',
  ) {}

  private key(p: string): string {
    const r = this.pathApi.resolve(p)
    return this.foldCase ? r.toLowerCase() : r
  }

  /** Validate the shape of a renderer-supplied path; null when it is unusable. */
  private normalize(p: unknown): string | null {
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_CHARS) return null
    if (p.includes('\0')) return null
    if (!this.pathApi.isAbsolute(p)) return null
    return p
  }

  /**
   * Make `p` readable, plus the board-adjacent files in its directory. Returns
   * false (and grants nothing) for a value that is not an absolute path string.
   */
  grantFile(p: unknown): boolean {
    const ok = this.normalize(p)
    if (!ok) return false
    this.files.add(this.key(ok))
    this.siblingDirs.add(this.key(this.pathApi.dirname(this.pathApi.resolve(ok))))
    return true
  }

  /** True when the renderer may read (or probe) `p`. */
  canRead(p: unknown): boolean {
    const ok = this.normalize(p)
    if (!ok) return false
    const resolved = this.pathApi.resolve(ok)
    if (this.files.has(this.key(resolved))) return true
    const ext = this.pathApi.extname(resolved).toLowerCase()
    return SIBLING_EXTENSIONS.has(ext) && this.siblingDirs.has(this.key(this.pathApi.dirname(resolved)))
  }

  /**
   * Throw unless the renderer may read `p`. The message names the rule rather
   * than echoing the path back, since the path came from the renderer.
   */
  assertReadable(p: unknown): string {
    if (!this.canRead(p)) {
      throw new Error(
        'This file was not opened in this session. Open it with the Open button or drop it on the window.',
      )
    }
    return p as string
  }
}

/**
 * Reduce renderer-supplied open-dialog options to the few fields the app uses,
 * so the renderer cannot steer the dialog to a directory picker or a preset
 * location. Always a file picker; multi-select is kept only when asked for.
 */
export function sanitizeOpenDialogOptions(opts: unknown): {
  title?: string
  filters?: { name: string; extensions: string[] }[]
  properties: ('openFile' | 'multiSelections')[]
} {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
  const out: {
    title?: string
    filters?: { name: string; extensions: string[] }[]
    properties: ('openFile' | 'multiSelections')[]
  } = { properties: ['openFile'] }
  if (typeof o['title'] === 'string') out.title = o['title'].slice(0, 200)
  if (Array.isArray(o['filters'])) {
    const filters: { name: string; extensions: string[] }[] = []
    for (const f of o['filters'].slice(0, 10)) {
      if (!f || typeof f !== 'object') continue
      const name = (f as { name?: unknown }).name
      const ext = (f as { extensions?: unknown }).extensions
      if (typeof name !== 'string' || !Array.isArray(ext)) continue
      const extensions = ext.filter((e): e is string => typeof e === 'string' && e.length <= 32).slice(0, 20)
      filters.push({ name: name.slice(0, 100), extensions })
    }
    if (filters.length > 0) out.filters = filters
  }
  if (Array.isArray(o['properties']) && o['properties'].includes('multiSelections')) {
    out.properties.push('multiSelections')
  }
  return out
}
