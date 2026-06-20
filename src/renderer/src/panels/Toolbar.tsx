/**
 * renderer/panels/Toolbar.tsx — Task 24
 *
 * The simulation toolbar: Power On (op) · Run/Pause · pace selector · overlay
 * mode (Spec §11 toolbar row, §4 primary scenario).
 *
 * - "Power On" → store.powerOn() (DC operating point: annotates the board +
 *   tints copper by voltage).
 * - "Run"/"Pause" → store.run() / store.pause() (bounded live transient, §7.5).
 * - pace selector (0.1× / 1× / max) → store.setPace().
 * - overlay selector (realistic / voltage / highlight) → bubbled up via onOverlay
 *   so App.tsx can drive the imperative SceneManager.
 *
 * Buttons are guided-disabled (Spec §12): Power On / Run require a designated
 * ground AND at least one resolved source — never a silently-dead button; the
 * disabled tooltip explains what's missing.
 *
 * UI-only; validated by build + Phase 6 E2E. Orchestration logic is unit-tested
 * in the store (orchestration.test.ts).
 */

import React, { useCallback } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import type { OverlayMode } from '../viewport/overlay'

const PACE_OPTIONS: { label: string; value: number | 'max' }[] = [
  { label: '0.1×', value: 0.1 },
  { label: '1×', value: 1 },
  { label: 'max', value: 'max' },
]

const OVERLAY_OPTIONS: { label: string; value: OverlayMode }[] = [
  { label: 'Realistic', value: 'realistic' },
  { label: 'Voltage', value: 'voltage' },
  { label: 'Highlight', value: 'highlight' },
]

export interface ToolbarProps {
  /** Current overlay mode (App.tsx owns it; the scene is imperative). */
  overlay: OverlayMode
  /** Change the overlay mode. */
  onOverlay: (mode: OverlayMode) => void
}

export default function Toolbar({ overlay, onOverlay }: ToolbarProps): React.ReactElement | null {
  const store = useAppStoreApi()
  const circuit = useApp(s => s.circuit)
  const groundNetId = useApp(s => s.groundNetId)
  const instruments = useApp(s => s.instruments)
  const simState = useApp(s => s.simState)
  const paceFactor = useApp(s => s.paceFactor)
  const achievedFactor = useApp(s => s.achievedRealtimeFactor)

  // A "source" is any supply / function-gen / logic-input (something that drives a net).
  const hasSource = instruments.some(
    i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
  )
  const hasGround = groundNetId !== null

  const canPowerOn = !!circuit && hasGround && hasSource
  const disabledReason = !circuit
    ? 'Open a board first'
    : !hasGround
      ? 'Designate a ground net first'
      : !hasSource
        ? 'Attach a power supply or signal source first'
        : ''

  const handlePowerOn = useCallback(() => {
    void store.getState().powerOn()
  }, [store])

  // First Light (L3): the one inviting verb. energize() auto-attaches a ground +
  // supply when missing, then runs the op solve so the LEDs glow — so it's live
  // as soon as a board is open (it does its own rigging), unlike Power On.
  const handleEnergize = useCallback(() => {
    void store.getState().energize()
  }, [store])

  const handleRunPause = useCallback(() => {
    const st = store.getState()
    if (st.simState === 'running') st.pause()
    else st.run()
  }, [store])

  const handlePace = useCallback(
    (value: number | 'max') => {
      store.getState().setPace(value)
    },
    [store],
  )

  if (!circuit) return null

  const running = simState === 'running'

  return (
    <div style={barStyle}>
      <button
        style={energizeBtn}
        onClick={handleEnergize}
        title="Attach power & ground if needed, then light it up"
        data-testid="energize-btn"
      >
        ⚡ Energize
      </button>

      <button
        style={canPowerOn ? primaryBtn : disabledBtn}
        disabled={!canPowerOn}
        onClick={handlePowerOn}
        title={canPowerOn ? 'Run a DC operating-point check' : disabledReason}
        data-testid="power-on-btn"
      >
        Power On
      </button>

      <button
        style={canPowerOn ? (running ? pauseBtn : runBtn) : disabledBtn}
        disabled={!canPowerOn}
        onClick={handleRunPause}
        title={canPowerOn ? (running ? 'Pause the simulation' : 'Run the live simulation') : disabledReason}
        data-testid="run-btn"
      >
        {running ? 'Pause' : simState === 'paused' ? 'Resume' : 'Run'}
      </button>

      {/* Pace selector */}
      <div style={groupStyle} title="Real-time pacing">
        <span style={groupLabel}>Pace</span>
        {PACE_OPTIONS.map(opt => (
          <button
            key={String(opt.value)}
            style={paceFactor === opt.value ? segActive : segBtn}
            onClick={() => handlePace(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Overlay selector */}
      <div style={groupStyle} title="Board overlay mode">
        <span style={groupLabel}>Overlay</span>
        {OVERLAY_OPTIONS.map(opt => (
          <button
            key={opt.value}
            style={overlay === opt.value ? segActive : segBtn}
            onClick={() => onOverlay(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Status readout */}
      <span style={statusStyle}>
        {simState === 'idle' && 'idle'}
        {simState === 'op' && 'operating point…'}
        {(running || simState === 'paused') && (
          <>
            {running ? 'running' : 'paused'}
            {achievedFactor !== null && ` · ${achievedFactor.toFixed(2)}× realtime`}
          </>
        )}
      </span>
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const barStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 14px',
  background: '#15151f',
  borderBottom: '1px solid #2a2a3a',
}
const baseBtn: React.CSSProperties = {
  border: '1px solid #3a3a55',
  borderRadius: 4,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 13,
  color: '#eee',
}
const energizeBtn: React.CSSProperties = {
  ...baseBtn,
  background: '#7a5a12',
  borderColor: '#caa11a',
  fontWeight: 600,
}
const primaryBtn: React.CSSProperties = { ...baseBtn, background: '#2a4a6a', borderColor: '#3a6a9a' }
const runBtn: React.CSSProperties = { ...baseBtn, background: '#1a5a2a', borderColor: '#2a7a3a' }
const pauseBtn: React.CSSProperties = { ...baseBtn, background: '#6a5a1a', borderColor: '#9a8a2a' }
const disabledBtn: React.CSSProperties = {
  ...baseBtn,
  background: '#1a1a24',
  borderColor: '#2a2a34',
  color: '#555',
  cursor: 'not-allowed',
}
const groupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  marginLeft: 4,
}
const groupLabel: React.CSSProperties = {
  fontSize: 10,
  color: '#777',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginRight: 4,
}
const segBtn: React.CSSProperties = {
  background: '#1e1e2c',
  border: '1px solid #33334a',
  color: '#99a',
  fontSize: 11,
  padding: '3px 8px',
  cursor: 'pointer',
}
const segActive: React.CSSProperties = {
  ...segBtn,
  background: '#34406a',
  borderColor: '#4a5a8a',
  color: '#dde',
}
const statusStyle: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: 11,
  color: '#8aa',
  fontFamily: 'monospace',
}
