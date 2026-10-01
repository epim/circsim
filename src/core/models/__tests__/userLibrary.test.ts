/**
 * Tests for core/models/userLibrary.ts — tier 4 user .lib import (Task 15).
 *
 * Covers:
 *   - scanUserDir: discover .lib/.sub files, extract .subckt names
 *   - extractSubcktNames: regex extraction from a single file
 *
 * The standalone bindings JSON (save/load/upsert/remove/find) was removed in
 * issue #17: imported models persist through the per-board sidecar.
 *
 * Spec §8.5 Tier 4, §8.7.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanUserDir, extractSubcktNames } from '../userLibrary'

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

