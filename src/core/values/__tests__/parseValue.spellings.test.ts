/**
 * Real-world value spellings (issue #8): uppercase U/N/P, Greek mu, decimal
 * comma, whitespace, Ohm words, exponent notation, and the lowercase-m
 * European form (2m2 = 2.2 milli, not 2.2 mega).
 */
import { describe, expect, it } from 'vitest'

import { parseValue } from '../parseValue'

const close = (got: number | undefined, want: number): void => {
  expect(got).toBeDefined()
  expect(Math.abs((got as number) - want) / Math.abs(want)).toBeLessThan(1e-12)
}

describe('parseValue: real-world spellings (issue #8)', () => {
  it('European lowercase-m form is milli: "2m2" = 2.2 milliohm, "4m7" = 4.7 milli', () => {
    close(parseValue('2m2', 'R'), 2.2e-3)
    close(parseValue('4m7', 'L'), 4.7e-3)
  })

  it('European uppercase-M form is still mega: "4M7" = 4.7e6', () => {
    close(parseValue('4M7', 'R'), 4.7e6)
    close(parseValue('2M2', 'R'), 2.2e6)
  })

  it('a bare "M3" (screw size) is not a value', () => {
    expect(parseValue('M3', 'R')).toBeUndefined()
  })

  it('uppercase U, N, P prefixes', () => {
    close(parseValue('1U', 'C'), 1e-6)
    close(parseValue('10UF', 'C'), 1e-5)
    close(parseValue('100NF', 'C'), 1e-7)
    close(parseValue('22PF', 'C'), 2.2e-11)
    close(parseValue('4N7', 'C'), 4.7e-9)
    close(parseValue('4U7', 'C'), 4.7e-6)
    close(parseValue('10PF', 'C'), 1e-11)
  })

  it('Greek small mu (U+03BC) and micro sign (U+00B5)', () => {
    close(parseValue('4.7μ', 'C'), 4.7e-6)
    close(parseValue('1μF', 'C'), 1e-6)
    close(parseValue('4.7µ', 'C'), 4.7e-6)
    close(parseValue('4μ7', 'C'), 4.7e-6)
  })

  it('European decimal comma', () => {
    close(parseValue('4,7k', 'R'), 4700)
    close(parseValue('0,22', 'R'), 0.22)
    close(parseValue('2,2uF', 'C'), 2.2e-6)
    close(parseValue('4,7 kOhm', 'R'), 4700)
  })

  it('a thousands-shaped comma group is ambiguous and undefined', () => {
    expect(parseValue('1,000', 'R')).toBeUndefined()
    expect(parseValue('4,700k', 'R')).toBeUndefined()
  })

  it('a comma before a rating stays a delimiter', () => {
    close(parseValue('10uF,25V', 'C'), 1e-5)
    close(parseValue('100,25V', 'C'), 100)
  })

  it('whitespace between number, prefix and unit', () => {
    close(parseValue('10 k', 'R'), 1e4)
    close(parseValue('10 kΩ', 'R'), 1e4)
    close(parseValue('10 k Ω', 'R'), 1e4)
    close(parseValue('100 nF', 'C'), 1e-7)
    close(parseValue('4.7 µF', 'C'), 4.7e-6)
    close(parseValue('4.7 kOhm', 'R'), 4700)
    close(parseValue('4.7 k Ohm', 'R'), 4700)
    close(parseValue('100 nF 50V', 'C'), 1e-7)
    close(parseValue('10 kOhm 1%', 'R'), 1e4)
  })

  it('Ohm unit words and the omega sign, with and without a prefix', () => {
    close(parseValue('10kOhm', 'R'), 1e4)
    close(parseValue('10kohm', 'R'), 1e4)
    close(parseValue('10KOHM', 'R'), 1e4)
    close(parseValue('10 ohm', 'R'), 10)
    close(parseValue('10Ω', 'R'), 10)
    close(parseValue('10kΩ', 'R'), 1e4)
    close(parseValue('2.2MOhm', 'R'), 2.2e6)
    close(parseValue('10mOhm', 'R'), 1e-2)
  })

  it('exponent notation', () => {
    close(parseValue('1e-9', 'C'), 1e-9)
    close(parseValue('4.7E-6', 'C'), 4.7e-6)
    close(parseValue('1e+10', 'R'), 1e10)
    close(parseValue('2.2e3', 'R'), 2200)
    close(parseValue('1e-9F', 'C'), 1e-9)
  })

  it('text after a prefix that is not a unit is not a value', () => {
    expect(parseValue('10kV', 'R')).toBeUndefined()
    expect(parseValue('10UV', 'C')).toBeUndefined()
    expect(parseValue('1e999', 'R')).toBeUndefined()
  })

  it('every spelling of one value agrees with the canonical form', () => {
    const canonical = parseValue('10k', 'R')
    const resistor = ['10K', '10 k', '10kOhm', '10 kΩ', '10kΩ', '10,0k', '1e4', '10000', '10k/1%']
    for (const s of resistor) {
      expect(parseValue(s, 'R'), s).toBe(canonical)
    }
    const cap = parseValue('4.7u', 'C')
    const capacitor = ['4.7U', '4.7μ', '4.7µF', '4.7 µF', '4,7uF', '4u7', '4U7', '4.7e-6']
    for (const s of capacitor) {
      expect(parseValue(s, 'C'), s).toBeCloseTo(cap as number, 15)
    }
  })
})
