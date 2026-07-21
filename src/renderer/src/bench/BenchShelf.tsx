/**
 * bench/BenchShelf.tsx — the horizontal instrument shelf below the viewport.
 * Spec §1: panels side by side, scrollable; ＋ Add instrument palette;
 * probe-this-net affordance carried over from the retired rack (M7 F6).
 */

import React, { useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import {
  SupplyPanel, FunctionGenPanel, LogicInputPanel, PotPanel, ProbePanel, GroundPanel,
} from './panels'
import type { JackHandlers } from './JackView'
import type { BenchKind } from './leads'
import type { Instrument } from '../../../core/spicegen/instruments'

const PALETTE: Array<{ kind: BenchKind; label: string }> = [
  { kind: 'dc-supply', label: 'DC Supply' },
  { kind: 'function-gen', label: 'Function Gen' },
  { kind: 'logic-input', label: 'Logic Input' },
  { kind: 'voltage-probe', label: 'V Probe' },
  { kind: 'current-probe', label: 'I Probe' },
  { kind: 'potentiometer', label: 'Potentiometer' },
]

export default function BenchShelf({ jackHandlers }: { jackHandlers?: JackHandlers }): React.ReactElement {
  const store = useAppStoreApi()
  const instruments = useApp(s => s.instruments)
  const groundNetId = useApp(s => s.groundNetId)
  const circuit = useApp(s => s.circuit)
  const selectedNetId = useApp(s => s.selectedNetId)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const selectedNet =
    selectedNetId !== null ? circuit?.nets.find(n => n.id === selectedNetId) : undefined

  const panelFor = (inst: Instrument, _i: number): React.ReactElement | null => {
    if (!('id' in inst)) return null // ground-ref renders separately
    const key = inst.id
    switch (inst.kind) {
      case 'dc-supply':     return <ShelfSlot key={key} title="PSU" instId={inst.id}><SupplyPanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      case 'function-gen':  return <ShelfSlot key={key} title="FUNC GEN" instId={inst.id}><FunctionGenPanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      case 'logic-input':   return <ShelfSlot key={key} title="LOGIC" instId={inst.id}><LogicInputPanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      case 'potentiometer': return <ShelfSlot key={key} title="POT" instId={inst.id}><PotPanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      case 'voltage-probe':
      case 'current-probe': return <ShelfSlot key={key} title={inst.kind === 'voltage-probe' ? 'V PROBE' : 'I PROBE'} instId={inst.id}><ProbePanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      default: return null
    }
  }

  return (
    <div style={shelfStyle} data-testid="bench-shelf">
      <div style={shelfHeaderStyle}>
        <span style={{ fontWeight: 600 }}>Bench</span>
        {selectedNet && (
          <span style={probeRowStyle}>
            <span style={{ color: '#888' }}>Net:</span>
            <span style={{ fontFamily: 'monospace', color: '#9ab' }}>{selectedNet.kicadName}</span>
            <ProbeNetButton netId={selectedNet.id} netName={selectedNet.kicadName} />
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ position: 'relative' }}>
          <button
            data-testid="add-instrument-btn"
            style={addBtnStyle}
            onClick={() => setPaletteOpen(v => !v)}
          >
            ＋ Add instrument
          </button>
          <div style={{ ...paletteStyle, display: paletteOpen ? 'flex' : 'none' }}>
            {PALETTE.map(p => (
              <button
                key={p.kind}
                data-testid={`palette-${p.kind}`}
                style={paletteItemStyle}
                onClick={() => { store.getState().addBenchInstrument(p.kind); setPaletteOpen(false) }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </span>
      </div>
      <div style={panelsRowStyle}>
        {groundNetId !== null && (
          <ShelfSlot title="GND" instId={null}>
            <GroundPanel groundNetId={groundNetId} handlers={jackHandlers} />
          </ShelfSlot>
        )}
        {instruments.map(panelFor)}
      </div>
    </div>
  )
}

// ── ShelfSlot ────────────────────────────────────────────────────────────────
// Title bar + optional ✕ (removeInstrument) wrapping a front panel's children.
// instId === null (the ground panel) never shows the remove button — ground
// designation lives in GroundSetup, not here (spec §7).

function ShelfSlot({
  title, instId, children,
}: {
  title: string
  instId: string | null
  children: React.ReactNode
}): React.ReactElement {
  const store = useAppStoreApi()
  return (
    <div style={slotStyle}>
      <div style={slotTitleBarStyle}>
        <span style={slotTitleStyle}>{title}</span>
        {instId !== null && (
          <button
            style={slotCloseStyle}
            onClick={() => store.getState().removeInstrument(instId)}
            title="Remove instrument"
            aria-label={`Remove ${title}`}
          >
            ×
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

// ── Probe this net button ────────────────────────────────────────────────────
// Moved verbatim from InstrumentRack.tsx:190-205 (Gemini finding 3 — the old
// dark-green-on-dark styling read as disabled; solid V-Probe-green resting
// state + JS hover brighten). Pinned regression: keep the #2a6b3a background.

function ProbeNetButton({ netId, netName }: { netId: number; netName: string }): React.ReactElement {
  const store = useAppStoreApi()
  const [hover, setHover] = useState(false)
  return (
    <button
      data-testid="probe-net-btn"
      style={hover ? { ...probeNetBtnStyle, background: '#35854a', borderColor: '#55bf75' } : probeNetBtnStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => store.getState().attachProbeToNet(netId)}
      title={`Attach a V-Probe to ${netName}`}
    >
      ⌖ Probe this net
    </button>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const shelfStyle: React.CSSProperties = {
  borderTop: '1px solid #2a2a3a', background: '#12121c', color: '#ddd',
  display: 'flex', flexDirection: 'column', fontSize: 12,
}
const shelfHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px',
  borderBottom: '1px solid #22222f',
}
const probeRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }
const addBtnStyle: React.CSSProperties = {
  background: '#2a2a45', color: '#eee', border: '1px solid #3a3a55',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12,
}
const paletteStyle: React.CSSProperties = {
  // Open DOWNWARD from the add button into the shelf body. Opening upward
  // (bottom:110%) overflowed above the top of <main> (overflow:hidden) in
  // short windows, where it was clipped and the click landed on the toolbar
  // behind it — a real small-window bug that broke instrument-adding on
  // constrained displays (e.g. CI). Downward growth stays inside main.
  position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 30,
  flexDirection: 'column', gap: 2, padding: 6,
  background: '#1e1e2e', border: '1px solid #3a3a55', borderRadius: 6,
}
const paletteItemStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#dde', padding: '5px 12px',
  cursor: 'pointer', textAlign: 'left', fontSize: 12, whiteSpace: 'nowrap',
}
const panelsRowStyle: React.CSSProperties = {
  display: 'flex', gap: 8, padding: '6px 10px', overflowX: 'auto', minHeight: 120,
}
const probeNetBtnStyle: React.CSSProperties = {
  background: '#2a6b3a',
  border: '1px solid #3f9f5f',
  borderRadius: 3,
  color: '#e6ffe9',
  fontSize: 11,
  fontWeight: 600,
  padding: '3px 10px',
  cursor: 'pointer',
  flexShrink: 0,
}
const slotStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column',
  background: '#181822', border: '1px solid #2a2a3a', borderRadius: 6,
  flexShrink: 0,
}
const slotTitleBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '3px 8px', borderBottom: '1px solid #22222f',
  fontSize: 10, fontWeight: 600, color: '#889', letterSpacing: '0.03em',
}
const slotTitleStyle: React.CSSProperties = {}
const slotCloseStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#666', cursor: 'pointer',
  fontSize: 14, lineHeight: 1, padding: '0 2px',
}
