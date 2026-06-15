/**
 * renderer/panels/ModelDoctor.tsx — Task 21
 *
 * Docked drawer (NEVER a blocking modal — Spec §8.6) listing every part whose
 * resolution status ≠ ok. Per part:
 *   - amber/red status pill + warnings
 *   - actions: [Stub open] [Stub short] [Interactive pins] [Import .lib…] [Ask your LLM]
 *   - a pin-map editor: a table mapping each pad number ↔ model terminal name
 *
 * Every change re-runs resolveAll via the store and flags `deckDirty`
 * (the store actions handle both — see stubPart / setPinMap).
 *
 * [Import .lib…] and [Ask your LLM] are wired to store hooks that Task 25
 * fills in; here they invoke callbacks the parent supplies (so the drawer is
 * self-contained and testable). When no handler is supplied they are inert.
 *
 * Pure React over the store; validated by build + Phase 6 E2E.
 */

import React, { useMemo, useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import type { Resolution, PinMap } from '../../../core/models/types'
import type { Part } from '../../../core/netlist/extract'

export interface ModelDoctorHandlers {
  /** Open the .lib import flow for a part (Task 25). */
  onImportLib?: (ref: string) => void
  /** Copy an LLM prompt for a part to the clipboard (Task 25). */
  onAskLlm?: (ref: string) => void
}

export default function ModelDoctor(props: ModelDoctorHandlers): React.ReactElement | null {
  const resolutions = useApp(s => s.resolutions)
  const parts = useApp(s => s.circuit?.parts ?? EMPTY_PARTS)

  // Parts needing attention: any status ≠ ok.
  const problems = useMemo(
    () => resolutions.filter(r => r.status !== 'ok'),
    [resolutions],
  )

  if (problems.length === 0) return null

  const partByRef = new Map(parts.map(p => [p.ref, p]))

  return (
    <div style={drawerStyle} data-testid="model-doctor">
      <div style={headerStyle}>
        Model Doctor
        <span style={countStyle}>{problems.length}</span>
      </div>
      <div style={bodyStyle}>
        {problems.map(res => {
          const part = partByRef.get(res.ref)
          if (!part) return null
          return <DoctorRow key={res.ref} res={res} part={part} {...props} />
        })}
      </div>
    </div>
  )
}

function DoctorRow({
  res,
  part,
  onImportLib,
  onAskLlm,
}: { res: Resolution; part: Part } & ModelDoctorHandlers): React.ReactElement {
  const store = useAppStoreApi()
  const [pinEditorOpen, setPinEditorOpen] = useState(false)

  const isStubbed = res.status === 'stubbed'

  return (
    <div style={rowStyle} data-ref={res.ref}>
      <div style={rowHeaderStyle}>
        <span style={{ ...pillStyle, background: isStubbed ? '#f1c40f' : '#e74c3c' }}>
          {isStubbed ? 'stubbed' : 'no model'}
        </span>
        <strong>{res.ref}</strong>
        <span style={{ color: '#aaa' }}>{part.value || '—'}</span>
        <span style={{ color: '#777', fontSize: 11 }}>{part.libId}</span>
      </div>

      {res.warnings.length > 0 && (
        <ul style={warnListStyle}>
          {res.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div style={actionsStyle}>
        <button style={btnStyle} onClick={() => store.getState().stubPart(res.ref, 'open')}>
          Stub open
        </button>
        <button style={btnStyle} onClick={() => store.getState().stubPart(res.ref, 'short')}>
          Stub short
        </button>
        <button
          style={btnStyle}
          onClick={() => store.getState().stubPart(res.ref, 'interactive-pins')}
        >
          Interactive pins
        </button>
        <button style={btnStyle} onClick={() => onImportLib?.(res.ref)} disabled={!onImportLib}>
          Import .lib…
        </button>
        <button style={btnStyle} onClick={() => onAskLlm?.(res.ref)} disabled={!onAskLlm}>
          Ask your LLM
        </button>
        <button style={btnStyle} onClick={() => setPinEditorOpen(o => !o)}>
          {pinEditorOpen ? 'Hide pin map' : 'Pin map'}
        </button>
        {(isStubbed || res.tier === 6) && (
          <button style={btnGhostStyle} onClick={() => store.getState().clearPartOverride(res.ref)}>
            Reset
          </button>
        )}
      </div>

      {pinEditorOpen && <PinMapEditor part={part} res={res} />}
    </div>
  )
}

/**
 * Pin-map editor: one row per pad number. The user picks the model terminal
 * each pad maps to. Editing commits the full map through `setPinMap` (re-resolve
 * + deckDirty). Candidate terminal names come from the resolved subckt pinMap
 * (if any) or the schematic pin names; the field is also free-text so the user
 * can type an arbitrary node name/index.
 */
function PinMapEditor({ part, res }: { part: Part; res: Resolution }): React.ReactElement {
  const store = useAppStoreApi()
  const existingOverride = useApp(s => s.pinMapOverrides.get(part.ref))
  const schematicSimData = useApp(s => s.schematicSimData)

  const padNumbers = useMemo(() => [...part.padNet.keys()].sort(sortPads), [part])

  // Seed the working map from: override → resolved subckt pinMap → empty.
  const seed: PinMap = useMemo(() => {
    if (existingOverride) return existingOverride
    if (res.model?.kind === 'subckt' || res.model?.kind === 'xspice-digital') {
      return res.model.pinMap
    }
    return {}
  }, [existingOverride, res])

  const [draft, setDraft] = useState<PinMap>(seed)

  // Candidate terminal names (datalist) from schematic pin names, when present.
  const terminalCandidates = useMemo(() => {
    const names = new Set<string>()
    const info = schematicSimData?.get(part.ref)
    if (info) {
      for (const pin of info.pins) {
        if (pin.name) names.add(pin.name)
      }
    }
    // include any seed values
    for (const v of Object.values(seed)) if (v) names.add(v)
    return [...names]
  }, [schematicSimData, part, seed])

  const commit = (next: PinMap): void => {
    setDraft(next)
    store.getState().setPinMap(part.ref, next)
  }

  const listId = `terminals-${part.ref}`

  return (
    <div style={pinEditorStyle}>
      <div style={pinEditorHeaderStyle}>Pin map — pad ↔ model terminal</div>
      <datalist id={listId}>
        {terminalCandidates.map(name => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <table style={pinTableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Pad</th>
            <th style={thStyle}>Pin name</th>
            <th style={thStyle}>Model terminal</th>
          </tr>
        </thead>
        <tbody>
          {padNumbers.map(pad => {
            const pinName = schematicSimData?.get(part.ref)?.pins.find(p => p.number === pad)?.name
            return (
              <tr key={pad}>
                <td style={tdStyle}>{pad}</td>
                <td style={{ ...tdStyle, color: '#999' }}>{pinName ?? '—'}</td>
                <td style={tdStyle}>
                  <input
                    type="text"
                    list={listId}
                    value={draft[pad] ?? ''}
                    placeholder="terminal"
                    onChange={e => commit({ ...draft, [pad]: e.target.value })}
                    style={pinInputStyle}
                    aria-label={`terminal for pad ${pad}`}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── pad sort: numeric pads numerically, otherwise lexical ──────────────────────
function sortPads(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return a.localeCompare(b)
}

const EMPTY_PARTS: Part[] = []

// ── styles ──────────────────────────────────────────────────────────────────
const drawerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: '40%',
  background: '#1a1320',
  color: '#eee',
  borderTop: '1px solid #3a2a3a',
  fontSize: 13,
}
const headerStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  borderBottom: '1px solid #3a2a3a',
}
const countStyle: React.CSSProperties = {
  background: '#e67e22',
  color: '#000',
  borderRadius: 10,
  padding: '0 7px',
  fontSize: 11,
  fontWeight: 700,
}
const bodyStyle: React.CSSProperties = { overflowY: 'auto', padding: 6 }
const rowStyle: React.CSSProperties = {
  padding: 8,
  marginBottom: 6,
  background: '#241a2c',
  borderRadius: 6,
}
const rowHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}
const pillStyle: React.CSSProperties = {
  color: '#000',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  fontWeight: 700,
}
const warnListStyle: React.CSSProperties = {
  margin: '6px 0 6px 18px',
  color: '#d9a',
  fontSize: 12,
}
const actionsStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 6,
}
const btnStyle: React.CSSProperties = {
  background: '#3a2f4a',
  color: '#eee',
  border: '1px solid #4a3a5a',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 12,
  cursor: 'pointer',
}
const btnGhostStyle: React.CSSProperties = {
  ...btnStyle,
  background: 'transparent',
  color: '#aaa',
}
const pinEditorStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 8,
  background: '#1c141f',
  borderRadius: 4,
}
const pinEditorHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#aaa',
  marginBottom: 6,
}
const pinTableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  color: '#888',
  fontWeight: 500,
  padding: '2px 6px',
  borderBottom: '1px solid #332a3a',
}
const tdStyle: React.CSSProperties = {
  padding: '2px 6px',
  borderBottom: '1px solid #261f2c',
}
const pinInputStyle: React.CSSProperties = {
  width: '100%',
  background: '#0c0c14',
  border: '1px solid #2a2a3a',
  borderRadius: 3,
  color: '#ddd',
  fontSize: 12,
  padding: '2px 4px',
}
