/**
 * formatVolts.test.ts — F5: op annotations must never read "-0.000 V".
 *
 * The op-annotation voltage formatter (shared by the 3D labels and the
 * Viewport's DOM mirror) normalizes negative zero — and any value that rounds
 * to zero at the displayed precision — to exactly "0.000 V". Real readings
 * keep their sign and precision.
 */

import { describe, it, expect } from 'vitest'
import { formatVolts } from '../markers'

describe('formatVolts — negative-zero normalization (F5)', () => {
  it('-1e-7 → "0.000 V" (rounds to zero at displayed precision)', () => {
    expect(formatVolts(-1e-7)).toBe('0.000 V')
  })

  it('negative zero → "0.000 V"', () => {
    expect(formatVolts(-0)).toBe('0.000 V')
  })

  it('exact zero → "0.000 V"', () => {
    expect(formatVolts(0)).toBe('0.000 V')
  })

  it('any tiny negative below the 0.5 mV noise floor → "0.000 V", never "-0.000 V"', () => {
    for (const v of [-1e-12, -1e-9, -1e-6, -4.9e-4, 4.9e-4]) {
      expect(formatVolts(v)).toBe('0.000 V')
    }
  })

  it('-0.4 keeps its sign: "-0.400 V"', () => {
    expect(formatVolts(-0.4)).toBe('-0.400 V')
  })

  it('normal magnitudes unchanged: 5 → "5.000 V", 2.5 → "2.500 V"', () => {
    expect(formatVolts(5)).toBe('5.000 V')
    expect(formatVolts(2.5)).toBe('2.500 V')
  })

  it('small-but-representable readings keep e-notation: 6e-4 → "6.000e-4 V"', () => {
    expect(formatVolts(6e-4)).toBe('6.000e-4 V')
    expect(formatVolts(-6e-4)).toBe('-6.000e-4 V')
  })

  it('-0.001 keeps its sign at fixed precision', () => {
    expect(formatVolts(-0.001)).toBe('-0.001 V')
  })
})
