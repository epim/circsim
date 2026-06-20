/**
 * renderer/panels/CoachNotes.tsx — First Light (L3)
 *
 * The plain-language "why isn't my LED glowing?" coach surface: a small,
 * non-blocking stack of friendly hints, one per dark LED. Notes come from the
 * store's `coachNotes` (diagnoseDarkLeds, rebuilt after every op solve), so this
 * is purely presentational — the diagnosis logic + note construction are
 * unit-tested in core/live/coach + the store.
 *
 * Each note carries data-testid="coach-note" so an E2E can assert the coach
 * surfaced (and read its ref via data-ref). Renders nothing when every LED is
 * lit (coachNotes empty).
 */

import React from 'react'
import { useApp } from '../store/storeContext'

export default function CoachNotes(): React.ReactElement | null {
  const notes = useApp(s => s.coachNotes)
  if (notes.length === 0) return null

  return (
    <div style={wrapStyle} data-testid="coach-notes">
      {notes.map(note => (
        <div key={note.ref} style={noteStyle} data-testid="coach-note" data-ref={note.ref}>
          <div style={titleStyle}>
            <span style={bulbStyle} aria-hidden>💡</span>
            {note.title}
          </div>
          <div style={detailStyle}>{note.detail}</div>
          <div style={suggestionStyle}>{note.suggestion}</div>
        </div>
      ))}
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const wrapStyle: React.CSSProperties = {
  position: 'absolute',
  left: 8,
  bottom: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  maxWidth: 320,
  zIndex: 5,
  pointerEvents: 'none',
}
const noteStyle: React.CSSProperties = {
  background: '#1c2436',
  border: '1px solid #2e3c58',
  borderLeft: '3px solid #6aa0ff',
  borderRadius: 5,
  padding: '8px 10px',
  color: '#dbe6ff',
  fontSize: 12.5,
  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
}
const titleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontWeight: 600,
}
const bulbStyle: React.CSSProperties = {
  fontSize: 13,
}
const detailStyle: React.CSSProperties = {
  marginTop: 3,
  color: '#b9c6e0',
  lineHeight: 1.35,
}
const suggestionStyle: React.CSSProperties = {
  marginTop: 4,
  color: '#9fd6a8',
  fontStyle: 'italic',
}
