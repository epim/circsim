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

// ─── Tier 3 value-as-MPN fallback ─────────────────────────────────────────────

describe('resolveAll tier 3 — value used as MPN candidate when no mpn property', () => {
  // Real boards (KiCad 9 / JLC parts) often carry the MPN in the part VALUE
  // field ("1N4148W", "MMBT3904", "AO3401") with no mpn property at all.
  // When properties provide no mpn/MPN, the part's value is passed as the MPN
  // candidate — matchLibraryEntry normalizes it, so package suffixes still strip.

  async function realIndex(): Promise<import('../types').LibraryEntry[]> {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const index = JSON.parse(readFileSync(join(process.cwd(), 'resources/models/index.json'), 'utf8')) as {
      entries: import('../types').LibraryEntry[]
    }
    return index.entries
  }

  it('D1 value "1N4148W" (no mpn property) → diode-1n4148 via value-as-MPN', async () => {
    const part = makePart('D1', '1N4148W', 'Diode_SMD:D_SOD-123')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('D1N4148')
    }
  })

  it('Q1 value "MMBT3904" (no mpn property) → bjt-2n3904 via value-as-MPN', async () => {
    const part = makePart('Q1', 'MMBT3904', 'Package_TO_SOT_SMD:SOT-23')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('Q2N3904')
    }
  })

  it('Q2 value "DMP2305U" (no mpn property) → mosfet-pmos-generic via value-as-MPN', async () => {
    const part = makePart('Q2', 'DMP2305U', 'Package_TO_SOT_SMD:SOT-23')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('MPMOS_GEN')
    }
  })

  it('mpn property still wins over the value field when both are present', async () => {
    // value says 1N4148W but the mpn property says MMBT3904 — property wins.
    const part = makePart('Q3', '1N4148W', 'Package_TO_SOT_SMD:SOT-23', { mpn: 'MMBT3904' })
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('Q2N3904')
    }
  })

  it('plain R value does NOT suddenly match: parseable value stays tier 2', async () => {
    const part = makePart('R1', '10k', 'Resistor_SMD:R_0805_2012Metric')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(2)
    expect(res.status).toBe('ok')
  })

  it('unparseable R value used as MPN candidate matches nothing → unresolved', async () => {
    // Falls past tier 2 (unparseable), reaches tier 3 with value as the MPN
    // candidate; no library entry lists a resistor MPN → stays unresolved.
    const part = makePart('R2', '0805W8F1002T5E', 'Resistor_SMD:R_0805_2012Metric')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.status).toBe('unresolved')
  })

  // ── Milestone 1 library additions resolve end-to-end ──────────────────────

  it('D1 value "BAS16" → diode-1n4148 (1N4148-equivalent)', async () => {
    const part = makePart('D1', 'BAS16', 'Diode_SMD:D_SOD-123')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('D1N4148')
    }
  })

  it('D2 value "SS14" → diode-1n5819 (1A/40V Schottky class)', async () => {
    const part = makePart('D2', 'SS14', 'Diode_SMD:D_SMA')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('D1N5819')
    }
  })

  it('D3 value "3.0V" → zener-3v0 via valueRegex', async () => {
    const part = makePart('D3', '3.0V', 'Diode_SMD:D_SOD-123')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('DZ3V0')
    }
  })

  it('D4 value "3V0" → zener-3v0 via value-as-MPN (part values only — nets never match)', async () => {
    const part = makePart('D4', '3V0', 'Diode_SMD:D_SOD-123')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('DZ3V0')
    }
  })

  it('BT1 value "3V" (battery symbol) stays unresolved — bare "3V" must not match zener-3v0', async () => {
    // valueRegex matching is not refdes-gated, so a coin-cell battery whose
    // VALUE is "3V" would resolve as a 3.0 V zener if the regex accepted the
    // bare form. Only "3.0V" (value) and "3V0"/"BZX84C3V0" (mpn) may match.
    const part = makePart('BT1', '3V', 'Battery:BatteryHolder_Keystone_3034_1x20mm')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.status).toBe('unresolved')
  })

  it('U2 value "LM339" on SOIC-14 → comparator-lm339 (LM393 cell, unit-1 pinMap)', async () => {
    const part = makePart('U2', 'LM339', 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('LM393')
      expect(res.model.pinMap['5']).toBe('inp')
      expect(res.model.pinMap['4']).toBe('inn')
      expect(res.model.pinMap['2']).toBe('out')
      expect(res.model.pinMap['3']).toBe('vcc')
      expect(res.model.pinMap['12']).toBe('vee')
    }
  })

  it('U8 value "CD4011" on SOP-14 → logic-cd4011 (never the LM393 comparator)', async () => {
    // Regression (two eras): comparator-lm339 must match on mpn/value ONLY —
    // with refdes/footprint fallback rules it silently misresolved a CD4011
    // quad NAND in SOP-14 as an LM393 comparator on a real board. Now that a
    // dedicated CD4011 entry exists it must resolve as the xspice-digital NAND.
    const part = makePart('U8', 'CD4011', 'Package_SO:SOP-14_3.9x8.7mm_P1.27mm')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    expect(res.model?.kind).toBe('xspice-digital')
    if (res.model?.kind === 'xspice-digital') {
      expect(res.model.templateId).toBe('CD4011')
    }
  })

  it('U3 value "TL431" on SOT-23 → ref-tl431 shunt reference', async () => {
    const part = makePart('U3', 'TL431', 'Package_TO_SOT_SMD:SOT-23')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('TL431')
    }
  })

  // ── Milestone 2: power-path discretes resolve end-to-end ───────────────────

  it('Q5 value "NCE4012S" on SOP-8 → mosfet-nce4012s (one representative pad per terminal)', async () => {
    const part = makePart('Q5', 'NCE4012S', 'SOP-8_L4.9-W3.9-P1.27-LS6.0-BL')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    expect(res.model?.kind).toBe('subckt')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('MNCE4012S')
      // The deck generator emits ONE node per pinMap entry, so exactly one
      // representative pad per VDMOS terminal (5=D, 4=G, 1=S) may be mapped.
      expect(res.model.pinMap).toEqual({ '5': '1', '4': '2', '1': '3' })
    }
  })

  it('Q2 value "NCE6005AS" on JLC SOP-8 → mosfet-nce6005as dual-FET subckt (named terminals)', async () => {
    const part = makePart('Q2', 'NCE6005AS', 'JLC-MCP:SOP-8_L4.9-W3.9-P1.27-LS6.0-BL')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('NCE6005AS')
      expect(res.model.pinMap).toEqual({
        '7': 'd1', '2': 'g1', '1': 's1', '5': 'd2', '4': 'g2', '3': 's2',
      })
    }
  })

  it('Q3 value "AO3401" on SOT-23 → mosfet-ao3401 (dedicated card, NOT the pmos generic)', async () => {
    // Regression: MPMOS_GEN aborted a real-board transient ("TRAN: Timestep too
    // small … m_q3"); AO3401/AO3401A moved to a dedicated datasheet-tuned card.
    const part = makePart('Q3', 'AO3401', 'JLC-MCP:SOT-23-3_L2.9-W1.3-P1.90-LS2.4-BR')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('MAO3401')
      expect(res.model.subcktName).not.toBe('MPMOS_GEN')
    }
  })

  it('Q4 value "AO3401A" also → mosfet-ao3401 (unambiguous — alias removed from the generic)', async () => {
    const part = makePart('Q4', 'AO3401A', 'Package_TO_SOT_SMD:SOT-23')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('MAO3401')
    }
  })

  it('D7 value "SS54" on SMC → schottky-ss54 (pad 1 = cathode)', async () => {
    const part = makePart('D7', 'SS54', 'SMC_L7.1-W6.2-LS8.1-R-RD')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('DSS54')
      expect(res.model.pinMap).toEqual({ '1': '2', '2': '1' })
    }
    // The bare SMC footprint (no D_ prefix, as routed boards name it) matches a
    // pinMaps key directly — no pinmap-unverified fallback warning.
    expect(res.warnings.some((w) => w.includes('pinmap-unverified'))).toBe(false)
  })

  it('D8 value "SB540" → schottky-ss54 via alias', async () => {
    const part = makePart('D8', 'SB540', 'Diode_SMD:D_SMB')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('DSS54')
    }
  })

  // ── Milestone 3: behavioral power-IC stubs resolve end-to-end ──────────────

  it('U3 value "BQ7791502" on JLC TSSOP-24 → protector-bq77915 stub', async () => {
    const part = makePart('U3', 'BQ7791502', 'JLC-MCP:TSSOP-24_L7.8-W4.4-P0.65-LS6.4-BL_1')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('BQ7791502')
      // Datasheet TSSOP-24 pins (board-verified): 1=VDD, 9=VSS, 13=CHG, 12=DSG.
      expect(res.model.pinMap).toEqual({ '1': 'vdd', '9': 'vss', '13': 'chg', '12': 'dsg' })
    }
  })

  it('U2 value "LTC4020EUHF#TRPBF" (exact board value — #TRPBF is NOT a stripped suffix) → charger-ltc4020', async () => {
    // normalizeMpn's suffix rules do not cover ADI's "#TRPBF" ordering suffix,
    // so the full string is listed as an mpn alias; this asserts the exact
    // board VALUE resolves without any schematic mpn property.
    const part = makePart('U2', 'LTC4020EUHF#TRPBF', 'QFN-38_L5.0-W7.0-P0.50-TL-EP')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('LTC4020')
      expect(res.model.pinMap).toEqual({
        '7': 'vin', '10': 'intvcc', '1': 'tg1', '37': 'bg1', '31': 'tg2', '33': 'bg2', '3': 'gnd',
      })
    }
  })

  it('U4 value "AL8860MP" on MSOP-8 → leddriver-al8860 (kills the live 4-way fallback false ambiguity)', async () => {
    // Regression: with no AL8860 entry, U4 fell to the refdes+footprint tier
    // where U + MSOP-8 matched four nonsense entries (opamp-lm358, opamp-tl072,
    // comparator-lm393, timer-ne555) → false-ambiguous, unresolved.
    const part = makePart('U4', 'AL8860MP', 'JLC-MCP:MSOP-8_L3.0-W3.0-P0.65-LS4.9-BL-EP1.8')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('AL8860')
      expect(res.model.pinMap).toEqual({ '8': 'vin', '1': 'set', '5': 'sw', '4': 'ctrl', '2': 'gnd' })
    }
    expect(res.warnings.some((w) => w.includes('Ambiguous'))).toBe(false)
  })

  it('U4 value "AL8860MP-13" (reel-qualified MPN) also → leddriver-al8860', async () => {
    const part = makePart('U4', 'AL8860MP-13', 'JLC-MCP:MSOP-8_L3.0-W3.0-P0.65-LS4.9-BL-EP1.8')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('AL8860')
    }
  })

  it('D3 value "SMAJ24A" on D_SMA → tvs-smaj24a (kills the live 3-way fallback ambiguity)', async () => {
    // Regression: with no SMAJ24A entry, D3 fell to the refdes+footprint tier
    // where D + SMA matched three diode entries → false-ambiguous, unresolved.
    const part = makePart('D3', 'SMAJ24A', 'Diode_SMD:D_SMA')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    if (res.model?.kind === 'subckt') {
      expect(res.model.subcktName).toBe('DSMAJ24A')
      expect(res.model.pinMap).toEqual({ '1': '2', '2': '1' })
    }
    expect(res.warnings.some((w) => w.includes('Ambiguous'))).toBe(false)
  })

  // ── Milestone 5c: CD4000-series logic (12 V family file logic4000.json) ────

  it('U7 value "CD40106" on JLC SOIC-14 → logic-cd40106 hex Schmitt inverter', async () => {
    const part = makePart('U7', 'CD40106', 'JLC-MCP:SOIC-14_L8.7-W3.9-P1.27-LS6.0-BL')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.tier).toBe(3)
    expect(res.status).toBe('ok')
    expect(res.model?.kind).toBe('xspice-digital')
    if (res.model?.kind === 'xspice-digital') {
      expect(res.model.templateId).toBe('CD40106')
      // Pin-compatible with the 74HC14: inverter outputs on even pins 2..12.
      expect(res.model.pinMap['1']).toBe('1A')
      expect(res.model.pinMap['2']).toBe('1Y')
      expect(res.model.pinMap['7']).toBe('GND')
      expect(res.model.pinMap['14']).toBe('VCC')
    }
    expect(res.warnings.some((w) => w.includes('pinmap-unverified'))).toBe(false)
  })

  it('CD40106 aliases HEF40106 / MC14584 / CD40106BM also → logic-cd40106', async () => {
    for (const value of ['HEF40106', 'MC14584', 'CD40106BM', 'CD40106B']) {
      const part = makePart('U7', value, 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm')
      const circuit = makeCircuit([part])
      const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
      expect(res.status, `${value} must resolve`).toBe('ok')
      if (res.model?.kind === 'xspice-digital') {
        expect(res.model.templateId).toBe('CD40106')
      }
    }
  })

  it('CD4011 pinMap has the CD4000 pinout — outputs on pads 3, 4, 10, 11 (NOT the 74HC00 pinout)', async () => {
    // Regression guard against copying the 74HC00 pinMap: on the CD4011 the
    // gate outputs are pins 3/4/10/11 (74HC00 has them on 3/6/8/11).
    const part = makePart('U8', 'CD4011', 'JLC-MCP:SOP-14_L8.6-W3.9-P1.27-LS6.0-BL')
    const circuit = makeCircuit([part])
    const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
    expect(res.status).toBe('ok')
    expect(res.model?.kind).toBe('xspice-digital')
    if (res.model?.kind === 'xspice-digital') {
      expect(res.model.pinMap).toEqual({
        '1': '1A', '2': '1B', '3': '1Y', '4': '2Y', '5': '2A', '6': '2B',
        '7': 'GND', '8': '3A', '9': '3B', '10': '3Y', '11': '4Y', '12': '4A',
        '13': '4B', '14': 'VCC',
      })
    }
    expect(res.warnings.some((w) => w.includes('pinmap-unverified'))).toBe(false)
  })

  it('CD4011 aliases HEF4011 / MC14011 / CD4011BM also → logic-cd4011', async () => {
    for (const value of ['HEF4011', 'MC14011', 'CD4011BM', 'CD4011B']) {
      const part = makePart('U8', value, 'Package_SO:SOP-14_3.9x8.7mm_P1.27mm')
      const circuit = makeCircuit([part])
      const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
      expect(res.status, `${value} must resolve`).toBe('ok')
      if (res.model?.kind === 'xspice-digital') {
        expect(res.model.templateId).toBe('CD4011')
      }
    }
  })

  it('U6 "CD4538" and U1 "CH224K" stay unresolved (index schema has no deliberate-open entry kind)', async () => {
    // DOCUMENTED GAP: the CD4538 dual monostable (RC-programmed pulse width)
    // and CH224K USB-PD sink controller are not simulatable with the existing
    // primitives, and LibraryEntry.model.type has no stub/open kind — so a
    // "known part, deliberately open" library entry is NOT expressible today.
    // They fall through to red-unresolved; connectors are the only parts that
    // get the ok-with-note open treatment (resolve.ts isConnector).
    for (const [ref, value, fp] of [
      ['U6', 'CD4538', 'JLC-MCP:SOP-16_L10.0-W3.9-P1.27-LS6.0-BL'],
      ['U1', 'CH224K', 'JLC-MCP:ESSOP-10_L4.9-W3.9-P1.0-LS6.0-TL-EP'],
    ] as const) {
      const part = makePart(ref, value, fp)
      const circuit = makeCircuit([part])
      const [res] = resolveAll(circuit, undefined, undefined, await realIndex())
      expect(res.status, `${value} has no model`).toBe('unresolved')
    }
  })
})
