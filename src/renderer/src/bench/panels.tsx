/**
 * bench/panels.tsx — instrument front panels for the bench shelf.
 *
 * Each panel: jack row (top), controls (below). All edits route through
 * updateInstrument — the alter/re-op machinery is untouched (spec §3).
 * Control ranges/steps/labels are copied VERBATIM from the retired
 * InstrumentProps.tsx sections (that file is authoritative — see it for the
 * dc-supply / function-gen / logic-input / potentiometer knob & field specs).
 *
 * Spec: docs/superpowers/specs/2026-07-17-bench-leads-design.md §1, §3.
 */

import React from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { DragKnob, NumericField } from './controls'
import { JackView, type JackHandlers } from './JackView'
import { jacksFor, GROUND_INST_ID } from './leads'
import { UNWIRED } from '../../../core/spicegen/instruments'
import type { Instrument } from '../../../core/spicegen/instruments'

interface PanelProps<K extends Instrument['kind']> {
  inst: Extract<Instrument, { kind: K }> & { id: string }
  handlers?: JackHandlers
}

// ── dc-supply ────────────────────────────────────────────────────────────────
// Ranges verbatim from InstrumentProps.tsx's dc-supply block (Voltage 0–30 V,
// Series R min 0.001 Ω); the auto-supply-note copy matches that block too.

export function SupplyPanel({ inst, handlers }: PanelProps<'dc-supply'>): React.ReactElement {
  const store = useAppStoreApi()
  const autoId = useApp(s => s.autoAttachedSupplyId)
  const update = (next: Instrument): void => store.getState().updateInstrument(inst.id, next)
  return (
    <div style={faceStyle}>
      <div style={jackRowStyle}>
        {jacksFor(inst, inst.id).map(j => <JackView key={j.key} jack={j} handlers={handlers} />)}
      </div>
      <DragKnob
        value={inst.volts} min={0} max={30} step={0.1} label="Volts" unit="V"
        testId="supply-volts-knob"
        onChange={v => update({ ...inst, volts: v })}
      />
      <NumericField
        label="Voltage" value={inst.volts} unit="V" min={0} max={30}
        testId="supply-volts-input"
        onChange={v => update({ ...inst, volts: v })}
      />
      <NumericField
        label="Series R" value={inst.seriesOhms} unit="Ω" min={0.001}
        onChange={v => update({ ...inst, seriesOhms: v })}
      />
      {autoId === inst.id && (
        <div style={autoNoteStyle} data-testid="auto-supply-note">
          Auto-attached — adjust the voltage or choose another net.
        </div>
      )}
    </div>
  )
}

// ── function-gen ─────────────────────────────────────────────────────────────
// Wave buttons + knob ranges verbatim from InstrumentProps.tsx's function-gen
// block (Freq 1–1e6 Hz log, Amp 0–20 V, Offset ±20 V, Duty 1–99 %).

export function FunctionGenPanel({ inst, handlers }: PanelProps<'function-gen'>): React.ReactElement {
  const store = useAppStoreApi()
  const update = (next: Instrument): void => store.getState().updateInstrument(inst.id, next)
  return (
    <div style={faceStyle}>
      <div style={jackRowStyle}>
        {jacksFor(inst, inst.id).map(j => <JackView key={j.key} jack={j} handlers={handlers} />)}
      </div>
      <div style={fieldRowStyle}>
        <label style={fieldLabelStyle}>Wave</label>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['sine', 'square', 'pulse', 'triangle'] as const).map(w => (
            <button
              key={w}
              style={{ ...waveBtnStyle, ...(inst.wave === w ? waveBtnActiveStyle : {}) }}
              onClick={() => update({ ...inst, wave: w })}
            >
              {w}
            </button>
          ))}
        </div>
      </div>
      <DragKnob
        label="Freq" value={inst.freqHz} min={1} max={1_000_000} step={1} unit="Hz" log
        onChange={v => update({ ...inst, freqHz: v })}
      />
      <DragKnob
        label="Amp" value={inst.amplitudeV} min={0} max={20} step={0.1} unit="V"
        onChange={v => update({ ...inst, amplitudeV: v })}
      />
      <DragKnob
        label="Offset" value={inst.offsetV} min={-20} max={20} step={0.1} unit="V"
        onChange={v => update({ ...inst, offsetV: v })}
      />
      {(inst.wave === 'square' || inst.wave === 'pulse') && (
        <DragKnob
          label="Duty" value={inst.dutyPct ?? 50} min={1} max={99} step={1} unit="%"
          onChange={v => update({ ...inst, dutyPct: v })}
        />
      )}
    </div>
  )
}

// ── logic-input ──────────────────────────────────────────────────────────────
// Hi/Lo toggle + vHigh range (0–30 V) verbatim from InstrumentProps.tsx.

export function LogicInputPanel({ inst, handlers }: PanelProps<'logic-input'>): React.ReactElement {
  const store = useAppStoreApi()
  const update = (next: Instrument): void => store.getState().updateInstrument(inst.id, next)
  return (
    <div style={faceStyle}>
      <div style={jackRowStyle}>
        {jacksFor(inst, inst.id).map(j => <JackView key={j.key} jack={j} handlers={handlers} />)}
      </div>
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
        label="V High" value={inst.vHigh} unit="V" min={0} max={30}
        onChange={v => update({ ...inst, vHigh: v })}
      />
    </div>
  )
}

// ── potentiometer ────────────────────────────────────────────────────────────
// Wiper knob (0–100 %) + Total R field verbatim from InstrumentProps.tsx.
// Mode toggle is new (bench-only): switching builds the OTHER mode's record,
// carrying over totalOhms/wiperPct; every net field on the new record starts
// UNWIRED (spec §5 — the orphaned netLo wire is discarded on switch to
// rheostat; the new A/W jacks on either mode start open, matching a fresh
// palette instrument's wiring state).

export function PotPanel({ inst, handlers }: PanelProps<'potentiometer'>): React.ReactElement {
  const store = useAppStoreApi()
  const update = (next: Instrument): void => store.getState().updateInstrument(inst.id, next)
  const switchMode = (): void => {
    const next: Instrument =
      inst.mode === 'rheostat'
        ? {
            kind: 'potentiometer', mode: 'divider', id: inst.id,
            netHi: UNWIRED, netW: UNWIRED, netLo: UNWIRED,
            totalOhms: inst.totalOhms, wiperPct: inst.wiperPct,
          }
        : {
            kind: 'potentiometer', mode: 'rheostat', id: inst.id,
            netA: UNWIRED, netW: UNWIRED,
            totalOhms: inst.totalOhms, wiperPct: inst.wiperPct,
          }
    update(next)
  }
  return (
    <div style={faceStyle}>
      <div style={jackRowStyle}>
        {jacksFor(inst, inst.id).map(j => <JackView key={j.key} jack={j} handlers={handlers} />)}
      </div>
      <div style={toggleRowStyle}>
        <button
          style={{ ...waveBtnStyle, ...(inst.mode === 'rheostat' ? waveBtnActiveStyle : {}) }}
          onClick={() => inst.mode !== 'rheostat' && switchMode()}
        >
          Rheostat
        </button>
        <button
          style={{ ...waveBtnStyle, ...(inst.mode === 'divider' ? waveBtnActiveStyle : {}) }}
          onClick={() => inst.mode !== 'divider' && switchMode()}
        >
          Divider
        </button>
      </div>
      <DragKnob
        label="Wiper" value={Math.round(inst.wiperPct * 100)} min={0} max={100} step={1} unit="%"
        onChange={pct => update({ ...inst, wiperPct: Math.max(0, Math.min(1, pct / 100)) })}
      />
      <NumericField
        label="Total R" value={inst.totalOhms} unit="Ω" min={1}
        onChange={v => update({ ...inst, totalOhms: v })}
      />
    </div>
  )
}

// ── probes (voltage + current) ────────────────────────────────────────────────
// New bench-only readout: voltage probes show the last op-solve voltage on
// their net; current probes show the clamped component ref. Neither existed
// in InstrumentProps.tsx (it only offered the color picker there).

interface ProbePanelProps {
  inst: (Extract<Instrument, { kind: 'voltage-probe' }> | Extract<Instrument, { kind: 'current-probe' }>) & { id: string }
  handlers?: JackHandlers
}

export function ProbePanel({ inst, handlers }: ProbePanelProps): React.ReactElement {
  const opVoltages = useApp(s => s.opVoltages)
  const readout =
    inst.kind === 'voltage-probe'
      ? (() => {
          const v = opVoltages?.get(inst.netId)
          return v !== undefined ? `${v.toFixed(3)} V` : '—'
        })()
      : (inst.ref !== '' ? inst.ref : '—')
  return (
    <div style={faceStyle}>
      <div style={jackRowStyle}>
        {jacksFor(inst, inst.id).map(j => <JackView key={j.key} jack={j} handlers={handlers} />)}
      </div>
      <div style={{ width: 12, height: 12, borderRadius: 2, background: inst.color }} />
      <div style={probeReadoutStyle}>{readout}</div>
    </div>
  )
}

// ── ground ───────────────────────────────────────────────────────────────────
// Not offered in the palette — mirrors and re-attaches the already-designated
// ground (spec §7); GroundSetup remains the designation flow.

export function GroundPanel({
  groundNetId, handlers,
}: {
  groundNetId: number | null
  handlers?: JackHandlers
}): React.ReactElement {
  const circuit = useApp(s => s.circuit)
  const netName =
    groundNetId !== null
      ? circuit?.nets.find(n => n.id === groundNetId)?.kicadName ?? String(groundNetId)
      : '—'
  const jacks = jacksFor({ kind: 'ground-ref', netId: groundNetId ?? UNWIRED }, GROUND_INST_ID)
  return (
    <div style={faceStyle}>
      <div style={jackRowStyle}>
        {jacks.map(j => <JackView key={j.key} jack={j} handlers={handlers} />)}
      </div>
      <div style={probeReadoutStyle}>{netName}</div>
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

export const faceStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
  padding: '8px 10px', minWidth: 96,
}
const jackRowStyle: React.CSSProperties = { display: 'flex', gap: 10 }
const autoNoteStyle: React.CSSProperties = {
  fontSize: 9, color: '#c9a44a', maxWidth: 90, textAlign: 'center',
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

const probeReadoutStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 11,
  color: '#9cf',
}
