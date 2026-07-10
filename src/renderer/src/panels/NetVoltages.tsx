/**
 * renderer/panels/NetVoltages.tsx — M7 (F8)
 *
 * Compact per-net voltage readout for the latest operating point: one row per
 * net with an op result (net name + formatVolts — the SAME formatter as the 3D
 * board labels, so -0.000 V never appears), natural-sorted by net name, with a
 * text filter. Clicking a row selects/highlights that net (store.selectNet —
 * the existing selection-sync action), so "what is PACK+ at?" is a glance +
 * a click instead of zoom/hover archaeology on 88 tiny 3D labels.
 *
 * Lives as the "Net voltages" tab next to the Sim log in the bottom dock
 * (App.tsx). The pure row model (buildNetVoltageRows) is exported for tests.
 */

import React, { useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { opCaveatMessage } from '../store/appStore'
import { formatVolts } from '../viewport/markers'
import type { CircuitNet } from '../../../core/netlist/extract'

export interface NetVoltageRow {
  netId: number
  name: string
  volts: number
}

/**
 * Build the readout rows: every NAMED net with an op-result voltage, filtered
 * by a case-insensitive substring of the net name, natural-sorted by name
 * (NET2 before NET10). Pure; exported for unit tests.
 */
export function buildNetVoltageRows(
  nets: CircuitNet[],
  opVoltages: Map<number, number> | null,
  filter: string,
): NetVoltageRow[] {
  if (!opVoltages) return []
  const needle = filter.trim().toLowerCase()
  const rows: NetVoltageRow[] = []
  for (const net of nets) {
    if (net.kicadName === '') continue
    const volts = opVoltages.get(net.id)
    if (volts === undefined) continue
    if (needle && !net.kicadName.toLowerCase().includes(needle)) continue
    rows.push({ netId: net.id, name: net.kicadName, volts })
  }
  rows.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  )
  return rows
}

export default function NetVoltages(): React.ReactElement {
  const store = useAppStoreApi()
  const circuit = useApp(s => s.circuit)
  const opVoltages = useApp(s => s.opVoltages)
  // Honesty surfaces (M7 review): fallback-solve caveat + staleness while a
  // re-solve is in flight — this table must never present suspect numbers as
  // truth just because the big WarningsBar is out of view.
  const opCaveat = useApp(s => s.opCaveat)
  const stale = useApp(s => s.opVoltagesStale)
  const selectedNetId = useApp(s => s.selectedNetId)
  const [filter, setFilter] = useState('')

  const rows = buildNetVoltageRows(circuit?.nets ?? [], opVoltages, filter)
  // An op RAN if opVoltages is non-null — even a degenerate one that mapped
  // zero nets (that case gets its own message, not "no operating point yet").
  const hasOp = opVoltages !== null

  return (
    <div style={containerStyle} data-testid="net-voltages">
      <div style={toolbarStyle}>
        <span style={titleStyle}>Net Voltages</span>
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter nets…"
          style={filterStyle}
          data-testid="net-voltages-filter"
        />
        {hasOp && <span style={countStyle}>{rows.length}</span>}
      </div>
      {opCaveat && (
        <div style={caveatLineStyle} data-testid="net-voltages-caveat">
          {opCaveatMessage(opCaveat.method)}
        </div>
      )}
      {stale && hasOp && (
        <div style={staleLineStyle} data-testid="net-voltages-stale">
          From a previous run — a new solve is in progress.
        </div>
      )}
      <div style={listStyle}>
        {!hasOp ? (
          <div style={emptyStyle}>
            No operating point yet — press Power On to read the net voltages.
          </div>
        ) : opVoltages.size === 0 ? (
          <div style={emptyStyle}>Operating point returned no net voltages.</div>
        ) : rows.length === 0 ? (
          <div style={emptyStyle}>No nets match the filter.</div>
        ) : (
          rows.map(r => {
            const isSelected = r.netId === selectedNetId
            return (
              <div
                key={r.netId}
                role="button"
                tabIndex={0}
                data-testid="net-voltage-row"
                data-net-id={r.netId}
                data-net-name={r.name}
                style={{
                  ...(isSelected ? { ...rowStyle, ...rowSelectedStyle } : rowStyle),
                  // Dim outdated values while the new solve runs.
                  ...(stale ? { opacity: 0.55 } : {}),
                }}
                onClick={() => store.getState().selectNet(r.netId)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') store.getState().selectNet(r.netId)
                }}
                title={`Select ${r.name} on the board`}
              >
                <span style={nameStyle}>{r.name}</span>
                <span style={voltsStyle}>{formatVolts(r.volts)}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  background: '#0d1117',
  color: '#c9d1d9',
  fontSize: 11,
}
const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  borderBottom: '1px solid #21262d',
}
const titleStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#888',
  flexShrink: 0,
}
const filterStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: '#1e1e2c',
  border: '1px solid #33334a',
  borderRadius: 3,
  color: '#dde',
  fontSize: 11,
  padding: '2px 6px',
}
const countStyle: React.CSSProperties = {
  color: '#556',
  fontSize: 10,
  flexShrink: 0,
}
// Compact amber caveat line for fallback-solve results (mirrors the
// WarningsBar op-caveat tone — M7 review).
const caveatLineStyle: React.CSSProperties = {
  padding: '3px 8px',
  background: '#3a2a10',
  color: '#ffd9a0',
  borderBottom: '1px solid #5a4418',
  fontSize: 10.5,
}
// Staleness note while a re-solve is in flight (M7 review).
const staleLineStyle: React.CSSProperties = {
  padding: '3px 8px',
  color: '#889',
  fontStyle: 'italic',
  borderBottom: '1px solid #161b22',
  fontSize: 10.5,
}
const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  minHeight: 0,
}
const emptyStyle: React.CSSProperties = {
  padding: '8px',
  color: '#555',
  fontStyle: 'italic',
}
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  padding: '2px 8px',
  borderBottom: '1px solid #161b22',
  cursor: 'pointer',
}
const rowSelectedStyle: React.CSSProperties = {
  background: '#1e2a4a',
}
const nameStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: 'monospace',
  color: '#9ab',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const voltsStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  color: '#e8c07d',
  flexShrink: 0,
}
