/**
 * NetVoltages.test.tsx — M7 (F8)
 *
 * The compact per-net voltage readout: one row per net with an op result
 * (name + formatVolts), natural-sorted by net name, with a text filter.
 * Clicking a row selects the net (store.selectNet — covered by the row's
 * onClick wiring; the pure row-building logic is tested directly here).
 * Static render against a real store (the GroundSetup/ModelDoctor pattern).
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import NetVoltages, { buildNetVoltageRows } from '../NetVoltages'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { CircuitNet } from '../../../../core/netlist/extract'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

function net(id: number, name: string): CircuitNet {
  return { id, kicadName: name, spiceNode: String(id), padRefs: [] }
}

describe('buildNetVoltageRows — pure row model (M7 F8)', () => {
  it('returns one row per net with an op result, natural-sorted by name', () => {
    const nets = [net(1, 'NET10'), net(2, 'NET2'), net(3, 'NET1')]
    const rows = buildNetVoltageRows(nets, new Map([[1, 3.3], [2, 5], [3, 0]]), '')
    expect(rows.map(r => r.name)).toEqual(['NET1', 'NET2', 'NET10'])
    expect(rows.find(r => r.name === 'NET2')?.volts).toBe(5)
  })

  it('skips nets without an op entry and unnamed nets', () => {
    const nets = [net(1, 'VCC'), net(2, 'FLOATY'), net(3, '')]
    const rows = buildNetVoltageRows(nets, new Map([[1, 5], [3, 1]]), '')
    expect(rows.map(r => r.name)).toEqual(['VCC'])
  })

  it('filters case-insensitively on the net name', () => {
    const nets = [net(1, '/PACK+'), net(2, 'VCC'), net(3, '/VDD_CH')]
    const volts = new Map([[1, 4.2], [2, 5], [3, 3.3]])
    expect(buildNetVoltageRows(nets, volts, 'pack').map(r => r.name)).toEqual(['/PACK+'])
    // '/'-prefixed (hierarchical) names sort ahead of bare names — deterministic
    // grouping, like a file listing.
    expect(buildNetVoltageRows(nets, volts, 'V').map(r => r.name)).toEqual(['/VDD_CH', 'VCC'])
  })

  it('no op result → no rows', () => {
    expect(buildNetVoltageRows([net(1, 'VCC')], null, '')).toEqual([])
  })
})

describe('NetVoltages panel — static render (M7 F8)', () => {
  function renderPanel(withOp: boolean): string {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    if (withOp) {
      const nets = store.getState().circuit!.nets
      const vin = nets.find(n => n.kicadName === 'VIN')!.id
      const out = nets.find(n => n.kicadName === 'OUT')!.id
      store.setState({ opVoltages: new Map([[vin, 5], [out, -0.0000001]]) })
    }
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    return renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <NetVoltages />
      </AppStoreProvider>,
    )
  }

  it('renders a filter box and one row per net with a formatted voltage', () => {
    const html = renderPanel(true)
    expect(html).toContain('data-testid="net-voltages-filter"')
    const rows = [...html.matchAll(/data-testid="net-voltage-row"/g)]
    expect(rows).toHaveLength(2)
    // Rows are addressable by net name for tooling/tests.
    expect(html).toContain('data-net-name="VIN"')
    expect(html).toContain('data-net-name="OUT"')
    // Shared formatter: 3 decimals, and -0.000 is normalized to 0.000 (F5).
    expect(html).toContain('5.000 V')
    expect(html).toContain('0.000 V')
    expect(html).not.toContain('-0.000 V')
  })

  it('before any op result → a guiding empty state, no rows', () => {
    const html = renderPanel(false)
    expect(html).not.toContain('data-testid="net-voltage-row"')
    expect(html).toMatch(/Power On/i)
  })
})

// ── M7 review fixes: honesty surfaces + degenerate op ─────────────────────────

describe('NetVoltages panel — caveat / staleness / degenerate op (M7 review)', () => {
  function makeStore(): ReturnType<typeof createAppStore> {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    return store
  }

  function render(store: ReturnType<typeof createAppStore>): string {
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    return renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <NetVoltages />
      </AppStoreProvider>,
    )
  }

  function withOp(store: ReturnType<typeof createAppStore>): void {
    const vin = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.setState({ opVoltages: new Map([[vin, 5]]) })
  }

  it('renders the fallback caveat line when opCaveat is set', () => {
    const store = makeStore()
    withOp(store)
    store.setState({ opCaveat: { method: 'gmin', at: Date.now() } })
    const html = render(store)
    expect(html).toContain('data-testid="net-voltages-caveat"')
    expect(html).toMatch(/gmin stepping/)
    expect(html).toMatch(/0\.000 V/) // the "may be unreliable" wording
  })

  it('no caveat → no caveat line', () => {
    const store = makeStore()
    withOp(store)
    expect(render(store)).not.toContain('data-testid="net-voltages-caveat"')
  })

  it('while a re-solve is in flight, retained voltages are flagged stale (note + dimmed rows)', () => {
    const store = makeStore()
    withOp(store)
    store.setState({ opVoltagesStale: true })
    const html = render(store)
    expect(html).toContain('data-testid="net-voltages-stale"')
    expect(html).toMatch(/previous run/i)
    // The value rows render dimmed while stale.
    expect(html).toMatch(/data-testid="net-voltage-row"[^>]*style="[^"]*opacity/)
  })

  it('fresh voltages are not flagged and not dimmed', () => {
    const store = makeStore()
    withOp(store)
    const html = render(store)
    expect(html).not.toContain('data-testid="net-voltages-stale"')
    expect(html).not.toMatch(/data-testid="net-voltage-row"[^>]*style="[^"]*opacity/)
  })

  it('an op that ran but mapped zero nets says so — not "no operating point yet"', () => {
    const store = makeStore()
    store.setState({ opVoltages: new Map() })
    const html = render(store)
    expect(html).toMatch(/returned no net voltages/i)
    expect(html).not.toMatch(/No operating point yet/i)
  })
})
