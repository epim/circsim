/**
 * Tests for core/models/libraryMatch.ts — tier 3 library matching (Task 15).
 *
 * Covers:
 *   - MPN normalization (strip package suffixes)
 *   - Matching precedence: exact normalized MPN > value regex > refdesPrefix+footprint
 *   - Ambiguous matches (2+ entries) → unresolved with candidate list
 *   - Pin-map selection: footprint regex match → pinMap; no match → defaultPinMap + 'pinmap-unverified'
 *   - Integration: tier 3 wired into resolveAll for Task 14a/14b library entries
 *
 * Spec §8.5, §8.7.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeMpn,
  matchLibraryEntry,
  selectPinMap,
  MPN_SUFFIX_RULES,
} from '../libraryMatch'
import type { LibraryEntry } from '../types'
import { resolveAll } from '../resolve'
import type { Circuit, Part } from '../../netlist/extract'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeEntry(
  id: string,
  match: LibraryEntry['match'],
  pinMaps: LibraryEntry['pinMaps'] = {},
  defaultPinMap?: LibraryEntry['defaultPinMap'],
): LibraryEntry {
  return {
    id,
    match,
    model: { type: 'model-card', file: 'diodes.lib', name: id.toUpperCase() },
    pinMaps,
    defaultPinMap,
    provenance: 'test entry, MIT',
  }
}

function makePart(
  ref: string,
  value: string,
  libId = 'Device:D',
  properties: Record<string, string> = {},
): Part {
  return {
    ref,
    value,
    libId,
    layer: 'F',
    padNet: new Map([['1', 1], ['2', 2]]),
    properties,
  }
}

function makeCircuit(parts: Part[]): Circuit {
  return {
    nets: [
      { id: 1, kicadName: 'A', spiceNode: 'a', padRefs: [] },
      { id: 2, kicadName: 'B', spiceNode: 'b', padRefs: [] },
    ],
    parts,
    warnings: [],
  }
}

// ─── MPN normalization ────────────────────────────────────────────────────────

describe('normalizeMpn — strip package suffixes', () => {
  it('exports MPN_SUFFIX_RULES as a non-empty array', () => {
    expect(Array.isArray(MPN_SUFFIX_RULES)).toBe(true)
    expect(MPN_SUFFIX_RULES.length).toBeGreaterThan(0)
  })

  it('no-suffix MPN is returned as uppercase', () => {
    expect(normalizeMpn('1N4148')).toBe('1N4148')
    expect(normalizeMpn('2N3904')).toBe('2N3904')
    expect(normalizeMpn('LM358')).toBe('LM358')
  })

  // Package suffixes: trailing D/N/P/R variants, T(SSO), SOT, etc.
  it('strips trailing D (SOIC suffix) → LM358D → LM358', () => {
    expect(normalizeMpn('LM358D')).toBe('LM358')
  })

  it('strips trailing N (DIP suffix) → LM358N → LM358', () => {
    expect(normalizeMpn('LM358N')).toBe('LM358')
  })

  it('strips trailing DR (D+Reel) → LM358DR → LM358', () => {
    expect(normalizeMpn('LM358DR')).toBe('LM358')
  })

  it('strips trailing DT (DT package suffix) → NE555DT → NE555', () => {
    expect(normalizeMpn('NE555DT')).toBe('NE555')
  })

  it('strips trailing P (e.g. NE555P → NE555)', () => {
    expect(normalizeMpn('NE555P')).toBe('NE555')
  })

  it('strips trailing PWR → LM324PWR → LM324', () => {
    expect(normalizeMpn('LM324PWR')).toBe('LM324')
  })

  it('NE555 (no suffix) → NE555', () => {
    expect(normalizeMpn('NE555')).toBe('NE555')
  })

  it('handles already-clean MPN with numeric endings', () => {
    // 2N3904 must NOT have the "04" stripped
    expect(normalizeMpn('2N3904')).toBe('2N3904')
    expect(normalizeMpn('1N4148')).toBe('1N4148')
    expect(normalizeMpn('BC547')).toBe('BC547')
  })

  it('is case-insensitive: lm358dr → LM358', () => {
    expect(normalizeMpn('lm358dr')).toBe('LM358')
  })

  it('strips trailing -TR (tape and reel) → BC547-TR → BC547', () => {
    expect(normalizeMpn('BC547-TR')).toBe('BC547')
  })

  it('strips trailing -SMD suffix → 1N4148-SMD → 1N4148', () => {
    expect(normalizeMpn('1N4148-SMD')).toBe('1N4148')
  })
})

// ─── matchLibraryEntry ────────────────────────────────────────────────────────

describe('matchLibraryEntry — precedence: MPN > valueRegex > refdesPrefix+footprint', () => {
  const diodeEntry = makeEntry(
    'diode-1n4148',
    {
      mpn: ['1N4148', '1N914', '1N4148W'],
      refdesPrefix: ['D'],
      footprintRegex: 'D_(SOD|SMA)',
    },
    { 'D_(SOD|SMA).*': { '1': '2', '2': '1' } },
    { '1': '2', '2': '1' },
  )

  const ne555Entry = makeEntry(
    'timer-ne555',
    {
      mpn: ['NE555', 'LM555', '555'],
      valueRegex: '(?i)^(ne)?555$',
      refdesPrefix: ['U', 'IC'],
      footprintRegex: 'DIP-8',
    },
    { 'DIP-8.*': { '1': 'gnd', '2': 'trig', '3': 'out', '8': 'vcc' } },
    { '1': 'gnd', '2': 'trig' },
  )

  it('MPN exact match (no suffix) → hits', () => {
    const result = matchLibraryEntry({ mpn: '1N4148', libId: 'Device:D', value: '', ref: 'D1' }, [diodeEntry])
    expect(result.kind).toBe('match')
    if (result.kind === 'match') expect(result.entry.id).toBe('diode-1n4148')
  })

  it('MPN with package suffix → normalizes and hits', () => {
    const result = matchLibraryEntry({ mpn: 'LM358DR', libId: 'Device:U', value: 'LM358', ref: 'U1' }, [
      makeEntry('opamp-lm358', { mpn: ['LM358'] }, {}, { '1': 'inp' }),
    ])
    expect(result.kind).toBe('match')
  })

  it('MPN match case-insensitive', () => {
    const result = matchLibraryEntry({ mpn: '1n4148', libId: 'Device:D', value: '', ref: 'D1' }, [diodeEntry])
    expect(result.kind).toBe('match')
    if (result.kind === 'match') expect(result.entry.id).toBe('diode-1n4148')
  })

  it('no MPN, value matches valueRegex → hits ne555', () => {
    const result = matchLibraryEntry({ mpn: undefined, libId: 'Timer:NE555', value: 'NE555', ref: 'U1' }, [ne555Entry])
    expect(result.kind).toBe('match')
    if (result.kind === 'match') expect(result.entry.id).toBe('timer-ne555')
  })

  it('value 555 matches valueRegex → hits ne555', () => {
    const result = matchLibraryEntry({ mpn: undefined, libId: 'Timer:555', value: '555', ref: 'U1' }, [ne555Entry])
    expect(result.kind).toBe('match')
  })

  it('no MPN, no valueRegex match, refdesPrefix+footprint fallback → hits', () => {
    const result = matchLibraryEntry(
      { mpn: undefined, libId: 'Resistor_SMD:R_0805', value: '10k', ref: 'D5' },
      [diodeEntry],
    )
    // refdesPrefix for diode is ["D"], but our ref starts with 'D' — check
    // libId does not match D_(SOD|SMA), so footprint fails — no match
    expect(result.kind).toBe('none')
  })

  it('refdesPrefix match + footprintRegex match → hits (fallback tier)', () => {
    const result = matchLibraryEntry(
      { mpn: undefined, libId: 'Device:D_SOD123', value: 'generic', ref: 'D3' },
      [diodeEntry],
    )
    // ref prefix 'D' matches, libId 'Device:D_SOD123' matches 'D_(SOD|SMA)' — should match
    expect(result.kind).toBe('match')
  })

  it('no match → none', () => {
    const result = matchLibraryEntry({ mpn: 'XYZ123', libId: 'Package:WROOM32', value: 'ESP32', ref: 'U1' }, [diodeEntry])
    expect(result.kind).toBe('none')
  })

  it('two entries both match MPN → ambiguous with candidate ids', () => {
    const entryA = makeEntry('a', { mpn: ['1N4148'] }, {}, { '1': 'a' })
    const entryB = makeEntry('b', { mpn: ['1N4148'] }, {}, { '1': 'b' })
    const result = matchLibraryEntry({ mpn: '1N4148', libId: 'Device:D', value: '', ref: 'D1' }, [entryA, entryB])
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toContain('a')
      expect(result.candidates).toContain('b')
    }
  })

  it('MPN wins over valueRegex match when both apply', () => {
    // Entry A: MPN match, Entry B: only valueRegex match
    const entryA = makeEntry('a', { mpn: ['1N4148'] }, {}, { '1': 'a' })
    const entryB = makeEntry('b', { valueRegex: '1N4148' }, {}, { '1': 'b' })
    const result = matchLibraryEntry({ mpn: '1N4148', libId: 'Device:D', value: '1N4148', ref: 'D1' }, [entryA, entryB])
    // MPN match on A should win; B is value-only and lower priority
    expect(result.kind).toBe('match')
    if (result.kind === 'match') expect(result.entry.id).toBe('a')
  })
})

// ─── selectPinMap ─────────────────────────────────────────────────────────────

describe('selectPinMap — footprint regex → pinMap; else defaultPinMap + warning', () => {
  it('footprint matches a pinMaps key → returns map, no warning', () => {
    const entry = makeEntry(
      'diode-1n4148',
      { mpn: ['1N4148'] },
      { 'D_(SOD|SMA).*': { '1': '2', '2': '1' } },
      { '1': 'a', '2': 'b' },
    )
    const { pinMap, warnings } = selectPinMap(entry, 'D_SMA_SMA')
    expect(pinMap).toEqual({ '1': '2', '2': '1' })
    expect(warnings).toHaveLength(0)
  })

  it('no footprint match → uses defaultPinMap + pinmap-unverified warning', () => {
    const entry = makeEntry(
      'diode-1n4148',
      { mpn: ['1N4148'] },
      { 'D_(SOD|SMA).*': { '1': '2', '2': '1' } },
      { '1': 'x', '2': 'y' },
    )
    const { pinMap, warnings } = selectPinMap(entry, 'SomeWeirdFootprint')
    expect(pinMap).toEqual({ '1': 'x', '2': 'y' })
    expect(warnings.some(w => w.includes('pinmap-unverified'))).toBe(true)
  })

  it('no footprint match, no defaultPinMap → returns empty map + warning', () => {
    const entry = makeEntry('x', { mpn: ['X'] }, { 'SOT-23.*': { '1': 'g' } })
    const { pinMap, warnings } = selectPinMap(entry, 'DIP-8')
    expect(warnings.length).toBeGreaterThan(0)
    // pinMap may be empty if no default
    expect(typeof pinMap).toBe('object')
  })

  it('footprint regex is tested against the full libId string', () => {
    const entry = makeEntry(
      'bjt',
      { mpn: ['2N3904'] },
      { 'SOT-23.*': { '1': 'e', '2': 'b', '3': 'c' } },
      { '1': 'e', '2': 'b', '3': 'c' },
    )
    const { pinMap, warnings } = selectPinMap(entry, 'Package_TO_SOT_SMD:SOT-23')
    expect(pinMap).toEqual({ '1': 'e', '2': 'b', '3': 'c' })
    expect(warnings).toHaveLength(0)
  })
})

// ─── resolveAll tier 3 integration ───────────────────────────────────────────

describe('resolveAll tier 3 — library matching wired into resolve pipeline', () => {
  const diodeEntry: LibraryEntry = {
    id: 'diode-1n4148',
    match: {
      mpn: ['1N4148', '1N914', '1N4148W', '1N4148WS'],
      refdesPrefix: ['D'],
      footprintRegex: 'D_(SOD|SMA|SMB|0805)',
    },
    model: { type: 'model-card', file: 'diodes.lib', name: 'D1N4148' },
    pinMaps: { 'D_(SOD|SMA|SMB|0805|MELF|DO).*': { '1': '2', '2': '1' } },
    defaultPinMap: { '1': '2', '2': '1' },
    provenance: 'test, MIT',
  }

  it('D1 with value 1N4148 and MPN property → tier 3 resolved', () => {
    const part = makePart('D1', '1N4148', 'Diode_SMD:D_SMA', { mpn: '1N4148' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, [diodeEntry])
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    expect(res.model?.kind).toBe('subckt')
  })

  it('D1 with no MPN but value matching → tier 3 via value regex', () => {
    const ne555: LibraryEntry = {
      id: 'timer-ne555',
      match: { mpn: ['NE555'], valueRegex: '(?i)^(ne)?555$' },
      model: { type: 'subckt', file: 'timer555.lib', name: 'NE555' },
      pinMaps: {},
      defaultPinMap: { '1': 'gnd', '2': 'trig' },
      provenance: 'test, MIT',
    }
    const part = makePart('U1', 'NE555', 'Package_DIP:DIP-8')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, [ne555])
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
  })

  it('unknown IC with no match in library → falls through to unresolved', () => {
    const part = makePart('U1', 'ESP32', 'Package:ESP32-WROOM-32')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, [diodeEntry])
    expect(res.status).toBe('unresolved')
  })

  it('ambiguous library match → unresolved with warning listing candidate ids', () => {
    const entryA: LibraryEntry = {
      id: 'diode-a',
      match: { mpn: ['GENERIC_D'] },
      model: { type: 'model-card', file: 'diodes.lib', name: 'DA' },
      pinMaps: {},
      defaultPinMap: { '1': 'a' },
      provenance: 'test, MIT',
    }
    const entryB: LibraryEntry = {
      id: 'diode-b',
      match: { mpn: ['GENERIC_D'] },
      model: { type: 'model-card', file: 'diodes.lib', name: 'DB' },
      pinMaps: {},
      defaultPinMap: { '1': 'b' },
      provenance: 'test, MIT',
    }
    const part = makePart('D1', 'GENERIC_D', 'Device:D', { mpn: 'GENERIC_D' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, [entryA, entryB])
    expect(res.status).toBe('unresolved')
    expect(res.warnings.some(w => w.includes('diode-a') || w.includes('diode-b'))).toBe(true)
  })

  it('tier 1 wins over tier 3', () => {
    // If schematic has Sim.Device=D for D1, tier 1 wins even if library also matches
    const part = makePart('D1', '1N4148', 'Device:D', { mpn: '1N4148' })
    const circuit = makeCircuit([part])
    const schData = new Map([
      ['D1', { value: '1N4148', sim: { Device: 'D' }, pins: [], noConnects: [] }],
    ])
    const [res] = resolveAll(circuit, schData, undefined, [diodeEntry])
    expect(res.tier).toBe(1)
  })

  it('tier 2 wins over tier 3 for R/C/L', () => {
    // R with parseable value → tier 2 even if library has a matching R entry
    const rEntry: LibraryEntry = {
      id: 'r-10k',
      match: { mpn: ['RC0805FR-0710KL'], refdesPrefix: ['R'], valueRegex: '10k' },
      model: { type: 'model-card', file: 'diodes.lib', name: 'R10K' },
      pinMaps: {},
      defaultPinMap: { '1': '1', '2': '2' },
      provenance: 'test, MIT',
    }
    const part = makePart('R1', '10k', 'Resistor_SMD:R_0805', { mpn: 'RC0805FR-0710KL' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, [rEntry])
    // Tier 2 (primitive inference) wins before tier 3 library lookup
    expect(res.tier).toBe(2)
  })

  it('tier 3 resolved model carries pinMap from footprint match', () => {
    const part = makePart('D1', '1N4148', 'Diode_SMD:D_SMA', { mpn: '1N4148' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, [diodeEntry])
    expect(res.tier).toBe(3)
    expect(res.model?.kind).toBe('subckt')
    if (res.model?.kind === 'subckt') {
      // Pin map should be present (from footprint match or default)
      expect(res.model.pinMap).toBeDefined()
      expect(Object.keys(res.model.pinMap).length).toBeGreaterThan(0)
    }
  })

  it('tier 3 with no footprint pinMap match → pinmap-unverified warning', () => {
    const entryNoDefault: LibraryEntry = {
      id: 'bjt-2n3904',
      match: { mpn: ['2N3904'] },
      model: { type: 'model-card', file: 'bjt.lib', name: 'Q2N3904' },
      pinMaps: { 'SOT-23.*': { '1': 'e', '2': 'b', '3': 'c' } },
      // No defaultPinMap
      provenance: 'test, MIT',
    }
    // Use a footprint that doesn't match SOT-23
    const part = makePart('Q1', '2N3904', 'Package_TO_THT:TO-92_Inline', { mpn: '2N3904' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, [entryNoDefault])
    // Should still resolve (with warning)
    expect(res.tier).toBe(3)
    expect(res.warnings.some(w => w.includes('pinmap-unverified'))).toBe(true)
  })
})

// ─── Task 14a/14b library entries matched by tier 3 ──────────────────────────

describe('resolveAll tier 3 — Task 14a/14b bundled index entries match expected parts', () => {
  // These tests verify that the real bundled library entries are matched correctly
  // by the tier 3 logic when a Part has matching properties.

  // We import the real index.json entries here for a round-trip integration check.
  // Only a subset to keep the test focused.

  it('NE555 by MPN property matches timer-ne555 entry', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const index = JSON.parse(readFileSync(join(process.cwd(), 'resources/models/index.json'), 'utf8')) as {
      entries: import('../types').LibraryEntry[]
    }
    const part = makePart('U1', 'NE555', 'Package_DIP:DIP-8_W7.62mm', { mpn: 'NE555' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, index.entries)
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    expect(res.model?.kind).toBe('subckt')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('NE555')
    }
  })

  it('1N4148 by MPN matches diode-1n4148 entry', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const index = JSON.parse(readFileSync(join(process.cwd(), 'resources/models/index.json'), 'utf8')) as {
      entries: import('../types').LibraryEntry[]
    }
    const part = makePart('D1', '1N4148', 'Diode_SMD:D_SOD-123', { mpn: '1N4148' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, index.entries)
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
  })

  it('LM358DR normalized to LM358 matches opamp-lm358 entry', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const index = JSON.parse(readFileSync(join(process.cwd(), 'resources/models/index.json'), 'utf8')) as {
      entries: import('../types').LibraryEntry[]
    }
    const part = makePart('U1', 'LM358', 'Amplifier_SingleSupply:SOIC-8', { mpn: 'LM358DR' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, index.entries)
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('LM358')
    }
  })
})
