/**
 * src/cli/modelLibrary.ts
 *
 * Loads the bundled model library from disk for the headless CLI (issue #28):
 * the same `{ entries, texts }` the Electron main process serves over the
 * `circsim:getModelLibrary` IPC handler, read with node:fs instead.
 *
 * Every read is best-effort in the same way as the IPC handler: a referenced
 * file that is missing is omitted, so resolution still matches on the entries.
 * An unreadable or malformed index.json is an error here, though: a CLI that
 * silently audits with no library would report every part as unresolved.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { LibraryEntry } from '../core/models/types'

export interface ModelLibrary {
  entries: LibraryEntry[]
  texts: Record<string, string>
}

/**
 * Walk up from `startDir` to the directory whose package.json names "circsim".
 * Works from src/cli (vitest) and out/cli (the built bundle).
 */
export function findPackageRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }
        if (json.name === 'circsim') return dir
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** The models dir: explicit override, then CIRCSIM_MODELS_DIR, then <package root>/resources/models. */
export function resolveModelsDir(
  override: string | undefined,
  env: NodeJS.ProcessEnv,
  startDir: string,
): string {
  if (override) return override
  const fromEnv = env.CIRCSIM_MODELS_DIR
  if (fromEnv) return fromEnv
  const root = findPackageRoot(startDir)
  if (!root) {
    throw new Error('cannot locate resources/models: set CIRCSIM_MODELS_DIR or pass --models-dir')
  }
  return join(root, 'resources', 'models')
}

/** Read `<dir>/index.json` and every `.lib`/`.json` file its entries reference. */
export function loadModelLibrary(dir: string): ModelLibrary {
  const indexPath = join(dir, 'index.json')
  let indexText: string
  try {
    indexText = readFileSync(indexPath, 'utf8')
  } catch (err) {
    throw new Error(`cannot read model library index ${indexPath}: ${(err as Error).message}`)
  }
  let parsed: { entries?: unknown }
  try {
    parsed = JSON.parse(indexText) as { entries?: unknown }
  } catch (err) {
    throw new Error(`model library index ${indexPath} is not valid JSON: ${(err as Error).message}`)
  }
  const entries = Array.isArray(parsed.entries) ? (parsed.entries as LibraryEntry[]) : []

  const texts: Record<string, string> = {}
  const fileNames = new Set<string>()
  for (const e of entries) {
    const f = e.model?.file
    if (typeof f === 'string' && f.length > 0) fileNames.add(f)
  }
  for (const name of fileNames) {
    try {
      texts[name] = readFileSync(join(dir, name), 'utf8')
    } catch {
      // omitted, as the IPC handler does
    }
  }
  return { entries, texts }
}
