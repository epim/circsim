/**
 * renderer/panels/GroundSetup.tsx — Task 22
 *
 * Ground + supply net confirmation panel (Spec §4 step 3, §12).
 *
 * Shown after a board is loaded. Presents:
 *   - An auto-suggested ground net (from suggestGround heuristic) with a
 *     "click on the board to pick a different net" affordance.
 *   - A list of auto-suggested supply nets and any currently attached instruments
 *     for quick attachment shortcuts.
 *   - A clear "ground is required before Run" message when no ground is designated.
 *
 * Ground can be confirmed by:
 *   (a) Clicking a suggested ground net in the list.
 *   (b) The parent wiring a viewport clickNet event to setGround.
 *
 * Validated by build + Phase 6 E2E (no headless GL needed here).
 */

import React from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'

export default function GroundSetup(): React.ReactElement | null {
  const store = useAppStoreApi()
  const circuit = useApp(s => s.circuit)
  const groundNetId = useApp(s => s.groundNetId)
  const suggestedSupplyNetIds = useApp(s => s.suggestedSupplyNetIds)

  // Don't render until a board is loaded
  if (!circuit) return null

  const nets = circuit.nets
  const groundNet = groundNetId !== null ? nets.find(n => n.id === groundNetId) : undefined
  const supplyNets = nets.filter(n => suggestedSupplyNetIds.includes(n.id))

  // All nets (for the pick list — allow user to re-assign ground)
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

      {/* Supply nets */}
      {supplyNets.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={labelStyle}>Suggested supply nets:</div>
          <div style={chipRowStyle}>
            {supplyNets.map(n => (
              <span key={n.id} style={supplyChipStyle}>
                {n.kicadName}
              </span>
            ))}
          </div>
        </div>
      )}
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
}
