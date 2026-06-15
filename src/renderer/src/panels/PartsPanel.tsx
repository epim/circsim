/**
 * renderer/panels/PartsPanel.tsx — Task 21
 *
 * Left-dock Parts / BOM list (Spec §11). For every part in the circuit shows the
 * ref, value, and a status badge (ok = green, stubbed = amber, unresolved = red).
 * The list is searchable (ref or value substring) and selection is synced
 * bidirectionally with the viewport via the store's `selectedRef`:
 *   - clicking a row sets `selectedRef` (→ viewport highlights the component)
 *   - the viewport's clickComponent pick sets `selectedRef` (→ row highlights here)
 *
 * Pure React over the store; validated by build + Phase 6 E2E.
 */

import React, { useMemo, useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { statusBadge, type StatusBadge } from '../store/appStore'
import type { Resolution } from '../../../core/models/types'
import type { Part } from '../../../core/netlist/extract'

const BADGE_COLORS: Record<StatusBadge, string> = {
  ok: '#2ecc71',
  amber: '#f1c40f',
  red: '#e74c3c',
}

const BADGE_LABEL: Record<StatusBadge, string> = {
  ok: 'OK',
  amber: 'Stubbed',
  red: 'No model',
}

export default function PartsPanel(): React.ReactElement {
  const store = useAppStoreApi()
  const parts = useApp(s => s.circuit?.parts ?? EMPTY_PARTS)
  const resolutions = useApp(s => s.resolutions)
  const selectedRef = useApp(s => s.selectedRef)
  const [query, setQuery] = useState('')

  const resByRef = useMemo(() => {
    const m = new Map<string, Resolution>()
    for (const r of resolutions) m.set(r.ref, r)
    return m
  }, [resolutions])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return parts
    return parts.filter(
      p => p.ref.toLowerCase().includes(q) || p.value.toLowerCase().includes(q),
    )
  }, [parts, query])

  return (
    <div style={panelStyle} data-testid="parts-panel">
      <div style={headerStyle}>Parts</div>
      <input
        type="text"
        placeholder="Search ref or value…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={searchStyle}
        aria-label="Search parts"
      />
      <div style={listStyle}>
        {filtered.length === 0 && (
          <div style={{ padding: 8, color: '#888', fontSize: 12 }}>
            {parts.length === 0 ? 'No board loaded.' : 'No matching parts.'}
          </div>
        )}
        {filtered.map(part => {
          const res = resByRef.get(part.ref)
          const badge: StatusBadge = res ? statusBadge(res) : 'red'
          const isSelected = part.ref === selectedRef
          return (
            <div
              key={part.ref}
              role="button"
              tabIndex={0}
              onClick={() => store.getState().selectComponent(isSelected ? null : part.ref)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  store.getState().selectComponent(isSelected ? null : part.ref)
                }
              }}
              style={{
                ...rowStyle,
                background: isSelected ? '#2a3a5a' : 'transparent',
              }}
              data-ref={part.ref}
              data-testid="part-row"
            >
              <span
                style={{ ...badgeStyle, background: BADGE_COLORS[badge] }}
                title={BADGE_LABEL[badge]}
                data-testid={badge === 'red' ? 'status-badge-red' : badge === 'amber' ? 'status-badge-amber' : 'status-badge-ok'}
              />
              <span style={refStyle}>{part.ref}</span>
              <span style={valueStyle}>{part.value || '—'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const EMPTY_PARTS: Part[] = []

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  background: '#15151f',
  color: '#ddd',
  fontSize: 13,
}
const headerStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontWeight: 600,
  borderBottom: '1px solid #2a2a3a',
}
const searchStyle: React.CSSProperties = {
  margin: 8,
  padding: '6px 8px',
  background: '#0c0c14',
  border: '1px solid #2a2a3a',
  borderRadius: 4,
  color: '#ddd',
  fontSize: 13,
}
const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
}
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  cursor: 'pointer',
  borderBottom: '1px solid #1d1d2a',
}
const badgeStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
}
const refStyle: React.CSSProperties = {
  fontWeight: 600,
  minWidth: 40,
}
const valueStyle: React.CSSProperties = {
  color: '#aaa',
}
