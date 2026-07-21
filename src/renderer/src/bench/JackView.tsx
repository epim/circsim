/**
 * bench/JackView.tsx — one jack circle on a front panel.
 * Registers its DOM node with the lead layer (Task 5) and forwards
 * pointerdown so a lead drag can start. Pure presentation otherwise.
 */

import React from 'react'
import type { JackDef } from './leads'

export interface JackHandlers {
  onJackPointerDown?: (jack: JackDef, e: React.PointerEvent) => void
  registerJack?: (key: string, el: HTMLElement | null) => void
}

export function JackView({ jack, handlers }: { jack: JackDef; handlers?: JackHandlers }): React.ReactElement {
  const wired = jack.target !== null
  return (
    <div style={jackColStyle}>
      <div
        data-testid={`jack-${jack.instId}-${jack.terminal}`}
        data-wired={wired ? 'true' : 'false'}
        ref={el => handlers?.registerJack?.(jack.key, el)}
        onPointerDown={e => handlers?.onJackPointerDown?.(jack, e)}
        title={wired ? `${jack.label} — drag the clip to re-attach` : `Drag a lead from ${jack.label} onto the board`}
        style={{
          width: 14, height: 14, borderRadius: '50%', cursor: 'grab',
          border: `2px solid ${jack.color}`,
          background: wired ? jack.color : 'transparent',
          boxSizing: 'border-box',
        }}
      />
      <span style={jackLabelStyle}>{jack.label}</span>
    </div>
  )
}

const jackColStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
}
const jackLabelStyle: React.CSSProperties = { fontSize: 9, color: '#889' }
