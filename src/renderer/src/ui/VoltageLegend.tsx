/**
 * ui/VoltageLegend.tsx - on-screen scale for the copper voltage tint (issue #70).
 *
 * Shown whenever the Voltage overlay is active and an operating point exists.
 * Draws the same ramp the scene uses (ui/voltageRamp) with the min, middle and
 * max voltages printed under it, so the colors are never the only carrier of
 * information. Pure presentational; App feeds it the store's `voltageRange`.
 */

import React from 'react'
import { formatVolts } from '../viewport/markers'
import { voltageRampGradient } from './voltageRamp'
import { TEXT_MUTED } from './palette'
import type { PadVoltages } from '../viewport/padVoltage'
import type { CopperPadConnection, CopperOp } from '../../../core/copper'

export interface VoltageLegendProps {
  /** Lowest and highest net voltage the tint is scaled to. */
  min: number
  max: number
  padVoltages?: PadVoltages
  unreachedPads?: CopperPadConnection[]
  method?: CopperOp['method']
}

/** The text a screen reader (and the unit tests) get for the scale. */
export function voltageLegendSummary(min: number, max: number): string {
  if (min === max) return `All nets at ${formatVolts(min)}`
  return `Low ${formatVolts(min)}, high ${formatVolts(max)}`
}

export default function VoltageLegend({ min, max, padVoltages, unreachedPads, method }: VoltageLegendProps): React.ReactElement {
  const flat = min === max
  const hasReadings = padVoltages === undefined || Object.values(padVoltages).some(pads => Object.values(pads).some(Number.isFinite))
  return (
    <div
      style={wrapStyle}
      data-testid="voltage-legend"
      aria-label={hasReadings ? `Copper voltage scale. ${voltageLegendSummary(min, max).replace('nets', padVoltages ? 'pads' : 'nets')}` : 'Physical solve: no pad voltage readings'}
    >
      <div style={titleStyle}>Copper voltage{padVoltages ? ' at pads' : ''}</div>
      {hasReadings && <div role="img"
        style={{ ...stripStyle, background: voltageRampGradient() }}
        aria-label={`Voltage ramp. ${voltageLegendSummary(min, max).replace('nets', padVoltages ? 'pads' : 'nets')}`}
        data-testid="voltage-legend-strip"
      />}
      {hasReadings && (flat ? (
        <div style={labelRowStyle}>
          <span data-testid="voltage-legend-min">{formatVolts(min)}</span>
        </div>
      ) : (
        <div style={labelRowStyle}>
          <span data-testid="voltage-legend-min">{formatVolts(min)}</span>
          <span data-testid="voltage-legend-mid">{formatVolts((min + max) / 2)}</span>
          <span data-testid="voltage-legend-max">{formatVolts(max)}</span>
        </div>
      ))}
      <div style={captionStyle}>{!hasReadings ? 'No physical pad readings available' : flat ? `every ${padVoltages ? 'pad' : 'net'} is at this voltage` : 'low on the left, high on the right'}</div>
      {padVoltages && (
        <details data-testid="pad-voltage-values" style={{ pointerEvents: 'auto' }}>
          <summary>Operating point pad values{method === 'failed' ? ': solve failed' : ''}</summary>
          <div>Gray pads have no reading</div>
          {method === 'tran-fallback' && <div>Settled transient snapshot</div>}
          <div style={{ maxHeight: 140, overflowY: 'auto', fontFamily: 'monospace' }}>
            {Object.entries(padVoltages).flatMap(([ref, pads]) => Object.entries(pads)
              .filter(([, volts]) => Number.isFinite(volts))
              .map(([pad, volts]) => <div key={`${ref}.${pad}`}>{ref}.{pad}: {formatVolts(volts)}</div>))}
          </div>
        </details>
      )}
      {!!unreachedPads?.length && <div data-testid="pad-routing-gaps">{unreachedPads.length} pads have routing gaps. See Critic findings.</div>}
    </div>
  )
}

const wrapStyle: React.CSSProperties = {
  position: 'absolute',
  right: 8,
  bottom: 8,
  width: 190,
  background: 'rgba(12, 12, 20, 0.88)',
  border: '1px solid #2a2a3a',
  borderRadius: 4,
  padding: '6px 8px',
  color: '#dde',
  fontSize: 11,
  pointerEvents: 'none',
}
const titleStyle: React.CSSProperties = { fontWeight: 600, marginBottom: 4 }
const stripStyle: React.CSSProperties = {
  height: 10,
  borderRadius: 2,
  border: '1px solid #3a3a4a',
}
const labelRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  marginTop: 3,
  fontFamily: 'monospace',
}
const captionStyle: React.CSSProperties = { marginTop: 3, color: TEXT_MUTED, fontSize: 10 }
