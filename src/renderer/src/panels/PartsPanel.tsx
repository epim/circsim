/**
 * renderer/panels/PartsPanel.tsx — Task 21
 *
 * Left-dock Parts / BOM list (Spec §11). For every part in the circuit shows the
 * ref, value, and a status badge (ok = green, stubbed = amber, unresolved = red,
 * documented-open = grey "Open by design", M9). The badge never relies on color
 * alone (issue #70): each status has its own dot shape plus a visible text label.
 *
 * Parts are grouped by status with the ones that need attention first and a
 * count in each heading (issue #72), and the list is windowed once it grows past
 * ~100 rows so a several-hundred-part board does not mount every row.
 *
 * The list is searchable (ref or value substring) and selection is synced
 * bidirectionally with the viewport via the store's `selectedRef`:
 *   - clicking a row sets `selectedRef` (→ viewport highlights the component)
 *   - the viewport's clickComponent pick sets `selectedRef` (→ row highlights
 *     here, and the list scrolls to it)
 *
 * Pure React over the store; validated by build + Phase 6 E2E.
 */

import React, { useMemo, useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { statusBadge, type StatusBadge } from '../store/appStore'
import type { Resolution } from '../../../core/models/types'
import type { Part } from '../../../core/netlist/extract'
import { TEXT_MUTED } from '../ui/palette'
import WindowedList from './WindowedList'

const BADGE_COLORS: Record<StatusBadge, string> = {
  ok: '#2ecc71',
  amber: '#f1c40f',
  red: '#e74c3c',
  grey: '#95a5a6',
}

const BADGE_LABEL: Record<StatusBadge, string> = {
  ok: 'OK',
  amber: 'Stubbed',
  red: 'No model',
  grey: 'Open by design',
}

/** Longer explanation for the tooltip (plain language, issue #73). */
const BADGE_HINT: Record<StatusBadge, string> = {
  ok: 'OK: this part has a working model.',
  amber: 'Stubbed: this part is a placeholder (left open, shorted, or driven by hand), not a real model.',
  red: 'No model: circsim found no model for this part, so it contributes nothing to the simulation.',
  grey: 'Open by design: this part is deliberately not simulated (for example a connector).',
}

/**
 * Dot shape per status, so the four states differ by shape as well as color:
 * circle = ok, diamond = stubbed, square = no model, ring = open by design.
 */
const BADGE_SHAPE: Record<StatusBadge, React.CSSProperties> = {
  ok: { borderRadius: '50%' },
  amber: { borderRadius: 1, transform: 'rotate(45deg)' },
  red: { borderRadius: 0 },
  grey: { borderRadius: '50%', background: 'transparent', border: '2px solid #95a5a6', boxSizing: 'border-box' },
}

/** Fixed heights (px) so the list can be windowed without measuring. */
const ROW_H = 30
const HEADING_H = 24

type PartGroup = 'attention' | 'open' | 'ok'

const GROUP_TITLE: Record<PartGroup, string> = {
  attention: 'Needs attention',
  open: 'Open by design',
  ok: 'OK',
}

export type PartItem =
  | { kind: 'heading'; group: PartGroup; title: string; count: number }
  | { kind: 'part'; part: Part; badge: StatusBadge }

/**
 * Group parts by status: needs attention (no model, then stubbed), open by
 * design, then ok, each keeping board order. Headings carry counts and appear
 * only when more than one group is non-empty, so an all-ok board stays a plain
 * list. Pure; exported for tests.
 */
export function buildPartItems(
  parts: readonly Part[],
  resByRef: ReadonlyMap<string, Resolution>,
): PartItem[] {
  const red: PartItem[] = []
  const amber: PartItem[] = []
  const grey: PartItem[] = []
  const ok: PartItem[] = []
  for (const part of parts) {
    const res = resByRef.get(part.ref)
    const badge: StatusBadge = res ? statusBadge(res) : 'red'
    const item: PartItem = { kind: 'part', part, badge }
    if (badge === 'red') red.push(item)
    else if (badge === 'amber') amber.push(item)
    else if (badge === 'grey') grey.push(item)
    else ok.push(item)
  }
  const groups: { group: PartGroup; rows: PartItem[] }[] = [
    { group: 'attention' as const, rows: [...red, ...amber] },
    { group: 'open' as const, rows: grey },
    { group: 'ok' as const, rows: ok },
  ].filter(g => g.rows.length > 0)
  if (groups.length < 2) return groups.flatMap(g => g.rows)
  return groups.flatMap(g => [
    { kind: 'heading', group: g.group, title: GROUP_TITLE[g.group], count: g.rows.length } as PartItem,
    ...g.rows,
  ])
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

  const items = useMemo(() => buildPartItems(filtered, resByRef), [filtered, resByRef])
  const heights = useMemo(
    () => items.map(it => (it.kind === 'heading' ? HEADING_H : ROW_H)),
    [items],
  )
  const selectedIndex = useMemo(
    () =>
      selectedRef === null
        ? null
        : items.findIndex(it => it.kind === 'part' && it.part.ref === selectedRef),
    [items, selectedRef],
  )

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
      {filtered.length === 0 && (
        <div style={{ padding: 8, color: '#888', fontSize: 12 }}>
          {parts.length === 0 ? 'No board loaded.' : 'No matching parts.'}
        </div>
      )}
      <WindowedList
        items={items}
        heights={heights}
        itemKey={(it, i) => (it.kind === 'part' ? it.part.ref : `heading:${it.group}:${i}`)}
        revealIndex={selectedIndex}
        revealNonce={selectedRef}
        style={listStyle}
        renderItem={it => {
          if (it.kind === 'heading') {
            return (
              <div style={headingStyle} data-testid="parts-group-heading" data-group={it.group}>
                {it.title} ({it.count})
              </div>
            )
          }
          const { part, badge } = it
          const isSelected = part.ref === selectedRef
          return (
            <div
              role="button"
              tabIndex={0}
              // Selecting a row also reveals its Model Doctor card (nonce-based
              // revealInDoctor — M7 review fix); deselecting is plain selection.
              onClick={() =>
                isSelected
                  ? store.getState().selectComponent(null)
                  : store.getState().revealInDoctor(part.ref)
              }
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  if (isSelected) store.getState().selectComponent(null)
                  else store.getState().revealInDoctor(part.ref)
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
                style={{ ...badgeStyle, background: BADGE_COLORS[badge], ...BADGE_SHAPE[badge] }}
                title={BADGE_HINT[badge]}
                data-testid={`status-badge-${badge}`}
              />
              <span style={refStyle}>{part.ref}</span>
              <span style={valueStyle}>{part.value || '—'}</span>
              <span
                style={statusLabelStyle}
                title={BADGE_HINT[badge]}
                data-testid={`status-label-${badge}`}
              >
                {BADGE_LABEL[badge]}
              </span>
            </div>
          )
        }}
      />
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
  minHeight: 0,
  overflowY: 'auto',
}
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: ROW_H,
  boxSizing: 'border-box',
  overflow: 'hidden',
  padding: '0 10px',
  cursor: 'pointer',
  borderBottom: '1px solid #1d1d2a',
}
const headingStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: HEADING_H,
  boxSizing: 'border-box',
  padding: '0 10px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: '#8a93a8',
  background: '#101019',
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
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const statusLabelStyle: React.CSSProperties = {
  color: TEXT_MUTED,
  fontSize: 11,
  flexShrink: 0,
}
