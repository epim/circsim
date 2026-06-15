import { describe, it, expect } from 'vitest'
import { parseValue } from '../parseValue'

describe('parseValue', () => {
  // Standard SI prefix cases
  it('"10k" → 1e4', () => {
    expect(parseValue('10k', 'R')).toBeCloseTo(1e4, 10)
  })

  it('"4k7" → 4.7e3 (European notation)', () => {
    expect(parseValue('4k7', 'R')).toBeCloseTo(4.7e3, 10)
  })

  it('"4.7u" → 4.7e-6', () => {
    expect(parseValue('4.7u', 'C')).toBeCloseTo(4.7e-6, 15)
  })

  it('"100n" → 1e-7', () => {
    expect(parseValue('100n', 'C')).toBeCloseTo(1e-7, 15)
  })

  it('"2.2Meg" → 2.2e6 (Meg = mega)', () => {
    expect(parseValue('2.2Meg', 'R')).toBeCloseTo(2.2e6, 5)
  })

  it('"1M" (R) → 1e6 (uppercase M = mega in value-field domain)', () => {
    expect(parseValue('1M', 'R')).toBeCloseTo(1e6, 10)
  })

  it('"1m" (R) → 1e-3 (lowercase m = milli in value-field domain)', () => {
    expect(parseValue('1m', 'R')).toBeCloseTo(1e-3, 10)
  })

  it('"0R22" → 0.22 (European R-as-decimal-point notation)', () => {
    expect(parseValue('0R22', 'R')).toBeCloseTo(0.22, 10)
  })

  it('"DNP" → undefined (do-not-populate)', () => {
    expect(parseValue('DNP', 'R')).toBeUndefined()
  })

  it('"10uF" → 1e-5 (trailing unit F ignored)', () => {
    expect(parseValue('10uF', 'C')).toBeCloseTo(1e-5, 15)
  })

  it('"470" (R) → 470 (plain number)', () => {
    expect(parseValue('470', 'R')).toBeCloseTo(470, 10)
  })

  // Additional edge cases
  it('"MEG" suffix → mega (case-insensitive Meg)', () => {
    expect(parseValue('3.3MEG', 'R')).toBeCloseTo(3.3e6, 5)
  })

  it('"47k" → 4.7e4', () => {
    expect(parseValue('47k', 'R')).toBeCloseTo(4.7e4, 10)
  })

  it('"1p" → 1e-12', () => {
    expect(parseValue('1p', 'C')).toBeCloseTo(1e-12, 20)
  })

  it('"1f" → 1e-15', () => {
    expect(parseValue('1f', 'L')).toBeCloseTo(1e-15, 24)
  })

  it('"22uH" → 2.2e-5 (trailing H unit ignored)', () => {
    expect(parseValue('22uH', 'L')).toBeCloseTo(2.2e-5, 15)
  })

  it('"10R" → 10 (R as unit suffix)', () => {
    expect(parseValue('10R', 'R')).toBeCloseTo(10, 10)
  })

  it('"4R7" → 4.7 (European R-as-decimal with trailing digit)', () => {
    expect(parseValue('4R7', 'R')).toBeCloseTo(4.7, 10)
  })

  it('"0.1" → 0.1 (plain decimal)', () => {
    expect(parseValue('0.1', 'R')).toBeCloseTo(0.1, 10)
  })

  it('"" → undefined (empty string)', () => {
    expect(parseValue('', 'R')).toBeUndefined()
  })

  it('"N/A" → undefined', () => {
    expect(parseValue('N/A', 'R')).toBeUndefined()
  })

  it('"~" → undefined (KiCad unfilled)', () => {
    expect(parseValue('~', 'R')).toBeUndefined()
  })

  it('whitespace trimmed: " 10k " → 1e4', () => {
    expect(parseValue(' 10k ', 'R')).toBeCloseTo(1e4, 10)
  })

  it('"2k2" → 2200 (European notation with k)', () => {
    expect(parseValue('2k2', 'R')).toBeCloseTo(2200, 10)
  })

  it('"33nF" → 3.3e-8 (trailing F unit)', () => {
    expect(parseValue('33nF', 'C')).toBeCloseTo(3.3e-8, 15)
  })
})
