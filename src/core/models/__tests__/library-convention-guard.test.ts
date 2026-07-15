/**
 * Convention partition guard for two-terminal polarized parts (diodes/LEDs).
 *
 * The D7 class of error (led_lantern rev B, fixed in f6680b6): a pinMaps key
 * regex matched a footprint NAME from a library whose pad-numbering
 * convention differs from what the key's MAP assumes. The regex was right
 * about "this is an SMC package" but wrong about "therefore pad 1 = cathode"
 * — KiCad D_* footprints put pad 1 = cathode, JLC/EasyEDA footprints put
 * pad 1 = anode. The diode was silently modeled REVERSED (no warning), and
 * only the board review caught it.
 *
 * Unlike the example-based tests in library-content.test.ts (which pin the
 * entries known today), this guard encodes the RULE, so it also covers
 * entries added later:
 *
 *  - CORPUS holds real footprint names tagged with their known convention.
 *    It is the single place where "what we believe about pad numbering"
 *    lives; extend it when a new library family appears.
 *  - Every corpus name is run through the REAL selectPinMap against every
 *    two-terminal polarized entry (auto-detected — no hand-kept entry list).
 *    Any confident match (regex hit, not the warned defaultPinMap fallback)
 *    must yield the polarity the name's convention demands.
 *  - Because selectPinMap is first-key-match-wins, this is order-sensitive
 *    by construction: reordering an entry's pinMaps keys (e.g. alphabetizing
 *    the JSON) resurrects the D7 bug, and this guard fails on it.
 *  - Coverage rule: a polarized entry none of whose keys match ANY corpus
 *    name is an untested polarity claim — that fails too.
 *
 * Honest limit: a guard can only be as right as its corpus. A consistently
 * held wrong belief about a convention passes; the structural defense for
 * that is the schematic polarity audit (Critic check candidate — see
 * docs/backlog.md), since attached-schematic pin names (A/K) are ground
 * truth.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { selectPinMap } from '../libraryMatch'
import type { LibraryEntry } from '../types'

const MODELS_DIR = join(process.cwd(), 'resources', 'models')

function readIndex(): { entries: LibraryEntry[] } {
  return JSON.parse(readFileSync(join(MODELS_DIR, 'index.json'), 'utf8'))
}

const CATHODE_FIRST = { '1': '2', '2': '1' }
const ANODE_FIRST = { '1': '1', '2': '2' }

type Convention = 'kicad' | 'easyeda'

/**
 * Real footprint names tagged with their known pad-numbering convention.
 * kicad: pad 1 = cathode (KiCad-official D_* / LED_* footprints).
 * easyeda: pad 1 = anode (JLC/EasyEDA-origin footprints — lib-prefixed and
 * the bare dimension-pattern form routed boards present).
 */
const CORPUS: Array<[string, Convention]> = [
  ['Diode_SMD:D_SMC', 'kicad'],
  ['Diode_SMD:D_SMA', 'kicad'],
  ['Diode_SMD:D_SMB', 'kicad'],
  ['Diode_SMD:D_SMC_Handsoldering', 'kicad'],
  ['Diode_SMD:D_SOD-123', 'kicad'],
  ['Diode_SMD:D_SOD-323', 'kicad'],
  ['Diode_SMD:D_MiniMELF', 'kicad'],
  ['Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal', 'kicad'],
  ['Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal', 'kicad'],
  ['LED_SMD:LED_0603_1608Metric', 'kicad'],
  ['LED_SMD:LED_0805_2012Metric', 'kicad'],
  ['LED_THT:LED_D5.0mm', 'kicad'],
  ['JLC-MCP:SMC_L7.1-W6.2-LS8.1-R-RD', 'easyeda'], // lantern rev B D7 (SS54)
  ['SMC_L7.1-W6.2-LS8.1-R-RD', 'easyeda'], // …as circsim sees it (bare)
  ['JLC-MCP:SMA_L4.4-W2.8-LS5.4-R-RD', 'easyeda'], // lantern D8/D9 (SS14)
  ['SMA_L4.4-W2.8-LS5.4-R-RD', 'easyeda'],
  ['SOD-123_L2.8-W1.8-LS3.7-RD', 'easyeda'],
  ['SOD-323_L1.8-W1.3-LS2.5-RD', 'easyeda'],
]

const POLARITY_BY_CONVENTION: Record<Convention, Record<string, string>> = {
  kicad: CATHODE_FIRST,
  easyeda: ANODE_FIRST,
}

function isPolarityMap(m: Record<string, string> | undefined): boolean {
  if (!m) return false
  const s = JSON.stringify(m)
  return s === JSON.stringify(CATHODE_FIRST) || s === JSON.stringify(ANODE_FIRST)
}

/** Two-terminal polarized part = any map is a permutation of {1,2}. */
function isTwoTerminalPolarized(entry: LibraryEntry): boolean {
  return [...Object.values(entry.pinMaps ?? {}), entry.defaultPinMap ?? {}].some(isPolarityMap)
}

/**
 * Compute the guard violations for one entry. Only confident matches count:
 * the defaultPinMap fallback carries the pinmap-unverified warning — that is
 * the honest path, not a silent polarity claim.
 */
function violations(entry: LibraryEntry): string[] {
  const out: string[] = []
  let confidentMatches = 0
  for (const [name, convention] of CORPUS) {
    const { pinMap, warnings } = selectPinMap(entry, name)
    if (warnings.length > 0) continue // fallback path — warned, not confident
    confidentMatches++
    const expected = POLARITY_BY_CONVENTION[convention]
    if (JSON.stringify(pinMap) !== JSON.stringify(expected)) {
      out.push(
        `"${name}" (${convention}) silently resolves ${JSON.stringify(pinMap)}; ` +
          `expected ${JSON.stringify(expected)} — polarity REVERSED`,
      )
    }
  }
  if (confidentMatches === 0) {
    out.push('no corpus name exercises any pinMaps key — untested polarity claim')
  }
  return out
}

describe('convention partition guard — two-terminal polarized entries', () => {
  const polarized = readIndex().entries.filter(isTwoTerminalPolarized)

  it('the index contains two-terminal polarized entries (guard is not vacuous)', () => {
    expect(polarized.length).toBeGreaterThanOrEqual(12) // 7 diodes + 5 LEDs today
  })

  it.each(polarized.map((e) => [e.id, e] as const))(
    '%s: every confident footprint match yields the convention’s polarity',
    (_id, entry) => {
      expect(violations(entry)).toEqual([])
    },
  )
})

describe('guard self-test — must actually detect the D7 failure shapes', () => {
  // The pre-fix schottky-ss54 shape: one over-broad KiCad-polarity key that
  // also matches EasyEDA names. This is the exact bug that reversed D7.
  const preFixSs54: LibraryEntry = {
    id: 'self-test-prefix-ss54',
    match: { mpn: ['SS54'] },
    model: { type: 'model-card', file: 'diodes.lib', name: 'DSS54' },
    pinMaps: { '(D_)?(SMC|SMB|SMA|DO-214|DO-201).*': CATHODE_FIRST },
    defaultPinMap: CATHODE_FIRST,
    provenance: 'guard self-test fixture — reconstruction of the pre-f6680b6 entry shape',
  }

  it('flags the pre-fix over-broad key (would have caught D7)', () => {
    const v = violations(preFixSs54)
    expect(v.length).toBeGreaterThan(0)
    expect(v.some((m) => m.includes('SMC_L7.1-W6.2-LS8.1-R-RD'))).toBe(true)
  })

  it('flags a correct entry whose keys were reordered (first-match-wins fragility)', () => {
    const fixed = readIndex().entries.find((e) => e.id === 'schottky-ss54')!
    const reordered: LibraryEntry = {
      ...fixed,
      pinMaps: Object.fromEntries(Object.entries(fixed.pinMaps).reverse()),
    }
    expect(violations(fixed)).toEqual([])
    expect(violations(reordered).length).toBeGreaterThan(0)
  })
})
