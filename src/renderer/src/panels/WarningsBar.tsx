/**
 * renderer/panels/WarningsBar.tsx — Task 24
 *
 * The honesty surfaces (Spec §8.6, §12, §7.5):
 *   - Fidelity banner: persistent + non-dismissable whenever any Resolution
 *     status !== 'ok'. Lists every stubbed/unresolved ref + its mode. Links to
 *     the "what circsim can tell you" fidelity doc.
 *   - Convergence-failure card: plain-language explanation + the culprit
 *     part/net (when ngspice's abort text names one) + the retry-ladder note +
 *     an expandable raw ngspice log section. Dismissable.
 *   - Op fallback caveat: persistent + non-dismissable while the latest
 *     operating point came from a fallback rung (gmin/source/transient-op) —
 *     its voltages, especially 0.000 V readings, may be unreliable (F1).
 *   - Bench-restart toast: brief "bench restarted" notice (window/memory), with
 *     the sequential-logic caveat when digital parts are present. Dismissable.
 *   - Crash toast: SimHost crashed — auto-recovering. Dismissable.
 *
 * UI-only; the derived banner list + toast/card STATE are unit-tested in the
 * store (fidelityBannerItems, ingestEvent → benchRestartToast/convergenceCard).
 */

import React, { useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { fidelityBannerItems, collapsedFidelitySummary, opCaveatMessage } from '../store/appStore'

export default function WarningsBar(): React.ReactElement | null {
  const store = useAppStoreApi()
  const resolutions = useApp(s => s.resolutions)
  const convergenceCard = useApp(s => s.convergenceCard)
  const benchToast = useApp(s => s.benchRestartToast)
  const crashNotice = useApp(s => s.crashNotice)
  const opCaveat = useApp(s => s.opCaveat)

  const fidelity = fidelityBannerItems(resolutions)
  // M7 F9: >3 problem parts → one-line count instead of a wall of refs.
  const fidelityCollapsed = collapsedFidelitySummary(fidelity)
  const [rawOpen, setRawOpen] = useState(false)

  // "open Model Doctor": the Doctor drawer (left dock) is already visible
  // whenever problems exist; revealInDoctor selects the first problem part and
  // scrolls its card into view — nonce-based, so it works even when that part
  // is already selected, twice in a row (M7 review fix).
  const openModelDoctor = (): void => {
    if (fidelity.length > 0) store.getState().revealInDoctor(fidelity[0].ref)
  }

  const anything =
    fidelity.length > 0 || convergenceCard || benchToast || crashNotice || opCaveat
  if (!anything) return null

  return (
    <div style={wrapStyle}>
      {/* ── Crash toast ───────────────────────────────────────────────────── */}
      {crashNotice && (
        <div style={crashStyle}>
          <strong>Simulator restarted.</strong>{' '}
          {crashNotice.willRespawn
            ? 'The simulation engine crashed and is recovering automatically.'
            : 'The simulation engine crashed and could not be restarted.'}
          <button style={dismissBtn} onClick={() => store.setState({ crashNotice: null })}>
            ×
          </button>
        </div>
      )}

      {/* ── Bench-restart toast ───────────────────────────────────────────── */}
      {benchToast && (
        <div style={toastStyle}>
          <strong>Bench restarted</strong>{' '}
          ({benchToast.reason === 'memory' ? 'memory limit' : 'window elapsed'}). Scope history is kept.
          {benchToast.sequentialLogicCaveat && (
            <span style={caveatStyle}>
              {' '}
              Note: sequential-logic state (flip-flops, counters) resets on a restart.
            </span>
          )}
          <button style={dismissBtn} onClick={() => store.getState().dismissBenchRestartToast()}>
            ×
          </button>
        </div>
      )}

      {/* ── Convergence-failure card ──────────────────────────────────────── */}
      {convergenceCard && (
        <div style={convergeStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline' }}>
            <strong>The simulator couldn&apos;t find a stable solution.</strong>
            <button
              style={dismissBtn}
              onClick={() => store.getState().dismissConvergenceCard()}
            >
              ×
            </button>
          </div>
          <div style={{ marginTop: 4 }}>{convergenceCard.plainLanguage}</div>
          {convergenceCard.culprit && (
            <div style={{ marginTop: 4 }} data-testid="convergence-culprit">
              The simulator reported trouble converging around{' '}
              <span style={refStyle}>
                {convergenceCard.culprit.kind === 'net'
                  ? `net "${convergenceCard.culprit.label}"`
                  : convergenceCard.culprit.label}
              </span>
              {convergenceCard.culprit.detail ? ` (${convergenceCard.culprit.detail})` : ''}.
            </div>
          )}
          <div style={{ marginTop: 4, color: '#caa', fontStyle: 'italic' }}>
            {convergenceCard.retryLadderNote}
          </div>
          <button style={rawToggleBtn} onClick={() => setRawOpen(o => !o)}>
            {rawOpen ? '▾ Hide raw log' : '▸ Show raw ngspice log'}
          </button>
          {rawOpen && <pre style={rawLogStyle}>{convergenceCard.rawDetail}</pre>}
        </div>
      )}

      {/* ── Op fallback caveat (persistent, non-dismissable — F1) ─────────── */}
      {opCaveat && (
        <div style={opCaveatStyle} data-testid="op-caveat">
          <strong>Check these voltages.</strong> {opCaveatMessage(opCaveat.method)}
        </div>
      )}

      {/* ── Fidelity banner (persistent, non-dismissable) ─────────────────── */}
      {fidelity.length > 0 && (
        <div style={fidelityStyle}>
          <strong>Results approximate:</strong>{' '}
          {fidelityCollapsed ??
            fidelity.map((it, i) => (
              <span key={it.ref}>
                {i > 0 && ', '}
                <span style={refStyle}>{it.ref}</span> {it.mode}
              </span>
            ))}
          {' — '}
          <span
            style={linkStyle}
            title="Fix or stub these parts in the Model Doctor"
            role="button"
            tabIndex={0}
            data-testid="open-model-doctor"
            onClick={openModelDoctor}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') openModelDoctor()
            }}
          >
            open Model Doctor
          </span>
          .{' '}
          {/* Task 28: wire the docs link via window.circsim.openDocs. */}
          <span
            style={linkStyle}
            title="What this simulation can and can't tell you (docs)"
            role="button"
            tabIndex={0}
            onClick={() => {
              if (typeof window !== 'undefined' && window.circsim?.openDocs) {
                void window.circsim.openDocs()
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                if (typeof window !== 'undefined' && window.circsim?.openDocs) {
                  void window.circsim.openDocs()
                }
              }
            }}
          >
            What can circsim tell you?
          </span>
        </div>
      )}
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const wrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
}
const baseRow: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 12.5,
  position: 'relative',
}
const fidelityStyle: React.CSSProperties = {
  ...baseRow,
  background: '#3a2e12',
  color: '#fde9b0',
  borderTop: '1px solid #5a4a22',
}
const opCaveatStyle: React.CSSProperties = {
  ...baseRow,
  background: '#3a2a10',
  color: '#ffd9a0',
  borderTop: '1px solid #5a4418',
}
const convergeStyle: React.CSSProperties = {
  ...baseRow,
  background: '#3a1a1a',
  color: '#fdd',
  borderTop: '1px solid #5a2a2a',
}
const toastStyle: React.CSSProperties = {
  ...baseRow,
  background: '#1a2a3a',
  color: '#bde',
  borderTop: '1px solid #2a4a5a',
}
const crashStyle: React.CSSProperties = {
  ...baseRow,
  background: '#3a2030',
  color: '#fcd',
  borderTop: '1px solid #5a3050',
}
const caveatStyle: React.CSSProperties = {
  color: '#9bd',
  fontStyle: 'italic',
}
const refStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontWeight: 600,
}
const linkStyle: React.CSSProperties = {
  color: '#ffd27a',
  textDecoration: 'underline',
}
const dismissBtn: React.CSSProperties = {
  marginLeft: 'auto',
  position: 'absolute',
  top: 4,
  right: 8,
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  opacity: 0.6,
}
const rawToggleBtn: React.CSSProperties = {
  marginTop: 6,
  background: 'transparent',
  border: '1px solid #5a2a2a',
  borderRadius: 3,
  color: '#fbb',
  fontSize: 11,
  padding: '2px 8px',
  cursor: 'pointer',
}
const rawLogStyle: React.CSSProperties = {
  marginTop: 6,
  background: '#1a0e0e',
  color: '#e9b0b0',
  padding: '8px',
  borderRadius: 3,
  fontSize: 11,
  fontFamily: 'monospace',
  whiteSpace: 'pre-wrap',
  maxHeight: 160,
  overflowY: 'auto',
}
