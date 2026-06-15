/**
 * core/models/userLibrary.ts
 *
 * Tier 4 user .lib import support.
 *
 * Responsibilities:
 *   1. Scan a user-provided directory for .lib and .sub files.
 *   2. Extract .subckt names from those files by regex.
 *   3. Persist user-confirmed {mpn → subcktName, pinMap, filePath} bindings as JSON.
 *   4. Round-trip: load saved bindings back on startup.
 *
 * The validateModel callback (validateModel(deckLines) → Promise<{ok, error?}>)
 * is injected by the caller — not imported into core (keep core pure, spec §8.5).
 *
 * No imports from electron, react, or three. File I/O is via Node's 'node:fs'
 * (available in both Vitest/Node and the renderer's Vite + Node polyfill context
 * when run from Main/SimHost; for renderer use, the caller passes path via IPC).
 *
 * Spec §8.5 Tier 4, §8.7.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { PinMap } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

/** A .subckt discovered in a user's .lib or .sub file. */
export interface UserSubckt {
  /** The .subckt name as declared in the file (case-preserved). */
  name: string
  /** The file path where the subckt is defined. */
  filePath: string
}

/**
 * A user-confirmed binding: MPN → { subckt, pinMap, provenance }.
 * Persisted in the user bindings JSON file.
 */
export interface UserBinding {
  mpn: string
  subcktName: string
  filePath: string
  pinMap: PinMap
  /** e.g. 'user-import' or 'llm-generated' */
  provenance: string
  /** ISO date string of when the binding was created. */
  createdAt: string
}

/**
 * The JSON file schema for persisted user bindings.
 */
export interface UserBindingsFile {
  version: 1
  bindings: UserBinding[]
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

/**
 * Scan a directory for .lib and .sub files and extract .subckt names.
 *
 * Files are read and their text is scanned for lines matching:
 *   `.subckt <name> ...`
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

    // Extract .subckt names: lines starting with .subckt (case-insensitive)
    // Format: .subckt <name> <node1> <node2> ...
    const SUBCKT_REGEX = /^\s*\.subckt\s+(\S+)/gim
    for (const match of text.matchAll(SUBCKT_REGEX)) {
      results.push({ name: match[1], filePath })
    }
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

  const names: string[] = []
  const SUBCKT_REGEX = /^\s*\.subckt\s+(\S+)/gim
  for (const match of text.matchAll(SUBCKT_REGEX)) {
    names.push(match[1])
  }
  return names
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Save user bindings to a JSON file.
 *
 * @param bindingsPath  Absolute path to the bindings JSON file.
 * @param bindings      Array of UserBinding to persist.
 */
export function saveUserBindings(bindingsPath: string, bindings: UserBinding[]): void {
  const dir = join(bindingsPath, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const data: UserBindingsFile = { version: 1, bindings }
  writeFileSync(bindingsPath, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * Load user bindings from a JSON file.
 *
 * @param bindingsPath  Absolute path to the bindings JSON file.
 * @returns Array of UserBinding, or empty array if the file doesn't exist or is malformed.
 */
export function loadUserBindings(bindingsPath: string): UserBinding[] {
  if (!existsSync(bindingsPath)) return []

  let text: string
  try {
    text = readFileSync(bindingsPath, 'utf8')
  } catch {
    return []
  }

  try {
    const data = JSON.parse(text) as UserBindingsFile
    if (data.version !== 1 || !Array.isArray(data.bindings)) return []
    return data.bindings
  } catch {
    return []
  }
}

/**
 * Add or update a binding in the bindings array (upsert by mpn).
 *
 * @param existing   Current bindings array.
 * @param binding    New or updated binding.
 * @returns New array with the binding added or replaced.
 */
export function upsertBinding(existing: UserBinding[], binding: UserBinding): UserBinding[] {
  const filtered = existing.filter(b => b.mpn.toUpperCase() !== binding.mpn.toUpperCase())
  return [...filtered, binding]
}

/**
 * Remove a binding by MPN.
 *
 * @param existing  Current bindings array.
 * @param mpn       MPN to remove.
 * @returns New array without the named binding.
 */
export function removeBinding(existing: UserBinding[], mpn: string): UserBinding[] {
  return existing.filter(b => b.mpn.toUpperCase() !== mpn.toUpperCase())
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Find a user binding by MPN (case-insensitive).
 *
 * @param bindings  User bindings array.
 * @param mpn       MPN to look up.
 * @returns The matching UserBinding, or undefined.
 */
export function findBinding(bindings: UserBinding[], mpn: string): UserBinding | undefined {
  const upper = mpn.toUpperCase()
  return bindings.find(b => b.mpn.toUpperCase() === upper)
}
