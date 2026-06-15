/**
 * renderer/panels/SimLog.tsx — Task 24
 *
 * Streams the SimHost `log` events (ngspice stdout/stderr lines) that the store
 * accumulates in `logLines` (Spec §11 bottom dock "Sim log", §6.1 `log` event).
 *
 * - Auto-scrolls to the newest line unless the user has scrolled up.
 * - Level filter (all / warnings+errors / errors).
 * - Color-coded by level. Clear button.
 *
 * UI-only; the log accumulation is unit-tested in the store (ingestEvent → log).
 */

import React, { useEffect, useRef, useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'

type LevelFilter = 'all' | 'warn' | 'error'

const LEVEL_RANK: Record<'info' | 'warn' | 'error', number> = { info: 0, warn: 1, error: 2 }
const FILTER_RANK: Record<LevelFilter, number> = { all: 0, warn: 1, error: 2 }

export default function SimLog(): React.ReactElement {
  const store = useAppStoreApi()
  const logLines = useApp(s => s.logLines)
  const [filter, setFilter] = useState<LevelFilter>('all')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const visible = logLines.filter(l => LEVEL_RANK[l.level] >= FILTER_RANK[filter])

  // Auto-scroll to bottom when new lines arrive, unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [visible.length])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    // Within 8 px of the bottom counts as "stuck to bottom".
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
  }

  return (
    <div style={containerStyle}>
      <div style={toolbarStyle}>
        <span style={titleStyle}>Sim Log</span>
        <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          {(['all', 'warn', 'error'] as LevelFilter[]).map(f => (
            <button
              key={f}
              style={filter === f ? segActive : segBtn}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'warn' ? 'Warn+' : 'Errors'}
            </button>
          ))}
          <button style={segBtn} onClick={() => store.setState({ logLines: [] })} title="Clear log">
            Clear
          </button>
        </div>
      </div>
      <div style={scrollStyle} ref={scrollRef} onScroll={handleScroll}>
        {visible.length === 0 ? (
          <div style={emptyStyle}>No log output yet.</div>
        ) : (
          visible.map((l, i) => (
            <div key={i} style={lineStyleFor(l.level)}>
              {l.text}
            </div>
          ))
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
  fontFamily: 'monospace',
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
}
const scrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '4px 8px',
  minHeight: 0,
}
const emptyStyle: React.CSSProperties = {
  color: '#555',
  fontStyle: 'italic',
}
const segBtn: React.CSSProperties = {
  background: '#1e1e2c',
  border: '1px solid #33334a',
  color: '#99a',
  fontSize: 10,
  padding: '2px 6px',
  cursor: 'pointer',
}
const segActive: React.CSSProperties = {
  ...segBtn,
  background: '#34406a',
  borderColor: '#4a5a8a',
  color: '#dde',
}

function lineStyleFor(level: 'info' | 'warn' | 'error'): React.CSSProperties {
  const color = level === 'error' ? '#f97583' : level === 'warn' ? '#e8c07d' : '#9aa5b1'
  return { color, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
}
