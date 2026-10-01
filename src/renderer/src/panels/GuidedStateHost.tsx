/**
 * renderer/panels/GuidedStateHost.tsx -- issue #32 (Spec section 12)
 *
 * Mounts the guided empty-state cards (NoGroundState / NoSourceState) when an
 * Energize / Power On / Run attempt was blocked, so the click is never a silent
 * no-op. The store records the attempt in `guidedBlock`; this host picks which
 * card applies from the LIVE state (ground first, then source) and clears the
 * record as soon as nothing blocks any more (the user set a ground, wired a
 * source, ...), so a stale card can never reappear later.
 */

import React, { useEffect } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { suggestGround } from '../../../core/netlist/extract'
import { wiredInstruments } from '../../../core/spicegen/instruments'
import { NoGroundState, NoSourceState } from './EmptyStates'

/** The block that currently applies, from live state (ground before source). */
export function currentBlock(
  groundNetId: number | null,
  hasWiredSource: boolean,
): 'no-ground' | 'no-source' | null {
  if (groundNetId === null) return 'no-ground'
  if (!hasWiredSource) return 'no-source'
  return null
}

export default function GuidedStateHost(): React.ReactElement | null {
  const store = useAppStoreApi()
  const circuit = useApp(s => s.circuit)
  const guidedBlock = useApp(s => s.guidedBlock)
  const groundNetId = useApp(s => s.groundNetId)
  const instruments = useApp(s => s.instruments)

  const hasWiredSource = wiredInstruments(instruments).some(
    i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
  )
  const live = circuit ? currentBlock(groundNetId, hasWiredSource) : null

  // Nothing blocks any more: forget the attempt so the card does not come back.
  useEffect(() => {
    if (guidedBlock !== null && live === null) store.getState().dismissGuidedBlock()
  }, [guidedBlock, live, store])

  if (!circuit || guidedBlock === null || live === null) return null

  const suggestedGroundName =
    live === 'no-ground' ? suggestGround(circuit.nets)?.kicadName : undefined

  return (
    <div style={wrapStyle} data-testid="guided-state-host">
      <button
        style={closeBtnStyle}
        onClick={() => store.getState().dismissGuidedBlock()}
        aria-label="Dismiss"
        data-testid="guided-state-dismiss"
      >
        Dismiss
      </button>
      {live === 'no-ground' ? (
        <NoGroundState suggestedGroundName={suggestedGroundName} />
      ) : (
        <NoSourceState />
      )}
    </div>
  )
}

// -- styles --------------------------------------------------------------------

const wrapStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 6,
  background: '#1b1b28',
  border: '1px solid #3a3a55',
  borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
  fontSize: 13,
}
const closeBtnStyle: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  background: 'transparent',
  border: '1px solid #3a3a55',
  borderRadius: 4,
  color: '#99a',
  fontSize: 11,
  padding: '2px 8px',
  cursor: 'pointer',
}
