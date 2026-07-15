/**
 * renderer/panels/InstrumentRack.tsx — Task 22
 *
 * Virtual bench instrument rack (Spec §9, §11).
 *
 * Layout:
 *   - Top section: draggable instrument chips (dc-supply, function-gen,
 *     logic-input, voltage-probe). Drag onto the board → resolves to picked net.
 *     Drag onto a net name in the list → attach directly.
 *   - Middle section: attached instruments list with remove buttons.
 *   - Bottom section: InstrumentProps for the selected instrument.
 *
 * Drop-target handling for the 3D board is wired in Viewport.tsx via
 * onNetDrop(netId, instrumentKind) → addInstrument. The rack generates a
 * stable drag-data payload (JSON with kind) that the viewport drop handler reads.
 *
 * Viewport badges (probe markers) are updated by the store change; scene.ts
 * calls markers.addProbeMarker on the viewport side (Task 20 wiring is in
 * App.tsx which subscribes to store.instruments and drives the scene).
 *
 * Spec §9, §4 steps 3–5, §11.
 */

import React, { useState, useCallback, useEffect } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { AUTO_SUPPLY_ID, nextProbeColor } from '../store/appStore'
import InstrumentProps, { McuPinsPanel } from './InstrumentProps'
import type { Instrument } from '../../../core/spicegen/instruments'

// ── Draggable chip definitions ────────────────────────────────────────────────

type DroppableKind = 'dc-supply' | 'function-gen' | 'logic-input' | 'voltage-probe' | 'current-probe'

interface ChipDef {
  kind: DroppableKind
  label: string
  color: string
  shortLabel: string
}

const INSTRUMENT_CHIPS: ChipDef[] = [
  { kind: 'dc-supply',    label: 'DC Supply',    color: '#f96', shortLabel: 'PSU' },
  { kind: 'function-gen', label: 'Func Gen',     color: '#9cf', shortLabel: 'FG'  },
  { kind: 'logic-input',  label: 'Logic In',     color: '#fc6', shortLabel: 'LI'  },
  { kind: 'voltage-probe', label: 'V Probe',     color: '#6f6', shortLabel: 'VP'  },
  { kind: 'current-probe', label: 'I Probe',     color: '#f6f', shortLabel: 'IP'  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

let _idCounter = 0
function genId(kind: string): string {
  return `${kind.replace(/-/g, '_')}_${++_idCounter}`
}

// NOTE — no local color logic here: probe trace colors come from the store's
// single allocator (nextProbeColor / attachProbeToNet), so drag-drop and
// click-to-probe can never hand out colliding colors (M7 review fix).
// Voltage probes don't pass through this builder at all (see handleNetDrop).
function buildDefaultInstrument(
  kind: Exclude<DroppableKind, 'voltage-probe'>,
  netId: number,
  probeColor: string,
  ref?: string,
): Instrument {
  switch (kind) {
    case 'dc-supply':
      return { kind: 'dc-supply', id: genId(kind), netId, volts: 5, seriesOhms: 0.1 }
    case 'function-gen':
      return {
        kind: 'function-gen', id: genId(kind), netId,
        wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
      }
    case 'logic-input':
      return { kind: 'logic-input', id: genId(kind), netId, level: 0, vHigh: 3.3 }
    case 'current-probe':
      return { kind: 'current-probe', id: genId(kind), ref: ref ?? '', color: probeColor }
  }
}

function instrumentKindLabel(kind: string): string {
  switch (kind) {
    case 'dc-supply':     return 'DC Supply'
    case 'function-gen':  return 'Func Gen'
    case 'logic-input':   return 'Logic In'
    case 'voltage-probe': return 'V Probe'
    case 'current-probe': return 'I Probe'
    case 'ground-ref':    return 'Ground'
    default:              return kind
  }
}

function instrumentNetLabel(inst: Instrument, netName: (id: number) => string): string {
  if (inst.kind === 'ground-ref') return `@ ${netName(inst.netId)}`
  if (inst.kind === 'current-probe') return `@ ${inst.ref}${inst.pad ? ` pad ${inst.pad}` : ''}`
  if ('netId' in inst) return `@ ${netName(inst.netId)}`
  return ''
}

function instrumentChipColor(kind: string): string {
  return INSTRUMENT_CHIPS.find(c => c.kind === kind)?.color ?? '#aaa'
}

// ── InstrumentChip (draggable) ────────────────────────────────────────────────

interface DraggableChipProps {
  chip: ChipDef
}

function DraggableChip({ chip }: DraggableChipProps): React.ReactElement {
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(
        'application/circsim-instrument',
        JSON.stringify({ kind: chip.kind }),
      )
      e.dataTransfer.effectAllowed = 'copy'
    },
    [chip.kind],
  )

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      style={{ ...chipStyle, borderColor: chip.color }}
      title={`Drag ${chip.label} onto a net on the board or into the list below`}
    >
      <span style={{ color: chip.color, fontWeight: 700, fontSize: 10 }}>{chip.shortLabel}</span>
      <span style={{ color: '#aaa', fontSize: 9 }}>{chip.label}</span>
    </div>
  )
}

// ── Net list (for drop target without 3D viewport) ────────────────────────────

interface NetDropTargetProps {
  netId: number
  netName: string
  onDrop: (netId: number, kind: DroppableKind) => void
}

function NetDropTarget({ netId, netName, onDrop }: NetDropTargetProps): React.ReactElement {
  const [hover, setHover] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setHover(true)
  }, [])

  const handleDragLeave = useCallback(() => setHover(false), [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setHover(false)
      try {
        const data = JSON.parse(e.dataTransfer.getData('application/circsim-instrument')) as { kind: DroppableKind }
        onDrop(netId, data.kind)
      } catch {
        // malformed drag data — ignore
      }
    },
    [netId, onDrop],
  )

  return (
    <div
      style={{
        ...netDropStyle,
        ...(hover ? netDropHoverStyle : {}),
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span style={netDropLabelStyle}>{netName}</span>
    </div>
  )
}

// ── Probe this net button ────────────────────────────────────────────────────

/**
 * "⌖ Probe this net" (Gemini finding 3): the old dark-green-on-dark styling
 * read as disabled. Solid V-Probe-green resting state + JS hover brighten
 * (the NetDropTarget pattern — there is no stylesheet).
 */
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

// ── Attached instrument row ───────────────────────────────────────────────────

interface AttachedRowProps {
  inst: Instrument & { id?: string }
  netName: (id: number) => string
  isSelected: boolean
  onSelect: () => void
  onRemove: () => void
}

function AttachedRow({ inst, netName, isSelected, onSelect, onRemove }: AttachedRowProps): React.ReactElement {
  const color = instrumentChipColor(inst.kind)
  const label = instrumentKindLabel(inst.kind)
  const subLabel = instrumentNetLabel(inst, netName)

  return (
    <div
      style={{
        ...attachedRowStyle,
        background: isSelected ? '#1e2a4a' : 'transparent',
      }}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onSelect()}
    >
      <span style={{ ...attachedDotStyle, background: color }} />
      <span style={attachedKindStyle}>{label}</span>
      <span style={attachedNetStyle}>{subLabel}</span>
      {inst.kind !== 'ground-ref' && (
        <button
          style={removeStyle}
          onClick={e => { e.stopPropagation(); onRemove() }}
          title="Remove instrument"
          aria-label={`Remove ${label}`}
        >
          ×
        </button>
      )}
    </div>
  )
}

// ── Main InstrumentRack ───────────────────────────────────────────────────────

export default function InstrumentRack(): React.ReactElement {
  const store = useAppStoreApi()
  const circuit = useApp(s => s.circuit)
  const instruments = useApp(s => s.instruments)
  const resolutions = useApp(s => s.resolutions)
  // Selection lives in the STORE (Milestone 2) so actions elsewhere — e.g.
  // GroundSetup's click-to-attach supply chips — can reveal an instrument here.
  const selectedInstId = useApp(s => s.selectedInstrumentId)
  const setSelectedInstId = useCallback(
    (id: string | null) => store.getState().selectInstrument(id),
    [store],
  )
  const [showNetList, setShowNetList] = useState(false)

  // Click-to-probe (M7 F6): the net currently selected on the board (or in any
  // net list) gets a drag-free "Probe this net" action right here in the rack.
  const selectedNetId = useApp(s => s.selectedNetId)
  const selectedNet =
    selectedNetId !== null ? circuit?.nets.find(n => n.id === selectedNetId) : undefined

  // Auto-select the supply that the store auto-attaches on open, so its
  // properties (the voltage input) are immediately visible without a click —
  // the user lands ready to tweak the supply (Spec §4). Runs once per open
  // (keyed on the auto supply's presence) and never fights a later manual pick.
  const hasAutoSupply = useApp(s =>
    s.instruments.some(i => 'id' in i && (i as { id: string }).id === AUTO_SUPPLY_ID),
  )
  useEffect(() => {
    if (hasAutoSupply) setSelectedInstId(AUTO_SUPPLY_ID)
    else setSelectedInstId(null)
  }, [hasAutoSupply, setSelectedInstId])

  const netName = useCallback(
    (netId: number): string => circuit?.nets.find(n => n.id === netId)?.kicadName ?? String(netId),
    [circuit],
  )

  // Drop onto net name list
  const handleNetDrop = useCallback(
    (netId: number, kind: DroppableKind) => {
      // Voltage probes go through the store's shared attach path — per-net
      // dedupe + the ONE color allocator (selects the probe itself).
      if (kind === 'voltage-probe') {
        store.getState().attachProbeToNet(netId)
        return
      }
      const inst = buildDefaultInstrument(
        kind,
        netId,
        nextProbeColor(store.getState().instruments),
      )
      store.getState().addInstrument(inst)
      if ('id' in inst) setSelectedInstId(inst.id)
    },
    [store],
  )

  // Get selected instrument (must have an id)
  const selectedInst = instruments.find(
    i => 'id' in i && (i as { id: string }).id === selectedInstId,
  ) as (Instrument & { id: string }) | undefined

  // Check if selected instrument's ref is an interactive-pins stub
  const isMcuPins =
    selectedInst?.kind === 'logic-input' &&
    resolutions.find(r => {
      const ref = 'ref' in selectedInst ? selectedInst.ref : undefined
      return ref && r.ref === ref && r.model?.kind === 'stub' && r.model.mode === 'interactive-pins'
    }) !== undefined

  // Determine MCU ref for the McuPinsPanel (based on selectedRef from parts panel, or none)
  const selectedMcuRef = useApp(s => s.selectedRef)
  const isMcuSelected =
    selectedMcuRef !== null &&
    resolutions.some(
      r => r.ref === selectedMcuRef && r.model?.kind === 'stub' && r.model.mode === 'interactive-pins',
    )

  return (
    <div style={rackStyle}>
      <div style={rackHeaderStyle}>Instruments</div>

      {/* Draggable chip palette */}
      <div style={chipsRowStyle}>
        {INSTRUMENT_CHIPS.map(chip => (
          <DraggableChip key={chip.kind} chip={chip} />
        ))}
      </div>

      {/* Click-to-probe: drag-free V-Probe attach on the selected net (M7 F6).
          Uses the same store path (addInstrument via attachProbeToNet) as the
          drag-drop routes — no duplicated attachment logic. */}
      {selectedNet && (
        <div style={probeNetRowStyle}>
          <span style={probeNetLabelStyle}>Net:</span>
          <span style={probeNetNameStyle} title={selectedNet.kicadName}>
            {selectedNet.kicadName}
          </span>
          <ProbeNetButton netId={selectedNet.id} netName={selectedNet.kicadName} />
        </div>
      )}

      {/* Net drop list (collapsible) */}
      {circuit && (
        <div style={netListSectionStyle}>
          <button
            style={collapseToggleStyle}
            onClick={() => setShowNetList(v => !v)}
          >
            {showNetList ? '▾' : '▸'} Drop onto net
          </button>
          {showNetList && (
            <div style={netListStyle}>
              {circuit.nets
                .filter(n => n.kicadName !== '')
                .slice(0, 20)
                .map(n => (
                  <NetDropTarget
                    key={n.id}
                    netId={n.id}
                    netName={n.kicadName}
                    onDrop={handleNetDrop}
                  />
                ))}
            </div>
          )}
        </div>
      )}

      {/* Attached instruments list */}
      <div style={attachedListStyle}>
        {instruments.length === 0 && (
          <div style={emptyHintStyle}>
            Drag chips above onto the board or a net name.
          </div>
        )}
        {instruments.map((inst, i) => {
          const id = 'id' in inst ? (inst as { id: string }).id : `ground_${i}`
          return (
            <AttachedRow
              key={id}
              inst={inst as Instrument & { id?: string }}
              netName={netName}
              isSelected={selectedInstId === id}
              onSelect={() => setSelectedInstId(selectedInstId === id ? null : id)}
              onRemove={() => {
                // removeInstrument also clears the store selection when needed.
                if ('id' in inst) store.getState().removeInstrument((inst as { id: string }).id)
              }}
            />
          )
        })}
      </div>

      {/* Properties panel for selected instrument */}
      {selectedInst && !isMcuPins && (
        <InstrumentProps instrument={selectedInst} />
      )}

      {/* MCU interactive-pins panel when an interactive-pins part is selected in Parts */}
      {isMcuSelected && selectedMcuRef && (
        <McuPinsPanel ref_={selectedMcuRef} />
      )}
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const rackStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  background: '#15151f',
  color: '#ddd',
  fontSize: 12,
  overflowY: 'auto',
}

const rackHeaderStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontWeight: 600,
  borderBottom: '1px solid #2a2a3a',
  fontSize: 13,
}

const chipsRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  padding: '8px 10px',
  borderBottom: '1px solid #2a2a3a',
}

const chipStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  width: 52,
  padding: '4px 2px',
  background: '#1e1e2e',
  border: '1px solid #4a4a6a',
  borderRadius: 4,
  cursor: 'grab',
  userSelect: 'none',
  gap: 2,
}

// Click-to-probe row for the selected net (M7 F6).
const probeNetRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  borderBottom: '1px solid #2a2a3a',
  fontSize: 11,
}

const probeNetLabelStyle: React.CSSProperties = {
  color: '#888',
}

const probeNetNameStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: 'monospace',
  color: '#9ab',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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

const netListSectionStyle: React.CSSProperties = {
  borderBottom: '1px solid #2a2a3a',
}

const collapseToggleStyle: React.CSSProperties = {
  width: '100%',
  background: 'none',
  border: 'none',
  color: '#888',
  fontSize: 11,
  padding: '4px 10px',
  cursor: 'pointer',
  textAlign: 'left',
}

const netListStyle: React.CSSProperties = {
  maxHeight: 120,
  overflowY: 'auto',
}

const netDropStyle: React.CSSProperties = {
  padding: '3px 10px',
  borderBottom: '1px solid #1a1a2a',
  cursor: 'default',
  fontSize: 11,
  transition: 'background 0.1s',
}

const netDropHoverStyle: React.CSSProperties = {
  background: '#1e2640',
  borderColor: '#4a6090',
}

const netDropLabelStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  color: '#9ab',
}

const attachedListStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  borderBottom: '1px solid #2a2a3a',
}

const emptyHintStyle: React.CSSProperties = {
  padding: '12px 10px',
  color: '#555',
  fontSize: 11,
  textAlign: 'center',
}

const attachedRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderBottom: '1px solid #1d1d2a',
  cursor: 'pointer',
}

const attachedDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
}

const attachedKindStyle: React.CSSProperties = {
  fontWeight: 600,
  minWidth: 60,
  fontSize: 11,
}

const attachedNetStyle: React.CSSProperties = {
  flex: 1,
  color: '#888',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const removeStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#666',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  padding: '0 2px',
  flexShrink: 0,
}
