/**
 * resolveAll and generateDeck scale linearly with the board (issue #76).
 *
 * resolveAll rebuilt a netId to spiceNode map over every net for every part,
 * normalized every library entry's MPNs and compiled its regexes for every part,
 * and generateDeck looked each resolution's part up with a linear find. Each was
 * parts x (nets | library | parts).
 *
 * The timing tests compare one board size with another ten times larger and
 * assert the ratio of the two times, never an absolute duration (CI runners are
 * up to 5x slower than a dev machine, which scales both times alike). The two
 * sizes are timed in alternation, so a burst of load from other test files
 * lands on both alike, and each is scored by its fastest run. Linear code
 * measures about 11 for resolveAll and 14 to 18 for generateDeck at this
 * scale (a little over SCALE: the large board falls out of cache); the
 * quadratic loops measured 48 or more and 69 or more. Each bound sits between
 * the two with at least a 1.5x margin on both sides. The differential tests pin
 * behavior: the indexed library match must agree with a plain scan of the
 * library for every part.
 */

import { describe, expect, it } from 'vitest'

import { generateDeck } from '../../spicegen/generate'
import { matchLibraryEntry, buildLibraryIndex, normalizeMpn, type PartDescriptor } from '../libraryMatch'
import { resolveAll } from '../resolve'
import type { LibraryEntry } from '../types'
import { bundledLibrary, scaleCircuit } from './scaleCircuit'

const SMALL = 1000
const SCALE = 10
const LARGE = SMALL * SCALE

/** Linear code measures about 11; the quadratic loops measured 48 and up. */
const MAX_RESOLVE_RATIO = 25
/** Linear code measures 14 to 18; the quadratic loops measured 69 and up. */
const MAX_DECK_RATIO = 35

/**
 * Fastest run of each of two functions, alternating small and large so both see
 * the same machine conditions. The minimum is the run least disturbed by GC and
 * the scheduler.
 */
function bestPairMs(small: () => unknown, large: () => unknown, runs = 15): [number, number] {
  let bestSmall = Infinity
  let bestLarge = Infinity
  for (let i = 0; i < runs; i++) {
    let t0 = performance.now()
    small()
    bestSmall = Math.min(bestSmall, performance.now() - t0)
    t0 = performance.now()
    large()
    bestLarge = Math.min(bestLarge, performance.now() - t0)
  }
  return [bestSmall, bestLarge]
}

describe('resolveAll and generateDeck growth (issue #76)', () => {
  const library = bundledLibrary()
  const small = scaleCircuit(SMALL)
  const large = scaleCircuit(LARGE)

  it('the scale circuits have the shape the growth test relies on', () => {
    expect(small.parts.length).toBe(SMALL)
    expect(large.parts.length).toBe(LARGE)
    expect(large.nets.length).toBeGreaterThan(LARGE)
    const res = resolveAll(small, undefined, undefined, library)
    const byTier = new Set(res.map((r) => `${r.status}:${r.tier}`))
    // tier 2 passives, tier 3 library parts, and unresolved leftovers
    expect(byTier.has('ok:2')).toBe(true)
    expect(byTier.has('ok:3')).toBe(true)
    expect(byTier.has('unresolved:6')).toBe(true)
  })

  it('resolveAll time grows linearly with parts', { timeout: 180_000 }, () => {
    const run = (c: typeof small) => resolveAll(c, undefined, undefined, library)
    run(small) // warm the JIT before timing
    const [tSmall, tLarge] = bestPairMs(() => run(small), () => run(large))
    expect(tLarge / tSmall).toBeLessThan(MAX_RESOLVE_RATIO)
  })

  it('generateDeck time grows linearly with parts', { timeout: 180_000 }, () => {
    const prepare = (c: typeof small) => {
      const ground = c.nets.find((n) => n.spiceNode === '0')!
      const resolutions = resolveAll(c, undefined, undefined, library)
      return () => generateDeck({ circuit: c, resolutions, instruments: [], groundNetId: ground.id })
    }
    const deckSmall = prepare(small)
    const deckLarge = prepare(large)
    deckSmall()
    const [tSmall, tLarge] = bestPairMs(deckSmall, deckLarge)
    expect(tLarge / tSmall).toBeLessThan(MAX_DECK_RATIO)
  })
})

// ─── Differential: the index agrees with a scan of the library ───────────────

/**
 * The matcher as it was before the index: every entry tested for every part.
 * Kept here, verbatim in behavior, as the oracle the indexed matcher is held to.
 */
function scanMatch(part: PartDescriptor, library: LibraryEntry[]) {
  const NON_DEVICE = new Set([
    'R', 'RV', 'RN', 'RP', 'RT', 'RK', 'C', 'CP', 'L', 'FB', 'F', 'FU', 'TH', 'VDR',
    'BT', 'BAT', 'SW', 'S', 'K', 'RLY', 'J', 'P', 'CN', 'CON', 'JP', 'SP',
    'TP', 'H', 'MH', 'FID', 'MK', 'NT', 'ANT', 'Y', 'LS', 'BZ',
  ])
  const prefix = (/^([A-Za-z]+)/.exec(part.ref)?.[1] ?? '').toUpperCase()
  const allowed = !NON_DEVICE.has(prefix)
  const prefer = (m: LibraryEntry[]) => {
    if (m.length < 2) return m
    const modeled = m.filter((e) => e.model.type !== 'documented-open')
    return modeled.length > 0 ? modeled : m
  }
  const byMpn = (e: LibraryEntry) =>
    !!part.mpn && !!e.match.mpn && e.match.mpn.some((x) => normalizeMpn(x) === normalizeMpn(part.mpn!))
  const byValue = (e: LibraryEntry) => {
    let p = e.match.valueRegex
    if (!p) return false
    let flags = ''
    if (p.startsWith('(?i)')) {
      p = p.slice(4)
      flags = 'i'
    }
    try {
      return new RegExp(p, flags).test(part.value)
    } catch {
      return false
    }
  }
  const byFallback = (e: LibraryEntry) => {
    const { refdesPrefix: prefixes, footprintRegex } = e.match
    if (!footprintRegex) return false
    if (prefixes && prefixes.length > 0 && !prefixes.map((p) => p.toUpperCase()).includes(prefix)) return false
    try {
      return new RegExp(footprintRegex, 'i').test(part.libId)
    } catch {
      return false
    }
  }
  const tiers: Array<['mpn' | 'valueRegex' | 'fallback', LibraryEntry[]]> = [
    ['mpn', prefer(library.filter((e) => byMpn(e) && (!part.mpnIsValue || allowed)))],
    ['valueRegex', prefer(library.filter((e) => byValue(e) && allowed))],
    ['fallback', prefer(library.filter(byFallback))],
  ]
  for (const [tier, m] of tiers) {
    if (m.length === 1) return { kind: 'match', entry: m[0], tier }
    if (m.length > 1) return { kind: 'ambiguous', candidates: m.map((e) => e.id), tier }
  }
  return { kind: 'none' }
}

function entry(id: string, match: LibraryEntry['match'], open = false): LibraryEntry {
  return {
    id,
    match,
    model: open ? { type: 'documented-open', name: id } : { type: 'model-card', file: `${id}.lib`, name: id },
    note: open ? 'not modeled' : undefined,
    pinMaps: {},
    provenance: 'test',
  }
}

describe('indexed library match agrees with a scan of the library', () => {
  const bundled = bundledLibrary()
  // User models are prepended at runtime; add duplicates, an open entry that must
  // yield, entries with no refdes prefix, a prefix-only list, and bad regexes.
  const library: LibraryEntry[] = [
    entry('user-1n4148', { mpn: ['1N4148W'] }),
    entry('open-twin', { mpn: ['CH224K', 'CH224KX'] }, true),
    entry('modeled-twin', { mpn: ['CH224K'] }),
    entry('dup-a', { mpn: ['ZZ100', 'ZZ100D'] }),
    entry('dup-b', { mpn: ['ZZ100DR'] }),
    entry('anyprefix-fp', { footprintRegex: 'QFN-48' }),
    entry('multi-prefix-fp', { refdesPrefix: ['u', 'IC'], footprintRegex: 'QFN-48' }),
    entry('bad-value', { valueRegex: '(' }),
    entry('bad-fp', { refdesPrefix: ['D'], footprintRegex: '[' }),
    entry('ci-value', { valueRegex: '(?i)^mystery' }),
    entry('cs-value', { valueRegex: '^Mystery' }),
    ...bundled,
  ]

  const descriptors: PartDescriptor[] = []
  const circuit = scaleCircuit(200)
  for (const p of circuit.parts) {
    descriptors.push({ mpn: p.value, mpnIsValue: true, libId: p.libId, value: p.value, ref: p.ref })
  }
  const extra: Array<[string, string | undefined, boolean, string, string]> = [
    ['U1', 'CH224K', false, 'Package_DFN_QFN:QFN-48', 'CH224K'],
    ['U2', 'ZZ100DR', false, 'Package_SO:SOIC-8', 'x'],
    ['U3', undefined, true, 'Package_DFN_QFN:QFN-48', 'blob'],
    ['IC4', undefined, true, 'Package_DFN_QFN:QFN-48', 'blob'],
    ['D5', undefined, true, 'Diode_SMD:D_SOD-123', 'MysteryX'],
    ['D6', undefined, true, 'Diode_SMD:D_SOD-123', 'mysteryx'],
    ['BT1', '3V0', true, 'Battery:BatteryHolder', '3V0'],
    ['BT2', '3V0', false, 'Battery:BatteryHolder', '3V0'],
    ['SW1', undefined, true, 'Button_Switch:SW_Push', '555'],
    ['U7', undefined, true, 'Package_SO:SOIC-8', '555'],
    ['1', undefined, true, 'Package_DFN_QFN:QFN-48', 'blob'],
    ['D8', '  ', true, 'LED_SMD:LED_0805_2012Metric', 'LED'],
  ]
  for (const [ref, mpn, mpnIsValue, libId, value] of extra) {
    descriptors.push({ mpn, mpnIsValue, libId, value, ref })
  }

  it('gives the same result for every part, with a shared index and with none', () => {
    const index = buildLibraryIndex(library)
    for (const d of descriptors) {
      const want = scanMatch(d, library)
      expect(matchLibraryEntry(d, library, index), `${d.ref} ${d.value} shared`).toEqual(want)
      expect(matchLibraryEntry(d, library), `${d.ref} ${d.value} fresh`).toEqual(want)
    }
  })

  it('a second ask of the same index returns the same answer (cached lists are not mutated)', () => {
    const index = buildLibraryIndex(library)
    for (const d of descriptors) {
      const first = matchLibraryEntry(d, library, index)
      const second = matchLibraryEntry(d, library, index)
      expect(second).toEqual(first)
    }
  })
})
