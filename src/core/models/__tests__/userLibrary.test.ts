/**
 * Tests for core/models/userLibrary.ts — tier 4 user .lib import (Task 15).
 *
 * Covers:
 *   - scanUserDir: discover .lib/.sub files, extract .subckt names
 *   - extractSubcktNames: regex extraction from a single file
 *   - saveUserBindings / loadUserBindings: round-trip JSON persistence
 *   - upsertBinding / removeBinding / findBinding: CRUD operations
 *
 * Spec §8.5 Tier 4, §8.7.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanUserDir,
  extractSubcktNames,
  saveUserBindings,
  loadUserBindings,
  upsertBinding,
  removeBinding,
  findBinding,
} from '../userLibrary'
import type { UserBinding } from '../userLibrary'

// ─── Test fixture helpers ─────────────────────────────────────────────────────

let testDir: string

beforeEach(() => {
  // Create a fresh temp directory for each test
  testDir = join(tmpdir(), `circsim-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  // Cleanup
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true })
  }
})

function writeLib(name: string, content: string): string {
  const path = join(testDir, name)
  writeFileSync(path, content, 'utf8')
  return path
}

// ─── Sample binding ───────────────────────────────────────────────────────────

function makeBinding(mpn: string, subcktName: string, filePath: string): UserBinding {
  return {
    mpn,
    subcktName,
    filePath,
    pinMap: { '1': 'A', '2': 'K' },
    provenance: 'user-import',
    createdAt: new Date().toISOString(),
  }
}

// ─── scanUserDir ─────────────────────────────────────────────────────────────

describe('scanUserDir — discover .lib/.sub files and extract .subckt names', () => {
  it('returns empty array for non-existent directory', () => {
    const results = scanUserDir(join(testDir, 'does-not-exist'))
    expect(results).toEqual([])
  })

  it('returns empty array for empty directory', () => {
    const results = scanUserDir(testDir)
    expect(results).toEqual([])
  })

  it('ignores non-.lib/.sub files', () => {
    writeLib('readme.txt', '.subckt FAKE a b')
    writeLib('data.csv', '.subckt FAKECSC a b')
    const results = scanUserDir(testDir)
    expect(results).toHaveLength(0)
  })

  it('finds .subckt in a .lib file', () => {
    writeLib('mymodels.lib', `
* My custom models
.subckt MY_OPAMP inp inn out vcc vee
* ... implementation ...
.ends MY_OPAMP
`)
    const results = scanUserDir(testDir)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('MY_OPAMP')
    expect(results[0].filePath).toContain('mymodels.lib')
  })

  it('finds .subckt in a .sub file', () => {
    writeLib('custom.sub', `
.subckt MY_TRANSISTOR b c e
.ends
`)
    const results = scanUserDir(testDir)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('MY_TRANSISTOR')
  })

  it('finds multiple .subckt in one file', () => {
    writeLib('multi.lib', `
.subckt COMP_A inp inn out vcc gnd
.ends
.subckt COMP_B inp inn out vcc gnd
.ends
`)
    const results = scanUserDir(testDir)
    expect(results).toHaveLength(2)
    const names = results.map(r => r.name)
    expect(names).toContain('COMP_A')
    expect(names).toContain('COMP_B')
  })

  it('finds subckts across multiple files', () => {
    writeLib('file1.lib', '.subckt MODEL_A a b c\n.ends')
    writeLib('file2.sub', '.subckt MODEL_B x y z\n.ends')
    const results = scanUserDir(testDir)
    expect(results).toHaveLength(2)
    const names = results.map(r => r.name)
    expect(names).toContain('MODEL_A')
    expect(names).toContain('MODEL_B')
  })

  it('handles mixed case .SUBCKT (case-insensitive)', () => {
    writeLib('models.lib', '.SUBCKT UPPERCASE_MODEL a b\n.ends')
    const results = scanUserDir(testDir)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('UPPERCASE_MODEL')
  })

  it('each result has a non-empty filePath', () => {
    writeLib('test.lib', '.subckt TESTMODEL x y\n.ends')
    const results = scanUserDir(testDir)
    for (const r of results) {
      expect(r.filePath.length).toBeGreaterThan(0)
      expect(existsSync(r.filePath)).toBe(true)
    }
  })
})

// ─── extractSubcktNames ───────────────────────────────────────────────────────

describe('extractSubcktNames — extract .subckt names from a single file', () => {
  it('returns empty array for non-existent file', () => {
    const result = extractSubcktNames(join(testDir, 'no-such-file.lib'))
    expect(result).toEqual([])
  })

  it('extracts names from a file with multiple subckts', () => {
    const path = writeLib('models.lib', `
* Provenance: test file
.subckt NE555 gnd trig out reset ctrl thres disch vcc
+ Rin5 5 gnd 5k
.ends NE555
.subckt LM358 inp inn out vcc vee
.ends LM358
`)
    const names = extractSubcktNames(path)
    expect(names).toContain('NE555')
    expect(names).toContain('LM358')
    expect(names).toHaveLength(2)
  })

  it('preserves case of subckt names', () => {
    const path = writeLib('models.lib', '.subckt MixedCase a b\n.ends')
    const names = extractSubcktNames(path)
    expect(names[0]).toBe('MixedCase')
  })

  it('returns empty array for a file with no subckts', () => {
    const path = writeLib('empty.lib', '* just a comment\n.model X D\n')
    const names = extractSubcktNames(path)
    expect(names).toEqual([])
  })
})

// ─── saveUserBindings / loadUserBindings (round-trip) ────────────────────────

describe('saveUserBindings / loadUserBindings — JSON round-trip', () => {
  const bindingsPath = () => join(testDir, 'bindings.json')

  it('loadUserBindings returns empty array for non-existent file', () => {
    const result = loadUserBindings(join(testDir, 'no-such-file.json'))
    expect(result).toEqual([])
  })

  it('round-trips a single binding', () => {
    const binding = makeBinding('MY_IC', 'MY_IC_SUBCKT', '/path/to/models.lib')
    saveUserBindings(bindingsPath(), [binding])
    const loaded = loadUserBindings(bindingsPath())
    expect(loaded).toHaveLength(1)
    expect(loaded[0].mpn).toBe('MY_IC')
    expect(loaded[0].subcktName).toBe('MY_IC_SUBCKT')
    expect(loaded[0].filePath).toBe('/path/to/models.lib')
    expect(loaded[0].provenance).toBe('user-import')
  })

  it('round-trips multiple bindings', () => {
    const bindings = [
      makeBinding('IC_A', 'SUBCKT_A', '/path/a.lib'),
      makeBinding('IC_B', 'SUBCKT_B', '/path/b.lib'),
      makeBinding('IC_C', 'SUBCKT_C', '/path/c.lib'),
    ]
    saveUserBindings(bindingsPath(), bindings)
    const loaded = loadUserBindings(bindingsPath())
    expect(loaded).toHaveLength(3)
    const mpns = loaded.map(b => b.mpn)
    expect(mpns).toContain('IC_A')
    expect(mpns).toContain('IC_B')
    expect(mpns).toContain('IC_C')
  })

  it('round-trips pinMap correctly', () => {
    const binding: UserBinding = {
      mpn: 'MY_IC',
      subcktName: 'MY_IC',
      filePath: '/path.lib',
      pinMap: { '1': 'VCC', '2': 'GND', '3': 'OUT', '4': 'IN' },
      provenance: 'llm-generated',
      createdAt: '2026-06-14T00:00:00.000Z',
    }
    saveUserBindings(bindingsPath(), [binding])
    const loaded = loadUserBindings(bindingsPath())
    expect(loaded[0].pinMap).toEqual({ '1': 'VCC', '2': 'GND', '3': 'OUT', '4': 'IN' })
  })

  it('returns empty array for malformed JSON', () => {
    writeFileSync(bindingsPath(), 'not valid json', 'utf8')
    const result = loadUserBindings(bindingsPath())
    expect(result).toEqual([])
  })

  it('returns empty array for JSON with wrong version', () => {
    writeFileSync(bindingsPath(), JSON.stringify({ version: 99, bindings: [] }), 'utf8')
    const result = loadUserBindings(bindingsPath())
    expect(result).toEqual([])
  })

  it('creates parent directory if it does not exist', () => {
    const nestedPath = join(testDir, 'subdir', 'deep', 'bindings.json')
    const binding = makeBinding('IC', 'SUB', '/path.lib')
    saveUserBindings(nestedPath, [binding])
    const loaded = loadUserBindings(nestedPath)
    expect(loaded).toHaveLength(1)
  })
})

// ─── upsertBinding ────────────────────────────────────────────────────────────

describe('upsertBinding — add or replace a binding by MPN', () => {
  it('adds a new binding to empty array', () => {
    const result = upsertBinding([], makeBinding('IC_A', 'A', '/a.lib'))
    expect(result).toHaveLength(1)
    expect(result[0].mpn).toBe('IC_A')
  })

  it('adds a new binding to existing array', () => {
    const existing = [makeBinding('IC_A', 'A', '/a.lib')]
    const result = upsertBinding(existing, makeBinding('IC_B', 'B', '/b.lib'))
    expect(result).toHaveLength(2)
  })

  it('replaces an existing binding with same MPN', () => {
    const existing = [makeBinding('IC_A', 'OLD_SUBCKT', '/old.lib')]
    const updated = makeBinding('IC_A', 'NEW_SUBCKT', '/new.lib')
    const result = upsertBinding(existing, updated)
    expect(result).toHaveLength(1)
    expect(result[0].subcktName).toBe('NEW_SUBCKT')
    expect(result[0].filePath).toBe('/new.lib')
  })

  it('is case-insensitive for MPN matching on upsert', () => {
    const existing = [makeBinding('ic_a', 'OLD', '/old.lib')]
    const result = upsertBinding(existing, makeBinding('IC_A', 'NEW', '/new.lib'))
    expect(result).toHaveLength(1)
    expect(result[0].subcktName).toBe('NEW')
  })
})

// ─── removeBinding ────────────────────────────────────────────────────────────

describe('removeBinding — remove a binding by MPN', () => {
  it('removes a binding by MPN', () => {
    const existing = [
      makeBinding('IC_A', 'A', '/a.lib'),
      makeBinding('IC_B', 'B', '/b.lib'),
    ]
    const result = removeBinding(existing, 'IC_A')
    expect(result).toHaveLength(1)
    expect(result[0].mpn).toBe('IC_B')
  })

  it('is a no-op if MPN not found', () => {
    const existing = [makeBinding('IC_A', 'A', '/a.lib')]
    const result = removeBinding(existing, 'IC_Z')
    expect(result).toHaveLength(1)
  })

  it('is case-insensitive', () => {
    const existing = [makeBinding('ic_a', 'A', '/a.lib')]
    const result = removeBinding(existing, 'IC_A')
    expect(result).toHaveLength(0)
  })

  it('does not mutate the original array', () => {
    const existing = [makeBinding('IC_A', 'A', '/a.lib')]
    removeBinding(existing, 'IC_A')
    expect(existing).toHaveLength(1) // original unchanged
  })
})

// ─── findBinding ─────────────────────────────────────────────────────────────

describe('findBinding — look up a binding by MPN', () => {
  it('finds a binding by exact MPN', () => {
    const bindings = [makeBinding('IC_A', 'A', '/a.lib'), makeBinding('IC_B', 'B', '/b.lib')]
    const result = findBinding(bindings, 'IC_A')
    expect(result).toBeDefined()
    expect(result?.subcktName).toBe('A')
  })

  it('returns undefined for unknown MPN', () => {
    const result = findBinding([], 'UNKNOWN')
    expect(result).toBeUndefined()
  })

  it('is case-insensitive', () => {
    const bindings = [makeBinding('IC_A', 'A', '/a.lib')]
    expect(findBinding(bindings, 'ic_a')).toBeDefined()
    expect(findBinding(bindings, 'IC_A')).toBeDefined()
    expect(findBinding(bindings, 'Ic_A')).toBeDefined()
  })
})
