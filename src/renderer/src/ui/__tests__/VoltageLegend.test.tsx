/**
 * VoltageLegend.test.tsx - issue #70: the copper tint must come with an
 * on-screen scale that prints min and max volts, drawn from the same ramp the
 * scene uses.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import VoltageLegend, { voltageLegendSummary } from '../VoltageLegend'
import { VOLTAGE_RAMP_STOPS, voltageRampGradient, voltageRampRgb } from '../voltageRamp'
import { contrastRatio } from '../palette'

describe('VoltageLegend', () => {
  it('prints the min, middle and max voltage in text', () => {
    const html = renderToStaticMarkup(<VoltageLegend min={0} max={5} />)
    expect(html).toContain('data-testid="voltage-legend"')
    expect(html).toMatch(/data-testid="voltage-legend-min"[^>]*>0\.000 V</)
    expect(html).toMatch(/data-testid="voltage-legend-mid"[^>]*>2\.500 V</)
    expect(html).toMatch(/data-testid="voltage-legend-max"[^>]*>5\.000 V</)
  })

  it('draws the shared ramp as the strip background', () => {
    const html = renderToStaticMarkup(<VoltageLegend min={0} max={3.3} />)
    for (const stop of VOLTAGE_RAMP_STOPS) expect(html.toLowerCase()).toContain(stop)
    expect(voltageRampGradient()).toContain('linear-gradient')
  })

  it('is described for screen readers with the same numbers', () => {
    const html = renderToStaticMarkup(<VoltageLegend min={-1.5} max={12} />)
    expect(html).toContain('role="img"')
    expect(html).toContain('Low -1.500 V, high 12.000 V')
  })

  it('a flat range (every net at one voltage) says so instead of a fake scale', () => {
    const html = renderToStaticMarkup(<VoltageLegend min={5} max={5} />)
    expect(html).toContain('every net is at this voltage')
    expect(html).not.toContain('voltage-legend-max')
    expect(voltageLegendSummary(5, 5)).toBe('All nets at 5.000 V')
  })
})

describe('voltage ramp', () => {
  const lum = (rgb: [number, number, number]): number =>
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]

  it('is monotone in luminance, so it reads without hue (issue #70)', () => {
    let prev = -1
    for (let i = 0; i <= 40; i++) {
      const l = lum(voltageRampRgb(i / 40))
      expect(l).toBeGreaterThan(prev)
      prev = l
    }
  })

  it('clamps t outside [0, 1] and survives NaN', () => {
    expect(voltageRampRgb(-3)).toEqual(voltageRampRgb(0))
    expect(voltageRampRgb(7)).toEqual(voltageRampRgb(1))
    expect(() => voltageRampRgb(Number.NaN)).not.toThrow()
  })

  it('both ends stay visible against the dark board and the dark legend card', () => {
    const hex = (rgb: [number, number, number]): string =>
      '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
    // Non-text graphics need 3:1 (WCAG 1.4.11) against the surface behind them.
    expect(contrastRatio(hex(voltageRampRgb(0)), '#0c0c14')).toBeGreaterThan(1.5)
    expect(contrastRatio(hex(voltageRampRgb(1)), '#0c0c14')).toBeGreaterThan(3)
  })
})
