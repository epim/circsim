/**
 * renderer/panels/CriticPanel.tsx — Board Critic (C4)
 *
 * Lists the read-only critic findings grouped by severity (error → warn → info)
 * with a count badge per group. Each row shows the finding's title + detail +
 * assumption + suggestion and is clickable → selectFinding(id), which flies the
 * camera to the finding and highlights the involved net/part in the viewport.
 *
 * Skipped checks (e.g. ampacity/thermal before a simulation) are shown subtly so
 * the user knows what an op-solve would add — preserving circsim's honesty: the
 * critic never claims a check ran that didn't.
 *
 * Presentational only — the report comes from the store (runCriticAudit, which
 * reuses the pure, tested core/critic). data-testid hooks:
 *   critic-panel · critic-finding · critic-summary-{error,warn,info}
 */

import React from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
// useApp/useAppStoreApi power the connected wrapper; CriticPanelView is store-free.
import type { Finding, Severity, CriticReport } from '../../../core/critic/types'
import { severityCssColor } from '../viewport/criticOverlay'

const ORDER: Severity[] = ['error', 'warn', 'info']

const CHECK_LABEL: Record<string, string> = {
  floating: 'floating',
  clearance: 'clearance',
  decoupling: 'decoupling',
  ampacity: 'ampacity',
  thermal: 'thermal',
  'ir-drop': 'IR-drop',
  'loop-area': 'loop area',
}

/**
 * Store-connected wrapper: reads the report + selection and wires clicks to
 * selectFinding. Kept thin so the presentational view (CriticPanelView) is a pure
 * function of props and unit-testable without the store.
 */
export default function CriticPanel(): React.ReactElement | null {
  const store = useAppStoreApi()
  const report = useApp(s => s.criticReport)
  const selectedFindingId = useApp(s => s.selectedFindingId)
  return (
    <CriticPanelView
      report={report}
      selectedFindingId={selectedFindingId}
      onSelect={id => store.getState().selectFinding(id)}
    />
  )
}

/** Pure presentational panel — renders a (possibly null) report from props. */
export function CriticPanelView({
  report,
  selectedFindingId,
  onSelect,
}: {
  report: CriticReport | null
  selectedFindingId: string | null
  onSelect: (id: string) => void
}): React.ReactElement | null {
  const [copied, setCopied] = React.useState(false)

  // Nothing to show until the first audit (no board / not yet run).
  if (!report) return null

  const byseverity = groupBySeverity(report.findings)

  const handleCopy = (): void => {
    if (typeof navigator !== 'undefined') {
      navigator.clipboard?.writeText(formatCriticReport(report)).catch(() => {})
    }
    setCopied(true)
    if (typeof window !== 'undefined') window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div style={panelStyle} data-testid="critic-panel">
      <div style={headerStyle}>
        <span style={{ fontWeight: 600 }}>Board Critic</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {report.findings.length > 0 && (
            <button
              style={copyBtnStyle}
              data-testid="critic-copy-btn"
              onClick={handleCopy}
              title="Copy all findings to the clipboard (e.g. for a design review)"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          )}
          <span style={{ fontSize: 11, color: '#7a8499' }}>read-only audit</span>
        </span>
      </div>

      {/* Per-severity summary badges. */}
      <div style={summaryRowStyle}>
        {ORDER.map(sev => (
          <span
            key={sev}
            style={{ ...badgeStyle, borderColor: severityCssColor(sev), color: severityCssColor(sev) }}
            data-testid={`critic-summary-${sev}`}
          >
            {report.summary[sev]} {sev}
          </span>
        ))}
      </div>

      {report.findings.length === 0 && (
        <div style={emptyStyle}>No risks flagged. Findings are checks, not verdicts.</div>
      )}

      {/* Grouped findings: error → warn → info. */}
      {ORDER.map(sev => {
        const group = byseverity[sev]
        if (group.length === 0) return null
        return (
          <div key={sev} style={groupStyle}>
            <div style={{ ...groupHeaderStyle, color: severityCssColor(sev) }}>
              {sev} <span style={countBadgeStyle}>{group.length}</span>
            </div>
            {group.map(f => (
              <FindingRow
                key={f.id}
                finding={f}
                selected={f.id === selectedFindingId}
                onSelect={() => onSelect(f.id)}
              />
            ))}
          </div>
        )
      })}

      {/* Skipped / not-assessed checks (subtle): what a check couldn't cover. */}
      {report.skipped.length > 0 && (
        <div style={skippedWrapStyle} data-testid="critic-skipped">
          {report.skipped.map(s => (
            <div key={s.check} style={skippedItemStyle}>
              {(CHECK_LABEL[s.check] ?? s.check)}: {skippedText(s.reason)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Turn a skip reason into the short panel text. Op-informed checks (their
 * reason mentions the operating point) read "needs simulation"; anything else
 * — e.g. loop-area with no ground copper — shows its own not-assessed reason.
 */
function skippedText(reason: string): string {
  return reason.includes('operating-point') ? 'needs simulation' : reason
}

/**
 * Format a report as plain text for the clipboard — for pasting into a design
 * review or a note to a fab. Exported + unit-tested. Mirrors the panel: summary,
 * findings grouped error → warn → info, then any not-assessed checks.
 */
export function formatCriticReport(report: CriticReport): string {
  const { error, warn, info } = report.summary
  const lines: string[] = [`Board Critic — ${error} error, ${warn} warn, ${info} info`, '']
  const groups = groupBySeverity(report.findings)
  for (const sev of ORDER) {
    const group = groups[sev]
    if (group.length === 0) continue
    lines.push(sev.toUpperCase())
    for (const f of group) {
      lines.push(`- ${f.title}`)
      if (f.detail) lines.push(`  ${f.detail}`)
      if (f.assumption) lines.push(`  Assumes: ${f.assumption}`)
      if (f.suggestion) lines.push(`  → ${f.suggestion}`)
    }
    lines.push('')
  }
  if (report.skipped.length > 0) {
    lines.push('Not assessed:')
    for (const s of report.skipped) {
      lines.push(`- ${CHECK_LABEL[s.check] ?? s.check}: ${skippedText(s.reason)}`)
    }
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

function FindingRow({
  finding,
  selected,
  onSelect,
}: {
  finding: Finding
  selected: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <div
      style={{ ...rowStyle, ...(selected ? rowSelectedStyle : null) }}
      data-testid="critic-finding"
      data-finding-id={finding.id}
      data-check={finding.check}
      data-severity={finding.severity}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <div style={{ ...rowDot, background: severityCssColor(finding.severity) }} aria-hidden />
      <div style={{ minWidth: 0 }}>
        <div style={rowTitleStyle}>{finding.title}</div>
        <div style={rowDetailStyle}>{finding.detail}</div>
        {finding.assumption && (
          <div style={rowAssumptionStyle}>Assumes: {finding.assumption}</div>
        )}
        {finding.suggestion && (
          <div style={rowSuggestionStyle}>{finding.suggestion}</div>
        )}
      </div>
    </div>
  )
}

// ─── grouping ──────────────────────────────────────────────────────────────────

function groupBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  const out: Record<Severity, Finding[]> = { error: [], warn: [], info: [] }
  for (const f of findings) out[f.severity].push(f)
  return out
}

/** Exported for the presentational unit test (render from a fake report). */
export function _criticPanelGroups(report: CriticReport): Record<Severity, Finding[]> {
  return groupBySeverity(report.findings)
}

// ── styles ───────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 10,
  color: '#dbe2f0',
  fontSize: 12.5,
  borderTop: '1px solid #2a2a3a',
  overflowY: 'auto',
  maxHeight: '40vh',
}
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
}
const summaryRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
}
const badgeStyle: React.CSSProperties = {
  border: '1px solid',
  borderRadius: 10,
  padding: '1px 8px',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
}
const emptyStyle: React.CSSProperties = {
  color: '#7fae86',
  fontSize: 12,
}
const groupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}
const groupHeaderStyle: React.CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  fontSize: 10.5,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}
const countBadgeStyle: React.CSSProperties = {
  background: '#23293a',
  borderRadius: 8,
  padding: '0 6px',
  color: '#aeb6c8',
  fontWeight: 600,
}
const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '6px 8px',
  background: '#161c2b',
  border: '1px solid #232a3c',
  borderRadius: 5,
  cursor: 'pointer',
}
const rowSelectedStyle: React.CSSProperties = {
  borderColor: '#4a7bd6',
  background: '#1b2540',
}
const rowDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  marginTop: 4,
  flex: '0 0 auto',
}
const rowTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  color: '#eef2fb',
}
const rowDetailStyle: React.CSSProperties = {
  marginTop: 2,
  color: '#aab4c8',
  lineHeight: 1.35,
}
const rowAssumptionStyle: React.CSSProperties = {
  marginTop: 3,
  color: '#8590a6',
  fontStyle: 'italic',
  fontSize: 11.5,
}
const rowSuggestionStyle: React.CSSProperties = {
  marginTop: 3,
  color: '#9fd6a8',
  fontSize: 11.5,
}
const skippedWrapStyle: React.CSSProperties = {
  marginTop: 2,
  paddingTop: 6,
  borderTop: '1px dashed #2a3242',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}
const skippedItemStyle: React.CSSProperties = {
  color: '#6c7689',
  fontSize: 11,
}
const copyBtnStyle: React.CSSProperties = {
  background: '#23293a',
  color: '#aeb6c8',
  border: '1px solid #333c52',
  borderRadius: 4,
  padding: '1px 8px',
  fontSize: 11,
  cursor: 'pointer',
}
