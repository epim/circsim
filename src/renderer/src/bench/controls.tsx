/**
 * bench/controls.tsx — shared DragKnob + NumericField controls.
 *
 * Moved verbatim from panels/InstrumentProps.tsx (Task 4 of the Bench Leads
 * feature) so the new front panels (bench/panels.tsx) and the still-live
 * InstrumentProps can share one implementation. Only changes from the
 * original: both components are exported, and DragKnob accepts an optional
 * `testId` rendered as `data-testid` on the slider div.
 */

import React, { useCallback, useRef, useState, useEffect } from 'react'

// ── DragKnob ─────────────────────────────────────────────────────────────────

interface DragKnobProps {
  value: number
  min: number
  max: number
  step: number
  label: string
  unit?: string
  onChange: (v: number) => void
  /** Logarithmic scale (useful for freq) */
  log?: boolean
  testId?: string
}

export function DragKnob({ value, min, max, step, label, unit, onChange, log, testId }: DragKnobProps): React.ReactElement {
  const startRef = useRef<{ y: number; v: number } | null>(null)

  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max])
  const round = useCallback((v: number) => Math.round(v / step) * step, [step])

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!startRef.current) return
      const dy = startRef.current.y - e.clientY // up = increase
      if (log) {
        const logRange = Math.log10(max) - Math.log10(min)
        const logStart = Math.log10(startRef.current.v)
        const logNext = logStart + (dy / 100) * logRange
        const next = clamp(round(Math.pow(10, logNext)))
        onChange(next)
      } else {
        const range = max - min
        const next = clamp(round(startRef.current.v + (dy / 100) * range))
        onChange(next)
      }
    },
    [clamp, round, onChange, log, max, min],
  )

  const handleMouseUp = useCallback(() => {
    startRef.current = null
    window.removeEventListener('mousemove', handleMouseMove)
    window.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseMove])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startRef.current = { y: e.clientY, v: value }
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [value, handleMouseMove, handleMouseUp],
  )

  const displayValue = value < 0.001 && value !== 0
    ? value.toExponential(2)
    : value >= 1000
    ? `${(value / 1000).toFixed(1)}k`
    : Number.isInteger(value)
    ? String(value)
    : value.toPrecision(3)

  return (
    <div style={knobContainerStyle}>
      <div
        style={knobStyle}
        onMouseDown={handleMouseDown}
        title={`Drag to adjust ${label}`}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        data-testid={testId}
      >
        <span style={knobTextStyle}>{displayValue}</span>
        {unit && <span style={knobUnitStyle}>{unit}</span>}
      </div>
      <div style={knobLabelStyle}>{label}</div>
    </div>
  )
}

// ── NumericField ──────────────────────────────────────────────────────────────

interface NumericFieldProps {
  label: string
  value: number
  unit?: string
  onChange: (v: number) => void
  min?: number
  max?: number
  testId?: string
}

export function NumericField({ label, value, unit, onChange, min, max, testId }: NumericFieldProps): React.ReactElement {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])

  const commit = useCallback(() => {
    const parsed = parseFloat(text)
    if (!isNaN(parsed)) {
      const clamped = min !== undefined ? Math.max(min, parsed) : parsed
      const final = max !== undefined ? Math.min(max, clamped) : clamped
      onChange(final)
    } else {
      setText(String(value)) // revert
    }
  }, [text, value, onChange, min, max])

  return (
    <div style={fieldRowStyle}>
      <label style={fieldLabelStyle}>{label}</label>
      <div style={fieldInputWrapStyle}>
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={e => e.key === 'Enter' && commit()}
          style={fieldInputStyle}
          data-testid={testId}
        />
        {unit && <span style={fieldUnitStyle}>{unit}</span>}
      </div>
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const knobContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
}

const knobStyle: React.CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: '50%',
  background: '#1e2640',
  border: '2px solid #4a6090',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'ns-resize',
  userSelect: 'none',
}

const knobTextStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'monospace',
  color: '#9cf',
  lineHeight: 1,
}

const knobUnitStyle: React.CSSProperties = {
  fontSize: 9,
  color: '#6a8',
  lineHeight: 1,
}

const knobLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#888',
}

const fieldRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 4,
}

const fieldLabelStyle: React.CSSProperties = {
  color: '#888',
  minWidth: 52,
  fontSize: 11,
}

const fieldInputWrapStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
}

const fieldInputStyle: React.CSSProperties = {
  background: '#0c0c14',
  border: '1px solid #3a3a5a',
  borderRadius: 3,
  color: '#ddd',
  fontFamily: 'monospace',
  fontSize: 12,
  padding: '2px 6px',
  width: 70,
}

const fieldUnitStyle: React.CSSProperties = {
  color: '#6a8',
  fontSize: 11,
}
