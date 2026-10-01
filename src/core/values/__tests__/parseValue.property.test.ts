/**
 * Property tests for the component value parser (issue #67).
 *
 * parseValue reads the value field of a KiCad part; formatSpiceValue writes the
 * number back into a deck card. Properties:
 *   1. plain decimals emitted by formatSpiceValue parse back within 1e-9 relative
 *   2. generated spellings in the parser's documented convention parse to the
 *      product of mantissa and prefix (standard, trailing unit, European form)
 *   3. a rating or tolerance suffix never changes the value
 *   4. the parser never throws, and a defined result is a finite non-negative number
 *      for inputs that look like a value
 *
 *   5. alternate spellings of one value (uppercase U/N/P, Greek mu, decimal comma,
 *      whitespace, Ohm words, exponent notation) parse to the same number (#8)
 *
 * Exponent-form round trips and the lowercase-m European form (2m2 = 2.2 milli)
 * were `it.fails` markers for #8 and are now ordinary properties.
 */

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { formatSpiceValue } from '../../spicegen/generate'
import { parseValue } from '../parseValue'

const relErr = (got: number, want: number): number => Math.abs(got - want) / Math.abs(want)

const positive = (lo: number, hi: number): fc.Arbitrary<number> =>
  fc.double({ min: lo, max: hi, noNaN: true })

describe('parseValue vs formatSpiceValue', () => {
  it('plain-decimal output (0.001 to under 1e9) round-trips within 1e-9 relative', () => {
    fc.assert(
      fc.property(positive(0.001, 999_999_999), fc.constantFrom<'R' | 'C' | 'L'>('R', 'C', 'L'), (v, kind) => {
        const text = formatSpiceValue(v)
        expect(text).not.toMatch(/e/i)
        const back = parseValue(text, kind)
        expect(back).toBeDefined()
        expect(relErr(back as number, v)).toBeLessThan(1e-9)
      }),
      { numRuns: 500 }
    )
  })

  it('integers and round decades emitted by formatSpiceValue parse exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999_999_999 }), (n) => {
        expect(parseValue(formatSpiceValue(n), 'R')).toBe(n)
      }),
      { numRuns: 300 }
    )
  })

  // formatSpiceValue emits "4.7e-06" and "1e+10" below 1 mOhm and above 1e9;
  // those exponent forms must parse back (#8).
  it('exponent-form output (under 0.001 or 1e9 and over) round-trips', () => {
    fc.assert(
      fc.property(
        fc.oneof(positive(1e-15, 0.000999), positive(1e9, 1e12)),
        (v) => {
          const back = parseValue(formatSpiceValue(v), 'C')
          expect(back).toBeDefined()
          expect(relErr(back as number, v)).toBeLessThan(1e-9)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// Prefixes in the documented convention (parseValue.ts header): uppercase M is
// mega, lowercase m is milli.
const PREFIXES: Array<[string, number]> = [
  ['', 1],
  ['k', 1e3],
  ['K', 1e3],
  ['M', 1e6],
  ['G', 1e9],
  ['T', 1e12],
  ['m', 1e-3],
  ['u', 1e-6],
  ['n', 1e-9],
  ['p', 1e-12],
  ['f', 1e-15]
]
const prefixArb = fc.constantFrom(...PREFIXES)
const mantissaArb = fc.oneof(
  fc.integer({ min: 1, max: 999 }).map((n) => String(n)),
  fc
    .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 1, max: 99 }))
    .map(([a, b]) => `${a}.${b}`)
)
const unitFor = (kind: 'R' | 'C' | 'L'): string => ({ R: 'R', C: 'F', L: 'H' })[kind]

describe('parseValue spellings', () => {
  it('<mantissa><prefix> parses to mantissa times prefix', () => {
    fc.assert(
      fc.property(mantissaArb, prefixArb, (m, [p, mult]) => {
        const got = parseValue(`${m}${p}`, 'R')
        expect(got).toBeDefined()
        expect(relErr(got as number, Number(m) * mult)).toBeLessThan(1e-9)
      }),
      { numRuns: 500 }
    )
  })

  it('a trailing unit letter (R, F, H) never changes the value', () => {
    fc.assert(
      fc.property(
        mantissaArb,
        prefixArb.filter(([p]) => p !== ''),
        fc.constantFrom<'R' | 'C' | 'L'>('R', 'C', 'L'),
        (m, [p, mult], kind) => {
          const got = parseValue(`${m}${p}${unitFor(kind)}`, kind)
          expect(got).toBeDefined()
          expect(relErr(got as number, Number(m) * mult)).toBeLessThan(1e-9)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('European form <int><prefix><frac> (4k7, 2R2, 1u5) reads the prefix as the decimal point', () => {
    const euro = fc.constantFrom<[string, number]>(
      ['k', 1e3],
      ['K', 1e3],
      ['u', 1e-6],
      ['n', 1e-9],
      ['p', 1e-12],
      ['f', 1e-15],
      ['R', 1]
    )
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        euro,
        fc.integer({ min: 1, max: 999 }),
        (a, [sep, mult], b) => {
          const got = parseValue(`${a}${sep}${b}`, 'R')
          expect(got).toBeDefined()
          expect(relErr(got as number, Number(`${a}.${b}`) * mult)).toBeLessThan(1e-9)
        }
      ),
      { numRuns: 500 }
    )
  })

  // 2m2 is 2.2 milli in the file's own convention; the European M branch used
  // to be case-insensitive and read it as 2.2 mega (#8).
  it('lowercase-m European form (2m2, 4m7) is milli', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), (a, b) => {
        const got = parseValue(`${a}m${b}`, 'R')
        expect(got).toBeDefined()
        expect(relErr(got as number, Number(`${a}.${b}`) * 1e-3)).toBeLessThan(1e-9)
      }),
      { numRuns: 100 }
    )
  })

  it('a voltage rating or tolerance suffix never changes the value', () => {
    const suffix = fc.oneof(
      fc.integer({ min: 1, max: 999 }).map((n) => `${n}V`),
      fc.integer({ min: 1, max: 20 }).map((n) => `${n}%`)
    )
    const delim = fc.constantFrom('/', ',', ' ')
    fc.assert(
      fc.property(mantissaArb, prefixArb, suffix, delim, (m, [p], suf, d) => {
        const bare = parseValue(`${m}${p}`, 'C')
        expect(bare).toBeDefined()
        expect(parseValue(`${m}${p}${d}${suf}`, 'C')).toBe(bare)
      }),
      { numRuns: 400 }
    )
  })

  it('surrounding whitespace never changes the value', () => {
    fc.assert(
      fc.property(
        mantissaArb,
        prefixArb,
        fc.constantFrom('', ' ', '  ', '\t'),
        fc.constantFrom('', ' ', '\t'),
        (m, [p], lead, trail) => {
          expect(parseValue(`${lead}${m}${p}${trail}`, 'R')).toBe(parseValue(`${m}${p}`, 'R'))
        }
      ),
      { numRuns: 300 }
    )
  })
})

describe('parseValue alternate spellings (issue #8)', () => {
  const mu = fc.constantFrom('u', 'U', 'µ', 'μ')
  const kind = fc.constantFrom<'R' | 'C' | 'L'>('R', 'C', 'L')
  const fracArb = fc.tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 1, max: 99 }))

  it('micro, nano and pico prefixes are the same in any accepted case or mu glyph', () => {
    const prefix = fc.constantFrom<[string, number]>(
      ['u', 1e-6],
      ['U', 1e-6],
      ['µ', 1e-6],
      ['μ', 1e-6],
      ['n', 1e-9],
      ['N', 1e-9],
      ['p', 1e-12],
      ['P', 1e-12]
    )
    fc.assert(
      fc.property(mantissaArb, prefix, fc.constantFrom('', 'F', ' F'), (m, [p, mult], unit) => {
        const got = parseValue(`${m}${p}${unit}`, 'C')
        expect(got).toBeDefined()
        expect(relErr(got as number, Number(m) * mult)).toBeLessThan(1e-9)
      }),
      { numRuns: 500 }
    )
  })

  it('European form accepts every micro spelling and uppercase N/P', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), mu, fc.integer({ min: 1, max: 999 }), (a, sep, b) => {
        const got = parseValue(`${a}${sep}${b}`, 'C')
        expect(got).toBeDefined()
        expect(relErr(got as number, Number(`${a}.${b}`) * 1e-6)).toBeLessThan(1e-9)
      }),
      { numRuns: 300 }
    )
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        fc.constantFrom<[string, number]>(['N', 1e-9], ['P', 1e-12]),
        fc.integer({ min: 1, max: 999 }),
        (a, [sep, mult], b) => {
          const got = parseValue(`${a}${sep}${b}`, 'C')
          expect(got).toBeDefined()
          expect(relErr(got as number, Number(`${a}.${b}`) * mult)).toBeLessThan(1e-9)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('a decimal comma reads as a decimal point', () => {
    fc.assert(
      fc.property(
        fracArb.filter(([a, b]) => !(a >= 1 && b >= 100)),
        prefixArb,
        kind,
        ([a, b], [p], k) => {
          const dot = parseValue(`${a}.${b}${p}${unitFor(k)}`, k)
          const comma = parseValue(`${a},${b}${p}${unitFor(k)}`, k)
          expect(dot).toBeDefined()
          expect(comma).toBe(dot)
        }
      ),
      { numRuns: 400 }
    )
  })

  it('whitespace between number, prefix and unit never changes the value', () => {
    const gap = fc.constantFrom('', ' ', '  ', '	')
    const prefixNoEmpty = prefixArb.filter(([p]) => p !== '')
    fc.assert(
      fc.property(mantissaArb, prefixNoEmpty, kind, gap, gap, (m, [p], k, g1, g2) => {
        const tight = parseValue(`${m}${p}${unitFor(k)}`, k)
        expect(tight).toBeDefined()
        expect(parseValue(`${m}${g1}${p}${g2}${unitFor(k)}`, k)).toBe(tight)
      }),
      { numRuns: 400 }
    )
  })

  it('Ohm, Ohms and the omega signs are the unit, never a multiplier', () => {
    const unit = fc.constantFrom('Ohm', 'ohm', 'OHM', 'Ohms', 'Ω', 'Ω')
    fc.assert(
      fc.property(mantissaArb, prefixArb, unit, fc.constantFrom('', ' '), (m, [p, mult], u, g) => {
        // A bare lowercase "m" before "ohm" is milli-ohm: same rule as "10mR".
        const got = parseValue(`${m}${g}${p}${u}`, 'R')
        expect(got).toBeDefined()
        expect(relErr(got as number, Number(m) * mult)).toBeLessThan(1e-9)
      }),
      { numRuns: 500 }
    )
  })

  it('exponent spelling equals the decimal spelling', () => {
    fc.assert(
      fc.property(mantissaArb, fc.integer({ min: -15, max: 12 }), fc.constantFrom('e', 'E'), (m, exp, e) => {
        const got = parseValue(`${m}${e}${exp}`, 'C')
        expect(got).toBeDefined()
        expect(relErr(got as number, Number(`${m}e${exp}`))).toBeLessThan(1e-9)
      }),
      { numRuns: 400 }
    )
  })

  it('the M/m distinction survives every spelling: M is mega, m is milli', () => {
    fc.assert(
      fc.property(mantissaArb, fc.constantFrom('', 'R', 'Ohm', 'Ω'), (m, unit) => {
        expect(relErr(parseValue(`${m}M${unit}`, 'R') as number, Number(m) * 1e6)).toBeLessThan(1e-9)
        expect(relErr(parseValue(`${m}m${unit}`, 'R') as number, Number(m) * 1e-3)).toBeLessThan(1e-9)
      }),
      { numRuns: 300 }
    )
  })
})

describe('parseValue totality', () => {
  it('never throws on arbitrary text; a defined result is a finite number', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 30 }), (text) => {
        const v = parseValue(text, 'R')
        if (v !== undefined) {
          expect(typeof v).toBe('number')
          expect(Number.isFinite(v)).toBe(true)
        }
      }),
      { numRuns: 1000 }
    )
  })

  it('never throws on value-shaped noise', () => {
    const chars = fc.constantFrom(...'0123456789.kKMmGTunpfUNPRrFHVΩµμΩ%/, eEgGohs-+\t'.split(''))
    fc.assert(
      fc.property(fc.array(chars, { maxLength: 14 }), (cs) => {
        const v = parseValue(cs.join(''), 'C')
        if (v !== undefined) expect(Number.isFinite(v)).toBe(true)
      }),
      { numRuns: 2000 }
    )
  })

  it('placeholders are undefined, not zero', () => {
    for (const s of ['', ' ', '~', 'DNP', 'dnp', 'N/A', 'TBD', '--', 'none']) {
      expect(parseValue(s, 'R'), JSON.stringify(s)).toBeUndefined()
    }
  })
})
