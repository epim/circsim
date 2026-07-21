/**
 * benchLeads.test.ts — Task 3 (Bench Leads: store wiring + wired-only sim)
 *
 * Covered:
 *   - addBenchInstrument: creates an UNWIRED instrument on the shelf, selects
 *     it, returns its id; voltage-probe gets a color from the shared allocator
 *   - assignTerminal: table-driven net-terminal wiring per bench kind, pot
 *     A/W (rheostat), current-probe clamp (component ref), ground routed
 *     through setGround
 *   - detachTerminalWire: unwires a terminal back to UNWIRED
 *   - wired-only simulation: powerOn refuses to solve when the only source is
 *     an UNWIRED shelf instrument; wiring it first lets the solve land
 *   - assignTerminal net rewire while running/paused marks the deck dirty
 *     (regression for alterPlan misclassifying a net rewire as alter-safe)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore } from '../appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'
import { UNWIRED } from '../../../../core/spicegen/instruments'
import { GROUND_INST_ID } from '../../bench/leads'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function openedStore(): { store: ReturnType<typeof createAppStore>; mock: MockSimClient } {
  const mock = createMockSimClient()
  const store = createAppStore({ simClient: mock })
  store.getState().openBoardFromText(
    readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
    'fixture-rc.kicad_pcb',
  )
  return { store, mock }
}

describe('addBenchInstrument', () => {
  it('creates an unwired instrument, selects it, returns the id', () => {
    const { store } = openedStore()
    const id = store.getState().addBenchInstrument('potentiometer')
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)
    expect(inst).toMatchObject({ kind: 'potentiometer', mode: 'rheostat', netA: UNWIRED, netW: UNWIRED })
    expect(store.getState().selectedInstrumentId).toBe(id)
  })
  it('voltage probes get a color from the shared allocator', () => {
    const { store } = openedStore()
    const id = store.getState().addBenchInstrument('voltage-probe')
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)
    expect(inst).toMatchObject({ kind: 'voltage-probe', netId: UNWIRED })
    expect((inst as { color: string }).color).toMatch(/^#/)
  })
})

describe('assignTerminal', () => {
  it('wires a net terminal (table-driven per kind)', () => {
    const { store } = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    const cases = [
      ['dc-supply', 'net', 'netId'],
      ['function-gen', 'net', 'netId'],
      ['logic-input', 'net', 'netId'],
      ['voltage-probe', 'net', 'netId'],
    ] as const
    for (const [kind, terminal, field] of cases) {
      const id = store.getState().addBenchInstrument(kind)
      store.getState().assignTerminal(id, terminal, { kind: 'net', netId: outId })
      const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
      expect((inst as Record<string, unknown>)[field]).toBe(outId)
    }
  })
  it('pot A/W wire netA/netW in rheostat mode', () => {
    const { store } = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    const id = store.getState().addBenchInstrument('potentiometer')
    store.getState().assignTerminal(id, 'A', { kind: 'net', netId: outId })
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
    expect(inst).toMatchObject({ netA: outId, netW: UNWIRED })
  })
  it('current-probe clamp wires the ref', () => {
    const { store } = openedStore()
    const id = store.getState().addBenchInstrument('current-probe')
    store.getState().assignTerminal(id, 'clamp', { kind: 'component', ref: 'R1' })
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
    expect(inst).toMatchObject({ ref: 'R1' })
  })
  it('ground routes through setGround', () => {
    const { store } = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().assignTerminal(GROUND_INST_ID, 'gnd', { kind: 'net', netId: outId })
    expect(store.getState().groundNetId).toBe(outId)
  })
  it('detachTerminalWire unwires', () => {
    const { store } = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    const id = store.getState().addBenchInstrument('voltage-probe')
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: outId })
    store.getState().detachTerminalWire(id, 'net')
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
    expect(inst).toMatchObject({ netId: UNWIRED })
  })
})

describe('wired-only simulation', () => {
  it('powerOn refuses when the only source is unwired', async () => {
    const { store } = openedStore()
    // Drop the auto-attached supply, then add an UNWIRED one from the palette.
    for (const inst of [...store.getState().instruments]) {
      if (inst.kind === 'dc-supply' && 'id' in inst) store.getState().removeInstrument(inst.id)
    }
    store.getState().addBenchInstrument('dc-supply')
    // The unwired-only guard short-circuits before anything is sent to SimHost
    // — no opResult to emit, powerOn resolves synchronously with null.
    const result = await store.getState().powerOn()
    expect(result).toBeNull()
    expect(store.getState().opVoltages).toBeNull()
  })
  it('wiring the supply then powering on solves', async () => {
    const { store, mock } = openedStore()
    for (const inst of [...store.getState().instruments]) {
      if (inst.kind === 'dc-supply' && 'id' in inst) store.getState().removeInstrument(inst.id)
    }
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    const id = store.getState().addBenchInstrument('dc-supply')
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: vinId })
    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    const result = await p
    expect(result).not.toBeNull()
  })
})

describe('assignTerminal — net rewire mid-run must reload, not silently alter', () => {
  // Regression for the alterPlan defect: dc-supply/logic-input/function-gen/
  // voltage-probe branches never compared netId, so a REWIRE (a topology
  // change) was misclassified as {kind:'alter'} (a value-only tweak). Under
  // updateInstrument, an 'alter' plan while simState is 'running'/'paused'
  // sends nothing for netId (there's no alter command for "move this source
  // to a different node") and never calls markDeckDirty — the loaded ngspice
  // deck keeps driving the OLD net while the store records the NEW one.
  // The fix: a netId change on any of these four kinds must plan 'reload',
  // which routes through markDeckDirty() → deckDirty: true.
  it('rewiring a wired dc-supply while running marks the deck dirty (no live alter)', () => {
    const { store, mock } = openedStore()
    // Drop the auto-attached supply so the test controls wiring precisely.
    for (const inst of [...store.getState().instruments]) {
      if (inst.kind === 'dc-supply' && 'id' in inst) store.getState().removeInstrument(inst.id)
    }
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    const id = store.getState().addBenchInstrument('dc-supply')
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: vinId })

    // Drive the store into a running transient (mirrors orchestration.test.ts's
    // "supply knob-drag while running" setup).
    store.getState().run()
    mock.emit({ type: 'status', running: true, simTimeSeconds: 0, realtimeFactor: 1 })
    expect(store.getState().simState).toBe('running')
    expect(store.getState().deckDirty).toBe(false)
    mock.clearSent()

    // Rewire the SAME supply from VIN to OUT mid-run.
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: outId })

    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
    expect((inst as { netId: number }).netId).toBe(outId)
    // Must be flagged dirty so the next run()/resume reloads with the new
    // topology — must NOT be treated as a live-alterable value change.
    expect(store.getState().deckDirty).toBe(true)
    expect(mock.sent.some(c => c.type === 'alter')).toBe(false)
  })

  it('rewiring a wired voltage-probe while paused marks the deck dirty (no live alter)', () => {
    const { store, mock } = openedStore()
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    const id = store.getState().addBenchInstrument('voltage-probe')
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: vinId })

    store.getState().run()
    mock.emit({ type: 'status', running: true, simTimeSeconds: 0, realtimeFactor: 1 })
    store.getState().pause()
    expect(store.getState().simState).toBe('paused')
    expect(store.getState().deckDirty).toBe(false)
    mock.clearSent()

    // Rewire the probe from VIN to OUT while paused.
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: outId })

    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
    expect((inst as { netId: number }).netId).toBe(outId)
    expect(store.getState().deckDirty).toBe(true)
    expect(mock.sent.some(c => c.type === 'alter')).toBe(false)
  })
})
