/**
 * renderer/panels/EmptyStates.tsx — Task 28
 *
 * Guided empty-state cards for every Spec §12 scenario:
 *
 *   ParseErrorCard       — parse error with line/col + viewer-only mode affordance
 *   NoGroundState        — no ground designated: tells the user exactly what to do
 *   NoSourceState        — no source attached: tells the user exactly what to do
 *
 * These are pure display components driven entirely by props (no store reads
 * inside). The parent (App.tsx) decides which to show and passes the minimal
 * data needed. This keeps them testable without a store context.
 *
 * The fidelity banner and convergence card / crash toast are in WarningsBar.tsx
 * (already implemented in Task 24) and are NOT duplicated here.
 *
 * Spec §12, §16 risk 7.
 */

import React from 'react'
import { btnPrimary, btnSecondary } from '../ui/buttonStyles'

// ─── Parse-error card ─────────────────────────────────────────────────────────

export interface ParseErrorCardProps {
  /** Human-readable error message from the parser. */
  message: string
  /** 1-based line number where the error occurred (if known). */
  line?: number
  /** 1-based column number where the error occurred (if known). */
  col?: number
  /** File name displayed in the heading (e.g. "myboard.kicad_pcb"). */
  fileName?: string
  /**
   * When true, the board was partially loaded in viewer-only mode:
   * the 3D view renders but simulation can't proceed (Spec §12).
   */
  viewerOnly?: boolean
  /** Called when the user dismisses the card (or clicks "continue in viewer"). */
  onDismiss?: () => void
}

/**
 * Shown when `parseBoard` or `parseSchematicSimData` throws.
 * Includes the line/col so the user can find the problem in their file.
 * Spec §12 — "structured, with line/column and 'open anyway (viewer-only mode)'".
 */
export function ParseErrorCard({
  message,
  line,
  col,
  fileName,
  viewerOnly,
  onDismiss,
}: ParseErrorCardProps): React.ReactElement {
  const locationText =
    line !== undefined
      ? ` at line ${line}${col !== undefined ? `, col ${col}` : ''}`
      : ''

  return (
    <div style={parseErrStyle} role="alert" data-testid="parse-error-card">
      <div style={parseErrHeader}>
        <strong>Could not parse {fileName ?? 'board'}</strong>
        {locationText && <span style={parseErrLoc}>{locationText}</span>}
      </div>
      <div style={parseErrMessage}>{message}</div>
      {viewerOnly && (
        <div style={viewerOnlyBadge}>
          The board is shown in viewer-only mode — simulation can&apos;t proceed
          until the error is fixed.
        </div>
      )}
      {onDismiss && (
        <button style={parseErrBtn} onClick={onDismiss}>
          {viewerOnly ? 'Continue in viewer-only mode' : 'Dismiss'}
        </button>
      )}
    </div>
  )
}

// ─── No-ground guided state ───────────────────────────────────────────────────

export interface NoGroundStateProps {
  /**
   * Name of the auto-suggested ground net (if any), e.g. "GND".
   * When present the card names it so the user knows what to confirm.
   */
  suggestedGroundName?: string
}

/**
 * Shown when Power On / Run is attempted without a ground net designated.
 * Spec §12 — "Simulation without ground designated … → guided empty-state".
 */
export function NoGroundState({ suggestedGroundName }: NoGroundStateProps): React.ReactElement {
  return (
    <div style={guidedStyle} role="status" data-testid="no-ground-state">
      <div style={guidedIcon}>⚡</div>
      <div style={guidedTitle}>Designate a ground net first</div>
      <div style={guidedBody}>
        circsim needs to know which net is ground (0 V reference) before it can
        run a simulation.
        {suggestedGroundName ? (
          <>
            {' '}
            The{' '}
            <strong style={netName}>{suggestedGroundName}</strong> net looks like
            a good candidate — click it in the Ground panel on the right, or click
            it on the board.
          </>
        ) : (
          ' Click the net you want to use as ground in the Ground panel on the right, or click a net directly on the 3D board.'
        )}
      </div>
    </div>
  )
}

// ─── No-source guided state ───────────────────────────────────────────────────

/**
 * Shown when Power On / Run is attempted but no source instrument is attached
 * (dc-supply, function-gen, or logic-input).
 * Spec §12 — "zero resolved sources → guided empty-state, not a dead Run button".
 */
export function NoSourceState(): React.ReactElement {
  return (
    <div style={guidedStyle} role="status" data-testid="no-source-state">
      <div style={guidedIcon}>🔌</div>
      <div style={guidedTitle}>Attach a power supply or signal source</div>
      <div style={guidedBody}>
        The circuit has no voltage source to simulate. Add a{' '}
        <strong>DC Supply</strong> from the bench and draw its lead to a power rail
        (like VCC or +5V), or add a <strong>Function Generator</strong> onto an input
        net. Then press <strong>Power On</strong> or <strong>Run</strong>.
      </div>
    </div>
  )
}

// ─── No-board first-run state ─────────────────────────────────────────────────

export interface NoBoardStateProps {
  /** Open the file picker. */
  onOpen: () => void
  /** Open the bundled 555-blinker sample project (primary CTA). */
  onOpenSample: () => void
  /** Open the one-LED First Light demo. */
  onOpenFirstLight: () => void
}

/**
 * First-run card (moved here from App.tsx — this file is the home for guided
 * empty states). One solid primary CTA (sample project) + two quiet outline
 * buttons (Gemini UX finding 2: three equally-heavy custom-colored buttons
 * failed to guide the first click).
 */
export function NoBoardState({
  onOpen,
  onOpenSample,
  onOpenFirstLight,
}: NoBoardStateProps): React.ReactElement {
  return (
    <div style={noBoardStyle}>
      <div style={{ fontSize: 18, marginBottom: 8 }}>No board loaded</div>
      <div style={{ color: '#888', marginBottom: 16 }}>
        Open a <code>.kicad_pcb</code> file, or drag one onto the window.
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button style={btnPrimary} onClick={onOpenSample} data-testid="open-sample-btn">
          Open sample project
        </button>
        <button style={btnSecondary} onClick={onOpenFirstLight} data-testid="open-first-light-btn">
          Open First Light demo
        </button>
        <button style={btnSecondary} onClick={onOpen} data-testid="open-board-btn">
          Open…
        </button>
      </div>
      <div style={{ color: '#555', marginTop: 10, fontSize: 12 }}>
        The sample project is a 555 blinker — the full simulation flow in one
        click. First Light is a one-LED dimmer if you want the smallest possible
        start.
      </div>
    </div>
  )
}

// ─── styles ───────────────────────────────────────────────────────────────────

const parseErrStyle: React.CSSProperties = {
  background: '#2a1010',
  border: '1px solid #6a2020',
  borderRadius: 6,
  padding: '12px 16px',
  color: '#fdd',
  fontSize: 13,
  maxWidth: 540,
}
const parseErrHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  marginBottom: 6,
}
const parseErrLoc: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 11,
  color: '#f9a',
  opacity: 0.85,
}
const parseErrMessage: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 11.5,
  color: '#faa',
  background: '#1a0808',
  padding: '6px 10px',
  borderRadius: 3,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  marginBottom: 8,
}
const viewerOnlyBadge: React.CSSProperties = {
  background: '#3a2a10',
  border: '1px solid #6a4a20',
  borderRadius: 3,
  padding: '5px 10px',
  color: '#fde',
  fontSize: 11.5,
  marginBottom: 8,
}
const parseErrBtn: React.CSSProperties = {
  background: '#3a1a1a',
  border: '1px solid #6a3030',
  borderRadius: 4,
  color: '#fcc',
  fontSize: 12,
  padding: '4px 12px',
  cursor: 'pointer',
}

const guidedStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  padding: '24px 20px',
  color: '#bbc',
  gap: 8,
  maxWidth: 420,
}
const guidedIcon: React.CSSProperties = {
  fontSize: 32,
  lineHeight: 1,
  marginBottom: 4,
}
const guidedTitle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: '#ddd',
}
const guidedBody: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: '#99a',
}
const netName: React.CSSProperties = {
  fontFamily: 'monospace',
  color: '#6df',
}
const noBoardStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#ddd',
}
