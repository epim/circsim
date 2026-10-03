import { describe, expect, it } from 'vitest'
import { transientMaxStep } from '../transientStep'

describe('transientMaxStep', () => {
  it('keeps the requested step for absent or invalid waveform periods and non-source cards', () => {
    expect(transientMaxStep(0.005, [
      'v1 a 0 SIN(0 1)', 'i1 b 0 SIN(0 1 0)', 'v2 c 0 SIN(0 1 -1)',
      'v3 d 0 PULSE(0 5 0 1n 1n 1u)', 'b1 e 0 v=SIN(0 1 1k)',
      '* v4 f 0 SIN(0 1 1meg)',
    ])).toBe(0.005)
  })

  it('parses SPICE engineering suffixes and keeps an explicitly finer request', () => {
    expect(transientMaxStep(0.005, ['v1 a 0 SIN(0 1 1k)'])).toBeCloseTo(5e-6, 15)
    expect(transientMaxStep(0.005, ['i1 a 0 SIN(0 1 10meg)'])).toBeCloseTo(5e-10, 18)
    expect(transientMaxStep(0.005, ['v1 a 0 PULSE(0 5 0 1n 1n 1u 2.2u)'])).toBeCloseTo(11e-9, 15)
    expect(transientMaxStep(0.005, ['v1 a 0 PULSE(0 5 0 1u 1u 1 2M)'])).toBeCloseTo(10e-6, 15)
    expect(transientMaxStep(1e-9, ['v1 a 0 SIN(0 1 1k)'])).toBe(1e-9)
  })

  it('resolves an unforced RC node to at least 10 steps per time constant', () => {
    expect(transientMaxStep(0.005, ['v1 in 0 5', 'r1 in out 1k', 'c1 out 0 1u'])).toBeCloseTo(100e-6, 15)
    expect(transientMaxStep(0.005, ['v1 in 0 5', 'r1 in out 1k', 'r2 out 0 1k', 'c1 out 0 1u'])).toBeCloseTo(50e-6, 15)
  })

  it('finds timing nodes across copper while ignoring supply-clamped caps and model-local nodes', () => {
    expect(transientMaxStep(0.005, [
      'v1 vcc 0 5', 'r_copper_1 timer cap 0.0001', 'r_copper_2 return 0 0.0001',
      'r1 disch timer 47k', 'c1 cap return 100n', 'c2 vcc 0 1p',
      '.subckt model a b', 'r_internal a b 1', 'c_internal a b 1p', '.ends model',
    ])).toBeCloseTo(470e-6, 15)
  })

  it('bounds feedback RC without applying the bound to model power bypasses', () => {
    expect(transientMaxStep(0.005, [
      'v1 supply 0 5', 'rsource supply vcc 0.1', 'rrail vcc vdd 1',
      'c_bypass1 vcc 0 100n', 'c_bypass2 vdd 0 100n',
      'r_feedback out timing 100k', 'c_timing timing 0 10n',
      'x1 timing out vcc 0 amplifier', 'b_u1_icc vdd 0 I = 0.001',
      'b_input adc 0 V = v(timing)*5/max(v(vdd),1e-6)',
      '.subckt amplifier inp out vcc gnd', '.ends amplifier',
    ])).toBeCloseTo(100e-6, 15)
  })

  it('leaves generated supply bypasses to native refinement even in a passive copper deck', () => {
    expect(transientMaxStep(0.005, [
      'vpsu_bench internal 0 DC 5', 'rpsu_bench internal rail 0.1',
      'r_copper_1 rail pad 0.0001', 'rload pad 0 1k', 'c_bypass pad 0 100n',
    ])).toBe(0.005)
  })
})
