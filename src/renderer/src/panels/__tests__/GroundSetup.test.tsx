/**
 * GroundSetup.test.tsx — Milestone 2 (supply-net detection + manual designation)
 *
 * Renders the GroundSetup panel against a REAL store (mock simClient, no
 * Electron/ngspice) with react-dom/server — no jsdom needed in the node test
 * env. Verifies the supply-chip UI:
 *   - suggested supply nets render as clickable buttons (chips)
 *   - the chip whose net already has a dc-supply attached is marked attached
 *   - a "Choose…" button exists so ANY net can be designated as a supply,
 *     including on boards where nothing was suggested (the manual case)
 *
 * Click behavior itself (attachSupplyToNet) is covered at store level in
 * store/__tests__/instruments.test.ts.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import GroundSetup from '../GroundSetup'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

// Board whose nets carry NO rail-like names → no supply suggestions.
const NO_RAIL_BOARD = `(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))
  (net 1 "IN")
  (net 2 "OUT")
  (net 3 "GND")
  (footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu")
    (at 10 10)
    (fp_text reference "R1" (at 0 -1) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu") (net 1 "IN"))
    (pad "2" smd rect (at 0.5 0) (size 0.5 0.5) (layers "F.Cu") (net 2 "OUT"))
  )
  (footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu")
    (at 14 10)
    (fp_text reference "R2" (at 0 -1) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu") (net 2 "OUT"))
    (pad "2" smd rect (at 0.5 0) (size 0.5 0.5) (layers "F.Cu") (net 3 "GND"))
  )
  (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 20 0) (end 20 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 20 20) (end 0 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (width 0.1))
)`

function renderPanelWithBoard(boardText: string, fileName: string): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.getState().openBoardFromText(boardText, fileName)
  // zustand v4 renders from getServerState ?? getInitialState under
  // react-dom/server, which would show the pre-open (empty) state. Point the
  // server snapshot at the live state so the static render sees the board.
  ;(store as unknown as { getServerState?: () => unknown }).getServerState = store.getState
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <GroundSetup />
    </AppStoreProvider>,
  )
}

describe('GroundSetup — supply chips (Milestone 2)', () => {
  it('renders suggested supply nets as buttons (clickable chips)', () => {
    const html = renderPanelWithBoard(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    // VCC is the suggested rail on fixture-555; the chip must be a <button>
    expect(html).toContain('data-testid="supply-chip"')
    const chipIsButton = /<button[^>]*data-testid="supply-chip"[^>]*>/.test(html)
    expect(chipIsButton).toBe(true)
    expect(html).toContain('VCC')
  })

  it('marks the chip whose net has a dc-supply attached (the auto supply on VCC)', () => {
    const html = renderPanelWithBoard(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    // openBoardFromText auto-attaches the supply on VCC → its chip is "attached"
    const attached = html.match(/data-supply-attached="true"/g) ?? []
    expect(attached).toHaveLength(1)
  })

  it('offers a "Choose…" button to designate any net as a supply', () => {
    const html = renderPanelWithBoard(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    expect(html).toContain('data-testid="supply-choose"')
  })

  it('still offers "Choose…" when NO supply net was suggested (manual designation case)', () => {
    const html = renderPanelWithBoard(NO_RAIL_BOARD, 'no-rail.kicad_pcb')
    // nothing suggested → no chips …
    expect(html).not.toContain('data-testid="supply-chip"')
    // … but the manual picker is still there
    expect(html).toContain('data-testid="supply-choose"')
  })

  it('renders an "Attach schematic…" button when a board has no schematic (M3)', () => {
    const html = renderPanelWithBoard(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    expect(html).toContain('data-testid="attach-schematic-btn"')
    // no schematic attached yet → the panel says so, and the button invites one
    expect(html).toContain('No schematic')
    expect(html).toContain('Attach schematic…')
  })

  it('shows the attached schematic filename + a Replace label once one is attached (M3)', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    // Manually attach the schematic (the store primitive the M3 button drives).
    store.getState().setSchematicFromText(readFixture('fixture-555.kicad_sch'), 'led_lantern.kicad_sch')
    ;(store as unknown as { getServerState?: () => unknown }).getServerState = store.getState
    const html = renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <GroundSetup />
      </AppStoreProvider>,
    )
    expect(html).toContain('led_lantern.kicad_sch')
    // the button stays available to replace it
    expect(html).toContain('data-testid="attach-schematic-btn"')
    expect(html).toContain('Replace schematic…')
  })

  it('never renders a supply chip for the designated ground net (defense in depth)', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const gndId = store.getState().groundNetId!
    // Simulate a suggestion list that (wrongly) contains the ground net — e.g.
    // a ground named 0V matching the voltage-like supply pattern. The chip row
    // must exclude it regardless of how it got suggested.
    store.setState({ suggestedSupplyNetIds: [gndId, ...store.getState().suggestedSupplyNetIds] })
    ;(store as unknown as { getServerState?: () => unknown }).getServerState = store.getState
    const html = renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <GroundSetup />
      </AppStoreProvider>,
    )
    const chipLabels = [...html.matchAll(/<button[^>]*data-testid="supply-chip"[^>]*>([^<]*)<\/button>/g)]
      .map(m => m[1])
    expect(chipLabels.some(l => l.includes('GND'))).toBe(false)
    // sanity: the genuinely suggested rail chip still renders
    expect(chipLabels.some(l => l.includes('VIN'))).toBe(true)
  })
})
