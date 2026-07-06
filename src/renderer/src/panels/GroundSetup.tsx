/**
 * renderer/panels/GroundSetup.tsx — Task 22
 *
 * Ground + supply net confirmation panel (Spec §4 step 3, §12).
 *
 * Shown after a board is loaded. Presents:
 *   - An auto-suggested ground net (from suggestGround heuristic) with a
 *     "click on the board to pick a different net" affordance.
 *   - Suggested supply nets as click-to-attach chips (Milestone 2): clicking a
 *     chip attaches a default DC supply on that net (or selects the existing
 *     one), and a "Choose…" picker designates ANY net as a supply — the manual
 *     path for boards whose rail names defeat the heuristics.
 *   - A clear "ground is required before Run" message when no ground is designated.
 *
 * Ground can be confirmed by:
 *   (a) Clicking a suggested ground net in the list.
 *   (b) The parent wiring a viewport clickNet event to setGround.
 *
 * Validated by GroundSetup.test.tsx (static render) + store-level tests for
 * attachSupplyToNet, plus Phase 6 E2E (no headless GL needed here).
 */

import React, { useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'

export default function GroundSetup(): React.ReactElement | null {
  const store = useAppStoreApi()
  const circuit = useApp(s => s.circuit)
  const groundNetId = useApp(s => s.groundNetId)
  const suggestedSupplyNetIds = useApp(s => s.suggestedSupplyNetIds)
  const instruments = useApp(s => s.instruments)
  const [showSupplyPicker, setShowSupplyPicker] = useState(false)

  // Don't render until a board is loaded
  if (!circuit) return null

  const nets = circuit.nets
  const groundNet = groundNetId !== null ? nets.find(n => n.id === groundNetId) : undefined
  // Never offer the designated ground net as a supply chip — attaching a
  // supply there would drive SPICE node 0 (defense in depth; the extract-level
  // heuristic and attachSupplyToNet guard this too).
  const supplyNets = nets.filter(n => suggestedSupplyNetIds.includes(n.id) && n.id !== groundNetId)

  // Nets that already carry a DC supply — their chips render "attached".
  const supplyAttachedNetIds = new Set(
    instruments.filter(i => i.kind === 'dc-supply').map(i => (i as { netId: number }).netId),
  )

  const attachSupply = (netId: number): void => {
    store.getState().attachSupplyToNet(netId)
    setShowSupplyPicker(false)
  }

  // All nets (for the pick lists — allow user to re-assign ground / designate a supply)
  const allNets = nets.filter(n => n.id !== 0 && n.kicadName !== '')

  return (
    <div style={containerStyle}>
      <div style={sectionTitleStyle}>Ground &amp; Power</div>

      {/* Ground assignment */}
      <div style={groundRowStyle}>
        <span style={labelStyle}>Ground:</span>
        {groundNet ? (
          <span style={confirmedStyle} title={`SPICE node: ${groundNet.spiceNode}`}>
            {groundNet.kicadName}
          </span>
        ) : (
          <span style={missingStyle}>NOT SET — Run disabled</span>
        )}
      </div>

      {/* Suggested ground nets (if no ground set yet) */}
      {!groundNet && (
        <div style={suggestionBlockStyle}>
          <div style={hintStyle}>Click a net below or on the board to set ground:</div>
          {allNets.slice(0, 6).map(n => (
            <button
              key={n.id}
              style={netChipStyle}
              onClick={() => store.getState().setGround(n.id)}
              title={`Set ${n.kicadName} as ground`}
            >
              {n.kicadName}
            </button>
          ))}
        </div>
      )}

      {/* Change ground button when already set */}
      {groundNet && (
        <div style={changeRowStyle}>
          <button
            style={changeGroundBtnStyle}
            onClick={() => store.getState().setGround(null)}
            title="Clear the current ground assignment"
          >
            Change…
          </button>
          {/* Quick-pick other nets */}
          {allNets
            .filter(n => n.id !== groundNetId)
            .slice(0, 4)
            .map(n => (
              <button
                key={n.id}
                style={netChipStyle}
                onClick={() => store.getState().setGround(n.id)}
              >
                {n.kicadName}
              </button>
            ))}
        </div>
      )}

      {/* Supply nets — chips attach a default DC supply; Choose… designates any net */}
      <div style={{ marginTop: 8 }}>
        <div style={labelStyle}>
          {supplyNets.length > 0 ? 'Suggested supply nets:' : 'Supply nets: none suggested'}
        </div>
        <div style={chipRowStyle}>
          {supplyNets.map(n => {
            const attached = supplyAttachedNetIds.has(n.id)
            return (
              <button
                key={n.id}
                data-testid="supply-chip"
                data-supply-attached={attached ? 'true' : 'false'}
                style={attached ? supplyChipAttachedStyle : supplyChipStyle}
                onClick={() => attachSupply(n.id)}
                title={
                  attached
                    ? `${n.kicadName} has a DC supply attached — click to edit it`
                    : `Attach a 5 V DC supply to ${n.kicadName}`
                }
              >
                {attached ? '✓ ' : ''}
                {n.kicadName}
              </button>
            )
          })}
          <button
            data-testid="supply-choose"
            style={changeGroundBtnStyle}
            onClick={() => setShowSupplyPicker(v => !v)}
            title="Attach a DC supply to any net on the board"
          >
            Choose…
          </button>
        </div>
        {showSupplyPicker && (
          <div style={changeRowStyle}>
            {allNets.map(n => (
              <button
                key={n.id}
                data-testid="supply-pick"
                style={netChipStyle}
                onClick={() => attachSupply(n.id)}
                title={`Attach a 5 V DC supply to ${n.kicadName}`}
              >
                {supplyAttachedNetIds.has(n.id) ? '✓ ' : ''}
                {n.kicadName}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid #2a2a3a',
  fontSize: 12,
  color: '#ccc',
}

const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: '#888',
  marginBottom: 6,
}

const groundRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 4,
}

const labelStyle: React.CSSProperties = {
  color: '#888',
  minWidth: 52,
}

const confirmedStyle: React.CSSProperties = {
  background: '#1a3a1a',
  color: '#6f6',
  borderRadius: 3,
  padding: '1px 6px',
  fontFamily: 'monospace',
  fontSize: 11,
}

const missingStyle: React.CSSProperties = {
  color: '#f85',
  fontStyle: 'italic',
  fontSize: 11,
}

const suggestionBlockStyle: React.CSSProperties = {
  marginTop: 4,
}

const hintStyle: React.CSSProperties = {
  color: '#888',
  marginBottom: 4,
  fontSize: 11,
}

const netChipStyle: React.CSSProperties = {
  background: '#1e2640',
  border: '1px solid #3a4060',
  borderRadius: 3,
  color: '#9ab',
  fontSize: 11,
  fontFamily: 'monospace',
  padding: '2px 6px',
  cursor: 'pointer',
  marginRight: 4,
  marginBottom: 4,
}

const changeRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  marginTop: 4,
}

const changeGroundBtnStyle: React.CSSProperties = {
  background: '#2a2a3a',
  border: '1px solid #4a4a5a',
  borderRadius: 3,
  color: '#aaa',
  fontSize: 11,
  padding: '2px 8px',
  cursor: 'pointer',
}

const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginTop: 4,
}

const supplyChipStyle: React.CSSProperties = {
  background: '#2a1a1a',
  border: '1px solid #5a3a2a',
  borderRadius: 3,
  color: '#f96',
  fontFamily: 'monospace',
  fontSize: 11,
  padding: '2px 6px',
  cursor: 'pointer',
}

// Filled variant for a chip whose net already carries a DC supply.
const supplyChipAttachedStyle: React.CSSProperties = {
  ...supplyChipStyle,
  background: '#3a2410',
  border: '1px solid #f96',
  color: '#fc9',
  fontWeight: 600,
}
