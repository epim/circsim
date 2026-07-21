import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import BenchShelf from '../BenchShelf'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, AUTO_SUPPLY_ID, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')
function openedStore(): ReturnType<typeof createAppStore> {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.getState().openBoardFromText(
    readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'), 'fixture-rc.kicad_pcb')
  return store
}
function renderShelf(store: ReturnType<typeof createAppStore>): string {
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () => store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}><BenchShelf /></AppStoreProvider>)
}

describe('BenchShelf — panels mirror the store', () => {
  it('renders the shelf with a panel for the auto supply and the ground', () => {
    const html = renderShelf(openedStore())
    expect(html).toContain('data-testid="bench-shelf"')
    expect(html).toContain(`data-testid="jack-${AUTO_SUPPLY_ID}-net"`)
    expect(html).toContain('data-wired="true"')
    expect(html).toContain('data-testid="jack-ground-gnd"')
  })
  it('supply panel keeps the E2E contract: volts field + knob + auto note', () => {
    const html = renderShelf(openedStore())
    expect(html).toContain('data-testid="supply-volts-input"')
    expect(html).toContain('data-testid="supply-volts-knob"')
    expect(html).toContain('data-testid="auto-supply-note"')
  })
  it('the auto note disappears after a user edit (parity with the rack)', () => {
    const store = openedStore()
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().updateInstrument(AUTO_SUPPLY_ID, {
      kind: 'dc-supply', id: AUTO_SUPPLY_ID, netId: vinId, volts: 9, seriesOhms: 0.1 })
    expect(renderShelf(store)).not.toContain('data-testid="auto-supply-note"')
  })
  it('palette lists all six kinds', () => {
    const html = renderShelf(openedStore())
    expect(html).toContain('data-testid="add-instrument-btn"')
    for (const kind of ['dc-supply', 'function-gen', 'logic-input', 'voltage-probe', 'current-probe', 'potentiometer']) {
      expect(html).toContain(`data-testid="palette-${kind}"`)
    }
  })
  it('a palette-added pot renders two open jacks (rheostat)', () => {
    const store = openedStore()
    const id = store.getState().addBenchInstrument('potentiometer')
    const html = renderShelf(store)
    expect(html).toContain(`data-testid="jack-${id}-A"`)
    expect(html).toContain(`data-testid="jack-${id}-W"`)
    expect(html).not.toContain(`data-testid="jack-${id}-Lo"`)
    expect(html).toContain('data-wired="false"')
  })
  it('probe-this-net button survives the rack retirement (M7 F6)', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().selectNet(outId)
    const html = renderShelf(store)
    expect(html).toContain('data-testid="probe-net-btn"')
    expect(html).toContain('⌖')
  })
  it('no probe-net button without a selected net', () => {
    expect(renderShelf(openedStore())).not.toContain('data-testid="probe-net-btn"')
  })
})
