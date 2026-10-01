/**
 * core/models/userLibrary.ts
 *
 * Tier 4 user .lib import support: scan a directory of user-provided .lib and
 * .sub files and list the .subckt names they define.
 *
 * Imported models and their pin maps are NOT stored here. They are persisted
 * with the board in the per-board sidecar (core/persist/sidecar.ts, issue #27),
 * which is the only persistence layer; the standalone bindings JSON this file
 * used to carry had no callers and was removed with issue #17. The text a part
 * is bound to is built by core/models/libText.ts (bundleSubckt).
 *
 * File I/O here uses Node's 'node:fs', so this module is for main-process and
 * test use; the renderer works on text it is handed (libText.ts is fs-free).
 *
 * Spec 8.5 Tier 4, 8.7.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { subcktNamesInText } from './libText'

// --- Types -------------------------------------------------------------------

/** A .subckt discovered in a user's .lib or .sub file. */
export interface UserSubckt {
  /** The .subckt name as declared in the file (case-preserved). */
  name: string
  /** The file path where the subckt is defined. */
  filePath: string
}

// --- Scanning ----------------------------------------------------------------

/**
 * Scan a directory for .lib and .sub files and extract .subckt names.
 *
 * @param userDir  Absolute path to the user's model directory.
 * @returns Array of UserSubckt entries found.
 */
export function scanUserDir(userDir: string): UserSubckt[] {
  if (!existsSync(userDir)) return []

  const results: UserSubckt[] = []
  let entries: string[]

  try {
    entries = readdirSync(userDir)
  } catch {
    return []
  }

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase()
    if (ext !== '.lib' && ext !== '.sub') continue

    const filePath = join(userDir, entry)
    let text: string
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    for (const name of subcktNamesInText(text)) results.push({ name, filePath })
  }

  return results
}

/**
 * Read a single .lib or .sub file and return all .subckt names defined in it.
 *
 * @param filePath  Absolute path to the file.
 * @returns Array of subckt names (case-preserved).
 */
export function extractSubcktNames(filePath: string): string[] {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  return subcktNamesInText(text)
}
