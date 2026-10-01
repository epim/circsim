/**
 * Provenance fingerprint gate for the bundled discrete-semiconductor cards (issue #14).
 *
 * The .lib headers, index.json, docs/licensing.md and the About dialog state that
 * the bundled BJT, diode and LED cards were written in-house from datasheet
 * parameters. The Provenance: header check in license-hygiene only proves the word
 * exists. This test makes the claim enforceable: it fails when any bundled card's
 * parameter tuple matches a well-known third-party library card.
 *
 * What is stored here is a short tuple of distinguishing numbers per known card
 * (the fitted values that cannot be reproduced independently to three or four
 * significant figures), not the card text. The tuples come from the public
 * description in issue #14: the classic PSpice evaluation-library cards Q2N2222,
 * Q2N3904 and Q2N3906, the Motorola 1991 D1N4001 PSpice card, and the LTspice
 * standard.dio 1N4148 and 1N5819 cards.
 *
 * A bundled card is flagged when at least min(4, tuple length) of a fingerprint's
 * parameters agree within MATCH_TOLERANCE (relative). Rounding a third-party card
 * to three digits, changing a breakdown voltage, or renaming the model does not
 * evade it, because the comparison is by numbers of the same device polarity and
 * never by name.
 *
 * Adding a fingerprint: append to KNOWN_THIRD_PARTY_CARDS with the source.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseModelCards, type ParsedCard } from './spiceCards'

const MODELS_DIR = join(process.cwd(), 'resources', 'models')

/** Relative tolerance for "same fitted value": covers rounding to 3 digits. */
const MATCH_TOLERANCE = 0.03

// --- known third-party fingerprints -----------------------------------------

interface Fingerprint {
  /** Human-readable origin, printed when a bundled card matches. */
  source: string
  type: 'npn' | 'pnp' | 'd'
  /** Distinguishing fitted parameters of the third-party card. */
  params: Record<string, number>
}

const KNOWN_THIRD_PARTY_CARDS: Fingerprint[] = [
  {
    source: 'classic PSpice evaluation library Q2N2222 (Q2N2222A card)',
    type: 'npn',
    params: { is: 14.34e-15, bf: 255.9, vaf: 74.03, ikf: 0.2847, ne: 1.307, br: 6.092, tf: 411.1e-12, cjc: 7.306e-12, mjc: 0.3416, tr: 46.91e-9 }
  },
  {
    source: 'classic PSpice evaluation library Q2N3904 (Fairchild pid=23)',
    type: 'npn',
    params: { is: 6.734e-15, bf: 416.4, vaf: 74.03, ikf: 66.78e-3, ne: 1.259, br: 0.7371, tf: 301.2e-12, cjc: 3.638e-12, mjc: 0.3085, tr: 239.5e-9 }
  },
  {
    source: 'classic PSpice evaluation library Q2N3906 (Fairchild pid=66)',
    type: 'pnp',
    params: { is: 1.41e-15, bf: 180.7, vaf: 18.7, ikf: 80e-3, br: 4.977, tf: 179.3e-12, cjc: 9.728e-12, mjc: 0.5776, tr: 33.42e-9 }
  },
  {
    source: 'Motorola 1991 D1N4001 PSpice card (mid 1970s databook fit)',
    type: 'd',
    params: { is: 14.11e-9, n: 1.984, rs: 33.89e-3, cjo: 25.89e-12, vj: 0.3245, m: 0.44 }
  },
  {
    source: 'LTspice standard.dio 1N4148',
    type: 'd',
    params: { is: 2.52e-9, rs: 0.568, n: 1.752, cjo: 4e-12, m: 0.4, tt: 20e-9 }
  },
  {
    source: 'LTspice standard.dio 1N5819',
    type: 'd',
    params: { is: 31.7e-6, rs: 0.051, n: 1.373 }
  }
]

function closeTo(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  if (a === b) return true
  return Math.abs(a - b) <= MATCH_TOLERANCE * Math.max(Math.abs(a), Math.abs(b))
}

function normalisedType(t: string): string {
  return t.toLowerCase()
}

/** Fingerprints a card matches: same polarity and >= min(4, n) parameters agree. */
function matchFingerprints(
  card: Pick<ParsedCard, 'type' | 'params'>,
  fingerprints: Fingerprint[] = KNOWN_THIRD_PARTY_CARDS
): Fingerprint[] {
  return fingerprints.filter((fp) => {
    if (normalisedType(card.type) !== fp.type) return false
    const keys = Object.keys(fp.params)
    const hits = keys.filter((k) => closeTo(card.params[k], fp.params[k])).length
    return hits >= Math.min(4, keys.length)
  })
}

const DISCRETE_FILES = ['bjt.lib', 'diodes.lib', 'led.lib']

function bundledCards(): ParsedCard[] {
  return DISCRETE_FILES.flatMap((f) => parseModelCards(f, readFileSync(join(MODELS_DIR, f), 'utf8')))
}

// --- tests -------------------------------------------------------------------

describe('card parser (fingerprint helper)', () => {
  it('parses engineering suffixes and continuation lines', () => {
    const cards = parseModelCards(
      'x.lib',
      '.model QX NPN(is=14.34f bf=255.9 ikf=66.78m\n+ cje=22p tr=46.9n rb=1meg)\n'
    )
    expect(cards).toHaveLength(1)
    expect(cards[0].type).toBe('npn')
    expect(cards[0].params.is).toBeCloseTo(14.34e-15, 25)
    expect(cards[0].params.ikf).toBeCloseTo(0.06678, 8)
    expect(cards[0].params.cje).toBeCloseTo(22e-12, 20)
    expect(cards[0].params.rb).toBe(1e6)
  })
})

describe('fingerprint matcher (positive controls)', () => {
  it.each(KNOWN_THIRD_PARTY_CARDS.map((fp) => [fp.source, fp] as const))(
    'flags a card carrying the tuple of %s',
    (_source, fp) => {
      expect(matchFingerprints({ type: fp.type, params: { ...fp.params } })).toContain(fp)
    }
  )

  it('still flags a copy rounded to three digits with one value edited and a new name', () => {
    const fp = KNOWN_THIRD_PARTY_CARDS.find((f) => f.source.includes('Motorola'))!
    const rounded: Record<string, number> = {}
    for (const [k, v] of Object.entries(fp.params)) rounded[k] = Number(v.toPrecision(3))
    rounded.bv = 50 // edited from the source card
    expect(matchFingerprints({ type: 'd', params: rounded })).toContain(fp)
  })

  it('does not flag a card of the other polarity or with unrelated numbers', () => {
    const fp = KNOWN_THIRD_PARTY_CARDS[0]
    expect(matchFingerprints({ type: 'pnp', params: { ...fp.params } })).not.toContain(fp)
    expect(matchFingerprints({ type: 'npn', params: { is: 5e-15, bf: 200, vaf: 40 } })).toHaveLength(0)
  })
})

describe('bundled discrete cards carry no third-party fingerprint (issue #14)', () => {
  const cards = bundledCards()

  it('found the expected cards to check', () => {
    const names = cards.map((c) => c.name)
    for (const n of ['Q2N2222', 'Q2N3904', 'Q2N3906', 'D1N4001', 'D1N4148', 'D1N5819', 'LED_RED']) {
      expect(names).toContain(n)
    }
  })

  it.each(cards.map((c) => [`${c.file}:${c.name}`, c] as const))(
    '%s matches no known third-party library card',
    (_label, card) => {
      const hits = matchFingerprints(card)
      expect(
        hits.map((h) => h.source),
        `${card.file} card ${card.name} reproduces a third-party library card`
      ).toEqual([])
    }
  )
})
