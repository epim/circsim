/**
 * Tests for the bundled SPICE model library content (Task 14a / Spec §8.5, §14).
 *
 * These are pure-Node filesystem assertions over resources/models/ — no ngspice.
 * The real-ngspice "each card loads without error" check lives in
 * src/simhost/__tests__/library.integration.test.ts.
 *
 * Asserts (the Task 14a acceptance criteria):
 *  - every file in resources/models/ contains a 'Provenance:' header (Spec §14);
 *  - every index.json entry's referenced file + model name actually resolves
 *    (the .model card / .subckt exists in the named file);
 *  - every index.json entry has a non-empty pinMaps OR a defaultPinMap;
 *  - no obvious vendor-copyright marker text leaked into any .lib file.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import type { LibraryEntry } from '../types'

const MODELS_DIR = join(process.cwd(), 'resources', 'models')

interface LibraryIndex {
  entries: LibraryEntry[]
}

function readIndex(): LibraryIndex {
  return JSON.parse(readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')) as LibraryIndex
}

/** All non-index files in resources/models/. */
function modelFiles(): string[] {
  return readdirSync(MODELS_DIR).filter((f) => f !== 'index.json' && !f.startsWith('.'))
}

/**
 * Extract every `.model NAME` and `.subckt NAME` defined in a model file,
 * folding `+` continuation lines first so multi-line cards are seen whole.
 */
function definedNames(file: string): Set<string> {
  const text = readFileSync(join(MODELS_DIR, file), 'utf8')
  const joined = text.replace(/\r?\n\+/g, ' ')
  const names = new Set<string>()
  for (const m of joined.matchAll(/^\s*\.model\s+(\S+)\s+\w+/gim)) names.add(m[1].toUpperCase())
  for (const m of joined.matchAll(/^\s*\.subckt\s+(\S+)/gim)) names.add(m[1].toUpperCase())
  return names
}

describe('bundled model library — Provenance headers (Spec §14)', () => {
  const files = modelFiles()

  it('resources/models is non-empty', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s contains a Provenance: header', (file) => {
    const text = readFileSync(join(MODELS_DIR, file), 'utf8')
    expect(text).toMatch(/Provenance:/)
  })

  it('index.json itself records provenance', () => {
    const text = readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')
    expect(text).toMatch(/Provenance:/)
  })
})

describe('bundled model library — index resolution (Spec §8.5)', () => {
  const index = readIndex()

  it('index has at least the Task 14a discrete entries', () => {
    expect(index.entries.length).toBeGreaterThanOrEqual(16)
  })

  it('entry ids are unique', () => {
    const ids = index.entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(readIndex().entries.map((e) => [e.id, e] as const))(
    'entry %s resolves: model.name exists in model.file',
    (_id, entry) => {
      expect(entry.model.file, `entry ${entry.id} must name a model file`).toBeTruthy()
      const names = definedNames(entry.model.file as string)
      expect(
        names.has(entry.model.name.toUpperCase()),
        `entry ${entry.id}: model "${entry.model.name}" not found in ${entry.model.file}`
      ).toBe(true)
    }
  )

  it.each(readIndex().entries.map((e) => [e.id, e] as const))(
    'entry %s has pinMaps or defaultPinMap',
    (_id, entry) => {
      const hasPinMaps = entry.pinMaps && Object.keys(entry.pinMaps).length > 0
      const hasDefault = entry.defaultPinMap && Object.keys(entry.defaultPinMap).length > 0
      expect(
        Boolean(hasPinMaps || hasDefault),
        `entry ${entry.id} must have non-empty pinMaps or defaultPinMap`
      ).toBe(true)
    }
  )

  it.each(readIndex().entries.map((e) => [e.id, e] as const))(
    'entry %s has a non-empty provenance string',
    (_id, entry) => {
      expect(typeof entry.provenance).toBe('string')
      expect(entry.provenance.length).toBeGreaterThan(0)
    }
  )

  it.each(readIndex().entries.map((e) => [e.id, e] as const))(
    'entry %s has at least one match criterion',
    (_id, entry) => {
      const m = entry.match
      const has =
        (m.mpn && m.mpn.length > 0) ||
        Boolean(m.valueRegex) ||
        (m.refdesPrefix && m.refdesPrefix.length > 0) ||
        Boolean(m.footprintRegex)
      expect(Boolean(has), `entry ${entry.id} must have a match criterion`).toBe(true)
    }
  )
})

describe('bundled model library — licensing hygiene (Spec §8.5 never-bundle list)', () => {
  // No vendor-copyright / vendor-encrypted-model markers may leak into a .lib.
  // We do not bundle TI/ADI/onsemi/Micro-Cap/Intusoft text (Spec §8.5).
  const forbidden = [
    /All Rights Reserved/i,
    /Micro-?Cap/i,
    /Intusoft/i,
    /\bSPICE2\b.*copyright/i,
    /Texas Instruments.*Copyright/i,
    /Analog Devices.*Copyright/i,
    /onsemi.*Copyright/i,
    /\*\*\*\* encrypted/i
  ]

  it.each(modelFiles())('%s contains no forbidden vendor-copyright markers', (file) => {
    const text = readFileSync(join(MODELS_DIR, file), 'utf8')
    for (const re of forbidden) {
      expect(re.test(text), `${file} matched forbidden marker ${re}`).toBe(false)
    }
  })

  it('every .lib/.json declares MIT provenance', () => {
    for (const file of modelFiles()) {
      const text = readFileSync(join(MODELS_DIR, file), 'utf8')
      expect(text, `${file} should declare MIT provenance`).toMatch(/MIT/)
    }
  })
})
