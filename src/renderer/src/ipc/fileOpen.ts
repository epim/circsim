/**
 * renderer/ipc/fileOpen.ts — Task 21
 *
 * The file-open flow glue (Spec §12). Reads a `.kicad_pcb`, auto-detects a
 * sibling `.kicad_sch` by basename, and optionally pairs a dropped BOM CSV.
 * Produces the text payloads the store's `openBoardFromText` consumes.
 *
 * Path handling is done with plain string ops (no node `path` in the renderer);
 * both `/` and `\` separators are handled so it works for Windows + POSIX paths
 * returned by the main-process dialog.
 *
 * The actual disk reads go through `window.circsim.readFile` (contextBridge).
 * For unit-testability the `readFile` dependency is injectable.
 */

export interface OpenedProject {
  boardFileName: string
  boardText: string
  schematicFileName?: string
  schematicText?: string
  bomText?: string
}

export type ReadFileFn = (path: string) => Promise<string>
/** Stat-based existence probe (window.circsim.fileExists) — never throws in prod. */
export type FileExistsFn = (path: string) => Promise<boolean>

/** Split an absolute path into { dir, base, name, ext } using `/` or `\`. */
export function splitPath(p: string): { dir: string; base: string; name: string; ext: string } {
  const sepIdx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const dir = sepIdx >= 0 ? p.slice(0, sepIdx) : ''
  const base = sepIdx >= 0 ? p.slice(sepIdx + 1) : p
  const dotIdx = base.lastIndexOf('.')
  const name = dotIdx > 0 ? base.slice(0, dotIdx) : base
  const ext = dotIdx > 0 ? base.slice(dotIdx) : ''
  return { dir, base, name, ext }
}

/** Pick the separator style a path uses (prefer `\` only when no `/` present). */
function detectSep(p: string): string {
  if (p.includes('/')) return '/'
  if (p.includes('\\')) return '\\'
  return '/'
}

/** Join a dir + filename with the dir's separator style. */
export function joinPath(dir: string, fileName: string): string {
  if (!dir) return fileName
  const sep = detectSep(dir)
  return dir.endsWith(sep) ? dir + fileName : dir + sep + fileName
}

/** Derive the sibling .kicad_sch absolute path for a given .kicad_pcb path. */
export function siblingSchematicPath(boardPath: string): string {
  const { dir, name } = splitPath(boardPath)
  return joinPath(dir, `${name}.kicad_sch`)
}

/**
 * Probe an OPTIONAL sidecar for existence before reading it. With no
 * `fileExists` injected (legacy callers/tests) we fall back to probe-by-read;
 * a probe that itself fails also falls back to the read attempt, so a flaky
 * stat can never hide a file that a read would have found.
 */
async function optionalSidecarExists(
  fileExists: FileExistsFn | undefined,
  path: string,
): Promise<boolean> {
  if (!fileExists) return true
  try {
    return await fileExists(path)
  } catch {
    return true
  }
}

/**
 * Open a project from a board path: read the board text (REQUIRED — a read
 * failure rejects loudly), then attempt the sibling schematic (best-effort — a
 * missing .kicad_sch is fine). An optional BOM path is read if provided.
 *
 * Optional sidecars are probed with `fileExists` (when supplied) BEFORE being
 * read: probing by readFile made the main process log a full ENOENT handler
 * stack on every board open without a sibling schematic.
 */
export async function openProjectFromPath(
  boardPath: string,
  readFile: ReadFileFn,
  bomPath?: string,
  fileExists?: FileExistsFn,
): Promise<OpenedProject> {
  const boardText = await readFile(boardPath)
  const { base } = splitPath(boardPath)

  const result: OpenedProject = { boardFileName: base, boardText }

  // Sibling .kicad_sch (best-effort).
  const schPath = siblingSchematicPath(boardPath)
  if (await optionalSidecarExists(fileExists, schPath)) {
    try {
      const schText = await readFile(schPath)
      result.schematicText = schText
      result.schematicFileName = splitPath(schPath).base
    } catch {
      // No sibling schematic — fine. Resolution proceeds with primitive inference.
    }
  }

  if (bomPath && (await optionalSidecarExists(fileExists, bomPath))) {
    try {
      result.bomText = await readFile(bomPath)
    } catch {
      // BOM optional — ignore read failure.
    }
  }

  return result
}

/** Classify a dropped/selected file path by extension. */
export function classifyFile(path: string): 'board' | 'schematic' | 'bom' | 'unknown' {
  const ext = splitPath(path).ext.toLowerCase()
  if (ext === '.kicad_pcb') return 'board'
  if (ext === '.kicad_sch') return 'schematic'
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return 'bom'
  return 'unknown'
}
