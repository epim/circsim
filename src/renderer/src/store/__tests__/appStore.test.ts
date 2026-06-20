/**
 * appStore.test.ts — Task 21
 *
 * Unit tests for the zustand store orchestration, using an INJECTED mock
 * simClient (no live MessagePort / Electron / ngspice).
 *
 * Covered:
 *   - open flow: fixture-rc text → parse → extract → resolve → store
 *       → 2 parts, both tier-2 resolved (status 'ok'), 0 unresolved
 *   - stubbing R2 (open) flips counts (1 ok / 1 stubbed) and sets deckDirty
 *   - resolution-summary counters
 *   - ground suggestion on load
 *   - viewer-only mode flag is unset for a healthy RC fixture
 *   - sim orchestration smoke: powerOn generates deck → loadCircuit + runOp
 *     are sent through the injected client; opResult applies net voltages
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore, resolutionSummary, parseAlterCommand, AUTO_SUPPLY_ID } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('appStore — open flow (fixture-rc)', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
  })

  it('loads fixture-rc text → 2 parts, both tier-2 resolved, 0 unresolved', () => {
    const text = readFixture('fixture-rc.kicad_pcb')
    store.getState().openBoardFromText(text, 'fixture-rc.kicad_pcb')

    const s = store.getState()
    expect(s.circuit).not.toBeNull()
    expect(s.circuit!.parts.length).toBe(2)

    const summary = resolutionSummary(s.resolutions)
    expect(summary.total).toBe(2)
    expect(summary.ok).toBe(2)
    expect(summary.stubbed).toBe(0)
    expect(summary.unresolved).toBe(0)

    // both R1 and R2 resolved tier 2 (primitive)
    for (const r of s.resolutions) {
      expect(r.tier).toBe(2)
      expect(r.status).toBe('ok')
    }
  })

  it('suggests GND as ground on load', () => {
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const s = store.getState()
    // GND net should be suggested as ground
    expect(s.groundNetId).not.toBeNull()
    const gndNet = s.circuit!.nets.find(n => n.id === s.groundNetId)
    expect(gndNet?.kicadName).toBe('GND')
  })

  it('designated ground net has spiceNode "0" (deck correctness)', () => {
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const s = store.getState()
    const gndNet = s.circuit!.nets.find(n => n.id === s.groundNetId)!
    expect(gndNet.spiceNode).toBe('0')
  })

  it('is NOT in viewer-only mode for a healthy RC fixture', () => {
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    expect(store.getState().viewerOnly).toBe(false)
    expect(store.getState().parseError).toBeNull()
  })

  it('starts clean (deckDirty false) right after load', () => {
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    expect(store.getState().deckDirty).toBe(false)
  })
})

describe('appStore — auto-attaches a DC supply on open (Spec §4 "60 seconds")', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
  })

  it('attaches a 5 V / 0.1 Ω dc-supply on the top suggested supply net (fixture-555 VCC)', () => {
    store.getState().openBoardFromText(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    const s = store.getState()

    // VCC is the suggested supply net; the supply must be attached there.
    const vcc = s.circuit!.nets.find(n => n.kicadName === 'VCC')!
    expect(s.suggestedSupplyNetIds).toContain(vcc.id)

    const supplies = s.instruments.filter(i => i.kind === 'dc-supply')
    expect(supplies).toHaveLength(1)
    const supply = supplies[0] as Extract<typeof supplies[number], { kind: 'dc-supply' }>
    expect(supply.id).toBe(AUTO_SUPPLY_ID)
    expect(supply.netId).toBe(vcc.id)
    expect(supply.volts).toBe(5)
    expect(supply.seriesOhms).toBe(0.1)

    // The auto-attached supply is NOT on the ground net.
    expect(supply.netId).not.toBe(s.groundNetId)
  })

  it('does NOT auto-attach a supply when no supply net is suggested (no rail-named net)', () => {
    // A board whose nets are all signal/ground names (IN / OUT / GND) — none match
    // the supply heuristics — so nothing is suggested and nothing auto-attaches.
    // (fixture-rc's "VIN" is now correctly recognised as an input rail, so it no
    // longer fits this case.)
    const noRailBoard = `(kicad_pcb (version 20221018) (generator pcbnew)
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
    store.getState().openBoardFromText(noRailBoard, 'no-rail.kicad_pcb')
    const s = store.getState()
    expect(s.suggestedSupplyNetIds).toEqual([])
    expect(s.instruments.filter(i => i.kind === 'dc-supply')).toHaveLength(0)
  })

  it('re-opening a board replaces the auto supply (no accumulation)', () => {
    store.getState().openBoardFromText(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    expect(store.getState().instruments.filter(i => i.kind === 'dc-supply')).toHaveLength(1)
    store.getState().openBoardFromText(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    expect(store.getState().instruments.filter(i => i.kind === 'dc-supply')).toHaveLength(1)
  })
})

describe('appStore — Model Doctor stub action flips counts + sets deckDirty', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
  })

  it('stubbing R2 open → 1 ok / 1 stubbed, deckDirty set', () => {
    // sanity: before stubbing
    let summary = resolutionSummary(store.getState().resolutions)
    expect(summary.ok).toBe(2)
    expect(summary.stubbed).toBe(0)
    expect(store.getState().deckDirty).toBe(false)

    store.getState().stubPart('R2', 'open')

    summary = resolutionSummary(store.getState().resolutions)
    expect(summary.ok).toBe(1)
    expect(summary.stubbed).toBe(1)
    expect(summary.unresolved).toBe(0)

    const r2 = store.getState().resolutions.find(r => r.ref === 'R2')!
    expect(r2.status).toBe('stubbed')
    expect(r2.model).toEqual({ kind: 'stub', mode: 'open' })
    expect(r2.tier).toBe(6)

    // R1 untouched
    const r1 = store.getState().resolutions.find(r => r.ref === 'R1')!
    expect(r1.status).toBe('ok')

    expect(store.getState().deckDirty).toBe(true)
  })

  it('stubbing then clearing the override restores tier-2 resolution', () => {
    store.getState().stubPart('R2', 'open')
    expect(resolutionSummary(store.getState().resolutions).stubbed).toBe(1)

    store.getState().clearPartOverride('R2')
    const summary = resolutionSummary(store.getState().resolutions)
    expect(summary.ok).toBe(2)
    expect(summary.stubbed).toBe(0)
  })

  it('stub short produces a short-mode stub', () => {
    store.getState().stubPart('R1', 'short')
    const r1 = store.getState().resolutions.find(r => r.ref === 'R1')!
    expect(r1.model).toEqual({ kind: 'stub', mode: 'short' })
  })
})

describe('appStore — pin-map edit re-resolves and sets deckDirty', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
  })

  it('setPinMap stores override + marks deckDirty', () => {
    store.getState().setPinMap('R1', { '1': '1', '2': '2' })
    expect(store.getState().pinMapOverrides.get('R1')).toEqual({ '1': '1', '2': '2' })
    expect(store.getState().deckDirty).toBe(true)
  })
})

describe('appStore — sim orchestration with mock simClient', () => {
  let store: ReturnType<typeof createAppStore>
  let mock: ReturnType<typeof createMockSimClient>

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    // attach a 5V supply on VIN so the op produces a meaningful result
    const vin = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!
    store.getState().addInstrument({
      kind: 'dc-supply',
      id: 'psu1',
      netId: vin.id,
      volts: 5,
      seriesOhms: 0.1,
    })
  })

  it('powerOn sends loadCircuit then runOp through the client', async () => {
    const p = store.getState().powerOn()

    // a deck (non-empty) was loaded, followed by an op command
    const load = mock.sent.find(c => c.type === 'loadCircuit')
    expect(load).toBeDefined()
    expect((load as { deckLines: string[] }).deckLines.length).toBeGreaterThan(0)
    expect(mock.sent.some(c => c.type === 'runOp')).toBe(true)

    // emit an opResult and let powerOn resolve
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p

    // op annotation voltages stored, keyed by netId
    const s = store.getState()
    expect(s.opVoltages).not.toBeNull()
    const vinNet = s.circuit!.nets.find(n => n.kicadName === 'VIN')!
    const outNet = s.circuit!.nets.find(n => n.kicadName === 'OUT')!
    expect(s.opVoltages!.get(vinNet.id)).toBeCloseTo(5, 5)
    expect(s.opVoltages!.get(outNet.id)).toBeCloseTo(2.5, 5)
  })

  it('powerOn clears deckDirty after a successful (re)load', async () => {
    store.getState().stubPart('R1', 'open') // sets deckDirty
    expect(store.getState().deckDirty).toBe(true)
    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
    expect(store.getState().deckDirty).toBe(false)
  })

  it('powerOn is a guided no-op without a ground designated', async () => {
    store.getState().setGround(null)
    mock.clearSent()
    const result = await store.getState().powerOn()
    expect(result).toBeNull()
    expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(false)
  })
})

describe('appStore — alter routing (alter-safe vs reload)', () => {
  let store: ReturnType<typeof createAppStore>
  let mock: ReturnType<typeof createMockSimClient>
  let vinId: number

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
  })

  it('dc-supply volts change while running sends a live alter (no reload)', async () => {
    // get into a running-ish state with a clean deck
    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
    // simulate the running state SimHost would report
    mock.emit({ type: 'status', running: true, simTimeSeconds: 0, realtimeFactor: 1 })
    expect(store.getState().simState).toBe('running')
    mock.clearSent()

    store.getState().updateInstrument('psu1', {
      kind: 'dc-supply',
      id: 'psu1',
      netId: vinId,
      volts: 9,
      seriesOhms: 0.1,
    })

    const alter = mock.sent.find(c => c.type === 'alter')
    expect(alter).toBeDefined()
    // device name derives from the instrument id ("psu1" → "vpsu_psu1")
    expect((alter as { device: string }).device).toContain('vpsu_psu1')
    // an alter does NOT dirty the deck
    expect(store.getState().deckDirty).toBe(false)
  })

  it('function-gen wave-type change requires a reload (deckDirty)', () => {
    store.getState().addInstrument({
      kind: 'function-gen',
      id: 'fg1',
      netId: vinId,
      wave: 'sine',
      freqHz: 1000,
      amplitudeV: 1,
      offsetV: 0,
      outputOhms: 50,
    })
    // mark clean to observe the dirty flip
    const p = store.getState().powerOn()
    void p
    store.getState().updateInstrument('fg1', {
      kind: 'function-gen',
      id: 'fg1',
      netId: vinId,
      wave: 'pulse',
      freqHz: 1000,
      amplitudeV: 1,
      offsetV: 0,
      outputOhms: 50,
    })
    expect(store.getState().deckDirty).toBe(true)
  })
})

describe('parseAlterCommand', () => {
  it('parses a scalar alter', () => {
    expect(parseAlterCommand('alter @vpsu_1[dc] 9')).toEqual({
      type: 'alter',
      device: '@vpsu_1[dc]',
      value: '9',
    })
  })

  it('parses a vector (SIN) alter, stripping the brackets', () => {
    expect(parseAlterCommand('alter @vfgen_2[sin] [ 0 1 1000 ]')).toEqual({
      type: 'alter',
      device: '@vfgen_2[sin]',
      value: '0 1 1000',
    })
  })

  it('returns null for a non-alter string', () => {
    expect(parseAlterCommand('op')).toBeNull()
  })
})
