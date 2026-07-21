/**
 * renderer/panels/InstrumentProps.tsx — Task 22
 *
 * Instrument properties editor (Spec §9).
 *
 * Renders the detail panel for a selected instrument showing:
 *   - dc-supply: volts knob + series-R field
 *   - function-gen: wave-type selector + freq/amplitude/offset/duty knobs
 *   - logic-input: Hi/Lo toggle (level) + vHigh field
 *   - voltage-probe: color picker + net label
 *   - current-probe: ref + pad label
 *   - MCU interactive-pins: per-pad Hi-Z / 0 / 1 / Watch toggles (for
 *     'interactive-pins' stubs; pin names from schematic when present)
 *
 * All parameter changes route through updateInstrument (alterPlan decides live
 * alter vs reload).
 *
 * Validated by build + Phase 6 E2E (no headless GL).
 * Spec §9, §4 steps 3–5.
 */

import React, { useCallback } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { DragKnob, NumericField } from '../bench/controls'
import type { Instrument } from '../../../core/spicegen/instruments'

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

// ── Main component ────────────────────────────────────────────────────────────

interface InstrumentPropsProps {
  instrument: Instrument & { id: string }
}

export default function InstrumentProps({ instrument }: InstrumentPropsProps): React.ReactElement {
  const store = useAppStoreApi()
  const circuit = useApp(s => s.circuit)
  // Announce a supply circsim attached itself (open / energize) until the user
  // edits or removes it (M7 F7) — never shown for user-attached supplies.
  const autoAttachedSupplyId = useApp(s => s.autoAttachedSupplyId)

  const update = useCallback(
    (next: Instrument) => store.getState().updateInstrument(instrument.id, next),
    [store, instrument.id],
  )

  const netName = (netId: number): string =>
    circuit?.nets.find(n => n.id === netId)?.kicadName ?? String(netId)

  // ── dc-supply ──────────────────────────────────────────────────────────────
  if (instrument.kind === 'dc-supply') {
    const inst = instrument
    return (
      <div style={propsStyle}>
        <div style={propsHeaderStyle}>DC Supply — {netName(inst.netId)}</div>
        {inst.id === autoAttachedSupplyId && (
          <div style={autoNoteStyle} data-testid="auto-supply-note">
            Auto-attached — adjust the voltage or choose another net.
          </div>
        )}
        <NumericField
          label="Voltage"
          value={inst.volts}
          unit="V"
          min={0}
          max={30}
          onChange={v => update({ ...inst, volts: v })}
          testId="supply-volts-input"
        />
        <NumericField
          label="Series R"
          value={inst.seriesOhms}
          unit="Ω"
          min={0.001}
          onChange={v => update({ ...inst, seriesOhms: v })}
        />
      </div>
    )
  }

  // ── function-gen ──────────────────────────────────────────────────────────
  if (instrument.kind === 'function-gen') {
    const inst = instrument
    return (
      <div style={propsStyle}>
        <div style={propsHeaderStyle}>Function Gen — {netName(inst.netId)}</div>

        {/* Wave type */}
        <div style={fieldRowStyle}>
          <label style={fieldLabelStyle}>Wave</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['sine', 'square', 'pulse', 'triangle'] as const).map(w => (
              <button
                key={w}
                style={{
                  ...waveBtnStyle,
                  ...(inst.wave === w ? waveBtnActiveStyle : {}),
                }}
                onClick={() => update({ ...inst, wave: w })}
              >
                {w}
              </button>
            ))}
          </div>
        </div>

        <div style={knobRowStyle}>
          <DragKnob
            label="Freq"
            value={inst.freqHz}
            min={1}
            max={1_000_000}
            step={1}
            unit="Hz"
            log
            onChange={v => update({ ...inst, freqHz: v })}
          />
          <DragKnob
            label="Amp"
            value={inst.amplitudeV}
            min={0}
            max={20}
            step={0.1}
            unit="V"
            onChange={v => update({ ...inst, amplitudeV: v })}
          />
          <DragKnob
            label="Offset"
            value={inst.offsetV}
            min={-20}
            max={20}
            step={0.1}
            unit="V"
            onChange={v => update({ ...inst, offsetV: v })}
          />
          {(inst.wave === 'square' || inst.wave === 'pulse') && (
            <DragKnob
              label="Duty"
              value={inst.dutyPct ?? 50}
              min={1}
              max={99}
              step={1}
              unit="%"
              onChange={v => update({ ...inst, dutyPct: v })}
            />
          )}
        </div>
      </div>
    )
  }

  // ── logic-input ───────────────────────────────────────────────────────────
  if (instrument.kind === 'logic-input') {
    const inst = instrument
    return (
      <div style={propsStyle}>
        <div style={propsHeaderStyle}>Logic Input — {netName(inst.netId)}</div>
        <div style={toggleRowStyle}>
          <button
            style={{ ...toggleBtnStyle, ...(inst.level === 0 ? toggleBtnLowStyle : {}) }}
            onClick={() => update({ ...inst, level: 0 })}
          >
            LO
          </button>
          <button
            style={{ ...toggleBtnStyle, ...(inst.level === 1 ? toggleBtnHighStyle : {}) }}
            onClick={() => update({ ...inst, level: 1 })}
          >
            HI
          </button>
        </div>
        <NumericField
          label="V High"
          value={inst.vHigh}
          unit="V"
          min={0}
          max={30}
          onChange={v => update({ ...inst, vHigh: v })}
        />
      </div>
    )
  }

  // ── potentiometer ─────────────────────────────────────────────────────────
  // "Turn the pot": a single wiper knob (0..100%). Dragging calls
  // updateInstrument → alterPlan live-alters the rpot resistor value(s).
  // (3D knob mesh is a follow-up; this reuses the 2D DragKnob.)
  if (instrument.kind === 'potentiometer') {
    const inst = instrument
    const header =
      inst.mode === 'rheostat'
        ? `Potentiometer (rheostat) — ${netName(inst.netA)}↔${netName(inst.netW)}`
        : `Potentiometer (divider) — ${netName(inst.netHi)}/${netName(inst.netW)}/${netName(inst.netLo)}`
    return (
      <div style={propsStyle}>
        <div style={propsHeaderStyle}>{header}</div>
        <div style={knobRowStyle}>
          <DragKnob
            label="Wiper"
            value={Math.round(inst.wiperPct * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={pct => update({ ...inst, wiperPct: Math.max(0, Math.min(1, pct / 100)) })}
          />
        </div>
        <NumericField
          label="Total R"
          value={inst.totalOhms}
          unit="Ω"
          min={1}
          onChange={v => update({ ...inst, totalOhms: v })}
        />
      </div>
    )
  }

  // ── voltage-probe ─────────────────────────────────────────────────────────
  if (instrument.kind === 'voltage-probe') {
    const inst = instrument
    return (
      <div style={propsStyle}>
        <div style={propsHeaderStyle}>Voltage Probe — {netName(inst.netId)}</div>
        <div style={fieldRowStyle}>
          <label style={fieldLabelStyle}>Color</label>
          <input
            type="color"
            value={inst.color}
            onChange={e => update({ ...inst, color: e.target.value })}
            style={{ cursor: 'pointer' }}
          />
        </div>
      </div>
    )
  }

  // ── current-probe ─────────────────────────────────────────────────────────
  if (instrument.kind === 'current-probe') {
    const inst = instrument
    return (
      <div style={propsStyle}>
        <div style={propsHeaderStyle}>Current Probe — {inst.ref}{inst.pad ? ` pad ${inst.pad}` : ''}</div>
        <div style={fieldRowStyle}>
          <label style={fieldLabelStyle}>Color</label>
          <input
            type="color"
            value={inst.color}
            onChange={e => update({ ...inst, color: e.target.value })}
            style={{ cursor: 'pointer' }}
          />
        </div>
      </div>
    )
  }

  // ── MCU interactive-pins panel ─────────────────────────────────────────────
  // This is reached when the selected component is a stub 'interactive-pins'.
  // We need to find its resolution + part to list pads.
  // InstrumentProps doesn't directly receive a resolution; the InstrumentRack
  // renders a special McuPinsPanel instead. This path is a fallback.
  return (
    <div style={propsStyle}>
      <div style={propsHeaderStyle}>Ground reference</div>
      <div style={{ color: '#888', fontSize: 11, padding: 4 }}>Node 0 (SPICE ground)</div>
    </div>
  )
}

// ── MCU Pins panel (rendered by InstrumentRack for interactive-pins stubs) ───

interface McuPinsPanelProps {
  ref_: string  // component ref (e.g. "U1")
}

export function McuPinsPanel({ ref_ }: McuPinsPanelProps): React.ReactElement {
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
        <div style={propsHeaderStyle}>{ref_} — Interactive Pins</div>
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
      <div style={propsHeaderStyle}>{ref_} — Interactive Pins</div>
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

// One-line announcement on a supply circsim attached itself (M7 F7).
const autoNoteStyle: React.CSSProperties = {
  marginBottom: 6,
  fontSize: 11,
  fontStyle: 'italic',
  color: '#fc9',
}

const knobRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  marginBottom: 6,
}

const fieldRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 4,
}

const fieldLabelStyle: React.CSSProperties = {
  color: '#888',
  minWidth: 52,
  fontSize: 11,
}

const waveBtnStyle: React.CSSProperties = {
  background: '#1e2640',
  border: '1px solid #3a4060',
  borderRadius: 3,
  color: '#888',
  fontSize: 10,
  padding: '2px 5px',
  cursor: 'pointer',
}

const waveBtnActiveStyle: React.CSSProperties = {
  background: '#2a4080',
  borderColor: '#5a80c0',
  color: '#9cf',
}

const toggleRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginBottom: 6,
}

const toggleBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px 0',
  background: '#1e2640',
  border: '1px solid #3a4060',
  borderRadius: 4,
  color: '#888',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
}

const toggleBtnLowStyle: React.CSSProperties = {
  background: '#3a1a1a',
  borderColor: '#8a3a3a',
  color: '#f66',
}

const toggleBtnHighStyle: React.CSSProperties = {
  background: '#1a3a1a',
  borderColor: '#3a8a3a',
  color: '#6f6',
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
