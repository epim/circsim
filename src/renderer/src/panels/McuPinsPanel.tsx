/**
 * renderer/panels/McuPinsPanel.tsx — Task 5 (Bench Leads)
 *
 * Moved verbatim out of InstrumentProps.tsx (the McuPinsPanel export + its
 * McuPinRow helper + the styles they reference), now the file's default
 * export. Renders per-pad Hi-Z / 0 / 1 / Watch toggles for a component
 * resolved to an 'interactive-pins' stub (pin names from schematic when
 * present). App.tsx gates it the same way InstrumentRack used to.
 *
 * Spec §9, §4 steps 3–5.
 */

import React, { useCallback } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'

// ── MCU Pin Rows ──────────────────────────────────────────────────────────────

type PinMode = 'hi-z' | '0' | '1' | 'watch'

interface McuPinRowProps {
  padNumber: string
  pinName?: string
  netName?: string
  netId: number
  currentMode: PinMode
  onModeChange: (padNumber: string, mode: PinMode, netId: number) => void
}

function McuPinRow({ padNumber, pinName, netName, netId, currentMode, onModeChange }: McuPinRowProps): React.ReactElement {
  return (
    <div style={pinRowStyle}>
      <span style={pinPadStyle}>{padNumber}</span>
      {pinName && <span style={pinNameStyle}>{pinName}</span>}
      {netName && <span style={pinNetStyle}>{netName}</span>}
      <div style={pinModeGroupStyle}>
        {(['hi-z', '0', '1', 'watch'] as PinMode[]).map(mode => (
          <button
            key={mode}
            style={{
              ...pinModeBtnStyle,
              ...(currentMode === mode ? pinModeActiveBtnStyle : {}),
            }}
            onClick={() => onModeChange(padNumber, mode, netId)}
            title={mode === 'hi-z' ? 'High impedance (floating)' : mode === 'watch' ? 'Voltage readout' : `Drive ${mode}`}
          >
            {mode === 'hi-z' ? 'Hi-Z' : mode.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── MCU Pins panel ─────────────────────────────────────────────────────────────

interface McuPinsPanelProps {
  ref_: string  // component ref (e.g. "U1")
}

export default function McuPinsPanel({ ref_ }: McuPinsPanelProps): React.ReactElement {
  const store = useAppStoreApi()
  const circuit = useApp(s => s.circuit)
  const schematicSimData = useApp(s => s.schematicSimData)
  const instruments = useApp(s => s.instruments)

  // Derive current per-pad mode from logic-input instruments
  const pinModeForNet = useCallback(
    (netId: number): PinMode => {
      const li = instruments.find(i => i.kind === 'logic-input' && 'netId' in i && i.netId === netId)
      if (!li) return 'hi-z'
      return ((li as { level: 0 | 1 }).level === 1 ? '1' : '0') as PinMode
    },
    [instruments],
  )

  const part = circuit?.parts.find(p => p.ref === ref_)
  const simInfo = schematicSimData?.get(ref_)

  if (!part) {
    return (
      <div style={propsStyle}>
        <div style={propsHeaderStyle}>{ref_}: Interactive Pins</div>
        <div style={{ color: '#888', fontSize: 11, padding: 4 }}>Part not in circuit.</div>
      </div>
    )
  }

  const handleModeChange = (padNumber: string, mode: PinMode, netId: number): void => {
    if (mode === 'hi-z' || mode === 'watch') {
      // Remove any logic-input on this net
      const existing = instruments.find(
        i => i.kind === 'logic-input' && 'netId' in i && i.netId === netId,
      )
      if (existing && 'id' in existing) {
        store.getState().removeInstrument(existing.id)
      }
    } else {
      const level = mode === '1' ? 1 : 0
      const existing = instruments.find(
        i => i.kind === 'logic-input' && 'netId' in i && i.netId === netId,
      )
      if (existing && 'id' in existing) {
        store.getState().updateInstrument(existing.id, {
          ...(existing as { kind: 'logic-input'; id: string; netId: number; level: 0 | 1; vHigh: number }),
          level: level as 0 | 1,
        })
      } else {
        store.getState().addInstrument({
          kind: 'logic-input',
          id: `${ref_.toLowerCase()}_pad${padNumber}_li`,
          netId,
          level: level as 0 | 1,
          vHigh: 3.3,
        })
      }
    }
  }

  return (
    <div style={propsStyle}>
      <div style={propsHeaderStyle}>{ref_}: Interactive Pins</div>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
        Hi-Z: floating | 0/1: drive logic | Watch: read voltage
      </div>
      {Array.from(part.padNet.entries()).map(([padNum, netId]) => {
        const netName = circuit?.nets.find(n => n.id === netId)?.kicadName ?? String(netId)
        // Try to get pin name from schematic
        const pinName = simInfo?.pins.find(p => p.number === padNum)?.name

        return (
          <McuPinRow
            key={padNum}
            padNumber={padNum}
            pinName={pinName}
            netName={netName}
            netId={netId}
            currentMode={pinModeForNet(netId)}
            onModeChange={handleModeChange}
          />
        )
      })}
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const propsStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 12,
  color: '#ccc',
  borderBottom: '1px solid #2a2a3a',
}

const propsHeaderStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 6,
  fontSize: 12,
  color: '#ddd',
}

const pinRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 0',
  borderBottom: '1px solid #1a1a2a',
  fontSize: 11,
}

const pinPadStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  color: '#9cf',
  minWidth: 24,
  textAlign: 'right',
}

const pinNameStyle: React.CSSProperties = {
  color: '#aaa',
  minWidth: 40,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const pinNetStyle: React.CSSProperties = {
  color: '#6a8',
  fontSize: 10,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const pinModeGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  flexShrink: 0,
}

const pinModeBtnStyle: React.CSSProperties = {
  padding: '1px 5px',
  background: '#1a1a2a',
  border: '1px solid #2a2a3a',
  borderRadius: 2,
  color: '#666',
  fontSize: 10,
  cursor: 'pointer',
}

const pinModeActiveBtnStyle: React.CSSProperties = {
  background: '#1e3460',
  borderColor: '#4a6090',
  color: '#9cf',
}
