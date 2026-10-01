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

export interface VoltageLegendProps {
  /** Lowest and highest net voltage the tint is scaled to. */
  min: number
  max: number
}

/** The text a screen reader (and the unit tests) get for the scale. */
export function voltageLegendSummary(min: number, max: number): string {
  if (min === max) return `All nets at ${formatVolts(min)}`
  return `Low ${formatVolts(min)}, high ${formatVolts(max)}`
}

export default function VoltageLegend({ min, max }: VoltageLegendProps): React.ReactElement {
  const flat = min === max
  return (
    <div
      style={wrapStyle}
      data-testid="voltage-legend"
      role="img"
      aria-label={`Copper voltage scale. ${voltageLegendSummary(min, max)}`}
    >
      <div style={titleStyle}>Copper voltage</div>
      <div
        style={{ ...stripStyle, background: voltageRampGradient() }}
        data-testid="voltage-legend-strip"
      />
      {flat ? (
        <div style={labelRowStyle}>
          <span data-testid="voltage-legend-min">{formatVolts(min)}</span>
        </div>
      ) : (
        <div style={labelRowStyle}>
          <span data-testid="voltage-legend-min">{formatVolts(min)}</span>
          <span data-testid="voltage-legend-mid">{formatVolts((min + max) / 2)}</span>
          <span data-testid="voltage-legend-max">{formatVolts(max)}</span>
        </div>
      )}
      <div style={captionStyle}>{flat ? 'every net is at this voltage' : 'low on the left, high on the right'}</div>
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
