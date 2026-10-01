/**
 * renderer/boardOpen/OpenProgressBar.tsx (issue #55)
 *
 * Status strip shown while a board opens. The stages run in a Worker, so this
 * keeps animating the whole time; before the fix the window simply froze.
 * Once the board is on screen the strip stays up, in a quieter wording, until
 * the Board Critic audit lands.
 */

import React from 'react'
import { useApp } from '../store/storeContext'
import { OPEN_STAGE_LABEL } from './pipeline'

const KEYFRAMES = `@keyframes circsim-open-slide { 0% { left: -30%; } 100% { left: 100%; } }`

export default function OpenProgressBar(): React.ReactElement | null {
  const progress = useApp(s => s.openProgress)
  if (!progress) return null
  const boardShown = progress.stage === 'auditing'
  return (
    <div style={stripStyle} data-testid="open-progress" data-stage={progress.stage} role="status" aria-live="polite">
      <style>{KEYFRAMES}</style>
      <span style={{ whiteSpace: 'nowrap' }}>
        {boardShown ? 'Board loaded. ' : `Opening ${progress.fileName}: `}
        {OPEN_STAGE_LABEL[progress.stage]}
        {'...'}
      </span>
      <span style={trackStyle} aria-hidden="true">
        <span style={barStyle} />
      </span>
    </div>
  )
}

const stripStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 16px',
  background: '#16243a',
  color: '#cde',
  borderBottom: '1px solid #26405f',
  fontSize: 12,
}
const trackStyle: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  height: 3,
  background: '#1f3350',
  borderRadius: 2,
  overflow: 'hidden',
}
const barStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: '30%',
  background: '#4a90d9',
  borderRadius: 2,
  animation: 'circsim-open-slide 1.1s ease-in-out infinite',
}
