/**
 * InstrumentRack.test.tsx — M7 (F6 + F7)
 *
 * Renders the rack against a REAL store (mock simClient) with react-dom/server
 * — the GroundSetup/ModelDoctor pattern (node test env, no jsdom; effects
 * don't run, so the store selection set by openBoardFromText drives what the
 * static render shows). Verifies:
 *   - the instrument chip row wraps (no clipping at narrow dock widths — F6.1)
 *   - the click-to-probe affordance: a "Probe this net" button appears when a
 *     net is selected in the store, naming the net (F6.2)
 *   - the auto-attached supply's card carries the one-line announcement note,
 *     which disappears once the user edits the supply and never appears on a
 *     user-attached supply (F7.2)
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import InstrumentRack from '../InstrumentRack'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, AUTO_SUPPLY_ID, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

function openedStore(): ReturnType<typeof createAppStore> {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
  return store
}

function renderRack(store: ReturnType<typeof createAppStore>): string {
  // zustand v4 renders from getServerState ?? getInitialState under
  // react-dom/server; point the server snapshot at the live state.
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
    store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <InstrumentRack />
    </AppStoreProvider>,
  )
}

describe('M7 F6.1 — instrument chip row wraps (never clips)', () => {
  it('the chip palette row carries flex-wrap:wrap', () => {
    const html = renderRack(openedStore())
    // All five chips render …
    for (const label of ['PSU', 'FG', 'LI', 'VP', 'IP']) expect(html).toContain(label)
    // … in a wrapping flex row (regression guard for the clipped-rack finding).
    expect(html).toMatch(/flex-wrap:wrap/)
  })
})

describe('M7 F6.2 — click-to-probe from the selected net', () => {
  it('no net selected → no "Probe this net" button', () => {
    const store = openedStore()
    expect(store.getState().selectedNetId).toBeNull()
    const html = renderRack(store)
    expect(html).not.toContain('data-testid="probe-net-btn"')
  })

  it('a selected net shows its name + a "Probe this net" button', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().selectNet(outId)
    const html = renderRack(store)
    expect(html).toContain('data-testid="probe-net-btn"')
    expect(html).toContain('Probe this net')
    expect(html).toContain('OUT')
  })
})

describe('M7 F7.2 — auto-attached supply announcement', () => {
  it('the auto supply card carries the auto-attach note on open', () => {
    const store = openedStore()
    // openBoardFromText auto-selects the auto supply → its props card renders.
    expect(store.getState().selectedInstrumentId).toBe(AUTO_SUPPLY_ID)
    const html = renderRack(store)
    expect(html).toContain('data-testid="auto-supply-note"')
    expect(html).toContain('Auto-attached')
  })

  it('the note disappears once the user edits the supply', () => {
    const store = openedStore()
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().updateInstrument(AUTO_SUPPLY_ID, {
      kind: 'dc-supply', id: AUTO_SUPPLY_ID, netId: vinId, volts: 9, seriesOhms: 0.1,
    })
    const html = renderRack(store)
    expect(html).not.toContain('data-testid="auto-supply-note"')
  })

  it('a user-attached supply never carries the note', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().attachSupplyToNet(outId) // selects the new user supply
    expect(store.getState().selectedInstrumentId).not.toBe(AUTO_SUPPLY_ID)
    const html = renderRack(store)
    expect(html).not.toContain('data-testid="auto-supply-note"')
  })
})

// ─── Gemini finding 3: the probe button must read as actionable ───────────────

describe('Probe-this-net contrast (Gemini finding 3)', () => {
  it('is a solid high-contrast button with a probe-tip glyph', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().selectNet(outId)
    const html = renderRack(store)
    expect(html).toContain('data-testid="probe-net-btn"')
    // probe-tip glyph signals actionability
    expect(html).toContain('⌖')
    // solid resting background — no longer the near-invisible #1e2e1e
    expect(html).toContain('background:#2a6b3a')
    expect(html).not.toContain('background:#1e2e1e')
  })
})
