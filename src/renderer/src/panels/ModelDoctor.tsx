/**
 * renderer/panels/ModelDoctor.tsx — Task 21 + Task 25
 *
 * Docked drawer (NEVER a blocking modal — Spec §8.6) listing every part whose
 * resolution status ≠ ok. Per part:
 *   - amber/red status pill + warnings (grey "open by design" + informational
 *     why-note for documented opens — M9)
 *   - actions: [Stub open] [Stub short] [Interactive pins] [Import .lib…] [Ask your LLM]
 *   - a pin-map editor: a table mapping each pad number ↔ model terminal name
 *
 * Every change re-runs resolveAll via the store and flags `deckDirty`
 * (the store actions handle both — see stubPart / setPinMap).
 *
 * Task 25 adds inline LlmAssist and LibImport panels wired to the store's
 * validateSubckt + saveUserModel actions.
 *
 * Pure React over the store; validated by build + Phase 6 E2E.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import type { Resolution, PinMap } from '../../../core/models/types'
import type { Part } from '../../../core/netlist/extract'
import LlmAssist from './LlmAssist'
import LibImport from './LibImport'
import type { PadInfo } from '../../../core/models/llmPrompt'
import type { LlmAssistProps } from './LlmAssist'
import type { LibImportProps } from './LibImport'

export interface ModelDoctorHandlers {
  /** Open the .lib import flow for a part (Task 25). */
  onImportLib?: (ref: string) => void
  /** Copy an LLM prompt for a part to the clipboard (Task 25). */
  onAskLlm?: (ref: string) => void
}

/**
 * Reveal a Doctor card that just became the store selection (selection sync:
 * clicking a part row / board part scrolls its card into view). Defensive
 * about the element and the method: jsdom (and detached nodes) may not have
 * scrollIntoView. Exported for unit tests.
 */
export function _revealDoctorCard(
  el: { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void } | null,
): void {
  el?.scrollIntoView?.({ block: 'nearest' })
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
  const schematicSimData = useApp(s => s.schematicSimData)
  const selectedRef = useApp(s => s.selectedRef)
  const [pinEditorOpen, setPinEditorOpen] = useState(false)
  const [showLlmAssist, setShowLlmAssist] = useState(false)
  const [showLibImport, setShowLibImport] = useState(false)
  const [forcePinMapOpen, setForcePinMapOpen] = useState(false)

  const isStubbed = res.status === 'stubbed'
  // M9: documented open — the library knows this part and intentionally doesn't
  // model it. Informational (grey), with the required why-note shown prominently.
  const isOpenByDesign = res.status === 'documented-open'
  // Reset must appear whenever ANY stored override exists for this ref: a pin-map
  // edit on a documented-open card (tier 3, not stubbed) stores state that is
  // inert on the open stub but would apply to a later import — it must never be
  // uncleanable silent state (M9 review fix).
  const hasOverride = useApp(
    s => s.stubOverrides.has(res.ref) || s.pinMapOverrides.has(res.ref),
  )

  // Selection sync (F4): the highlight keys on selectedRef; the SCROLL keys on
  // the explicit revealDoctorRequest (ref + nonce), so re-requesting the
  // already-selected ref still reveals — twice in a row (a selection-transition
  // effect would no-op here; M7 review fix). revealInDoctor is the producer.
  const isSelected = selectedRef === res.ref
  const revealRequest = useApp(s => s.revealDoctorRequest)
  const cardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (revealRequest?.ref === res.ref) _revealDoctorCard(cardRef.current)
  }, [revealRequest, res.ref])

  // Build padList from part.padNet + schematic pin names for LlmAssist/LibImport.
  const padList: PadInfo[] = useMemo(() => {
    const padNums = [...part.padNet.keys()].sort(sortPads)
    const simInfo = schematicSimData?.get(part.ref)
    return padNums.map(num => {
      const pinName = simInfo?.pins.find(p => p.number === num)?.name
      return { number: num, name: pinName }
    })
  }, [part, schematicSimData])

  // Number of nodes for the subckt validation test deck.
  const nodeCount = padList.length

  // LlmAssist validateSubckt: wrap the store action (which uses the live simClient).
  const handleValidateSubckt: LlmAssistProps['validateSubckt'] = async (subcktText, _part) => {
    const subcktNameMatch = subcktText.match(/^\s*\.subckt\s+(\S+)/im)
    const subcktName = subcktNameMatch ? subcktNameMatch[1] : 'UNKNOWN'
    return store.getState().validateSubckt(subcktText, subcktName, nodeCount)
  }

  // LlmAssist onSave: persist + force pin-map review.
  const handleLlmSave: LlmAssistProps['onSave'] = (mpn, subcktText, suggestedPinMap) => {
    const subcktNameMatch = subcktText.match(/^\s*\.subckt\s+(\S+)/im)
    const subcktName = subcktNameMatch ? subcktNameMatch[1] : mpn
    store.getState().saveUserModel(
      res.ref,
      mpn,
      subcktText,
      subcktName,
      suggestedPinMap,
      'llm-generated',
    )
    setShowLlmAssist(false)
    // Force-open the pin-map editor (Spec §8.7: never auto-trust LLM pin order).
    setForcePinMapOpen(true)
    setPinEditorOpen(true)
  }

  // LibImport: open a file picker via window.circsim.openFileDialog if available.
  const handlePickFile: LibImportProps['openFilePicker'] = async () => {
    // In Electron: use the preload's openFileDialog for .lib/.sub files.
    // In tests / browser: falls back to null (file picker not available).
    if (typeof window !== 'undefined' && window.circsim?.openFileDialog) {
      const result = await window.circsim.openFileDialog({
        filters: [{ name: 'SPICE library', extensions: ['lib', 'sub'] }],
      })
      const chosenPath = result.filePaths[0]
      if (!chosenPath) return null

      // Read the file text via readFile from the preload.
      const text = window.circsim.readFile ? await window.circsim.readFile(chosenPath) : ''
      return { path: chosenPath, text }
    }
    return null
  }

  // LibImport onSave: persist binding.
  const handleLibSave: LibImportProps['onSave'] = (mpn, filePath, subcktName, pinMap) => {
    // For user-import, the subckt text comes from the file; we store the filePath reference.
    // We use the filePath as the "text" stub so spicegen can include it.
    store.getState().saveUserModel(
      res.ref,
      mpn,
      `* user-import from ${filePath}`,
      subcktName,
      pinMap,
      'user-import',
    )
    setShowLibImport(false)
    setPinEditorOpen(true)
  }

  const handleAskLlm = () => {
    if (onAskLlm) {
      onAskLlm(res.ref)
    } else {
      setShowLibImport(false)
      setShowLlmAssist(o => !o)
    }
  }

  const handleImportLib = () => {
    if (onImportLib) {
      onImportLib(res.ref)
    } else {
      setShowLlmAssist(false)
      setShowLibImport(o => !o)
    }
  }

  return (
    <div
      ref={cardRef}
      style={isSelected ? { ...rowStyle, ...rowSelectedStyle } : rowStyle}
      data-ref={res.ref}
      data-selected={isSelected || undefined}
    >
      <div style={rowHeaderStyle}>
        <span
          style={{
            ...pillStyle,
            background: isOpenByDesign ? '#95a5a6' : isStubbed ? '#f1c40f' : '#e74c3c',
          }}
        >
          {isOpenByDesign ? 'open by design' : isStubbed ? 'stubbed' : 'no model'}
        </span>
        <strong>{res.ref}</strong>
        <span style={{ color: '#aaa' }}>{part.value || '—'}</span>
        <span style={{ color: '#777', fontSize: 11 }}>{part.libId}</span>
      </div>

      {/* M9: the why-not-modeled note — informational, not an error. */}
      {res.note && (
        <div style={noteStyle} data-testid="doctor-note">
          {res.note}
        </div>
      )}

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
        <button style={btnStyle} onClick={handleImportLib}>
          Import .lib…
        </button>
        <button style={btnStyle} onClick={handleAskLlm}>
          Ask your LLM
        </button>
        <button
          style={{ ...btnStyle, background: (pinEditorOpen || forcePinMapOpen) ? '#2c4a2c' : undefined }}
          onClick={() => { setPinEditorOpen(o => !o); setForcePinMapOpen(false) }}
        >
          {pinEditorOpen ? 'Hide pin map' : 'Pin map'}
        </button>
        {(isStubbed || res.tier === 6 || hasOverride) && (
          <button style={btnGhostStyle} onClick={() => store.getState().clearPartOverride(res.ref)}>
            Reset
          </button>
        )}
      </div>

      {/* Task 25: inline LLM-assist panel */}
      {showLlmAssist && (
        <div style={{ marginTop: 8 }}>
          <LlmAssist
            part={part}
            padList={padList}
            validateSubckt={handleValidateSubckt}
            onSave={handleLlmSave}
            onClose={() => setShowLlmAssist(false)}
          />
        </div>
      )}

      {/* Task 25: inline lib-import panel */}
      {showLibImport && (
        <div style={{ marginTop: 8 }}>
          <LibImport
            part={part}
            openFilePicker={handlePickFile}
            onSave={handleLibSave}
            onClose={() => setShowLibImport(false)}
          />
        </div>
      )}

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
/** Highlight for the card of the currently selected part (selection sync, F4). */
const rowSelectedStyle: React.CSSProperties = {
  background: '#332345',
  outline: '2px solid #f1c40f',
  outlineOffset: -2,
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
/** M9: informational why-not-modeled note (documented opens) — calm, not error-pink. */
const noteStyle: React.CSSProperties = {
  marginTop: 6,
  padding: '6px 8px',
  background: '#1c2733',
  color: '#bcd3e8',
  borderLeft: '3px solid #5b7a94',
  borderRadius: 4,
  fontSize: 12,
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
