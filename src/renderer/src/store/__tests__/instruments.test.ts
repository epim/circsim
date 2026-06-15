/**
 * instruments.test.ts — Task 22
 *
 * Store-level unit tests for:
 *   - instrument attach/detach with netId routing
 *   - ground setup: confirm via setGround → Run enables
 *   - alter-vs-reload routing through updateInstrument
 *   - MCU interactive-pins stub create + per-pin state
 *   - GroundSetup: suggestedSupplyNetIds populated on load
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

// ── Ground setup ──────────────────────────────────────────────────────────────

describe('Task22 — GroundSetup: ground suggestion on load', () => {
  it('suggestGround heuristic auto-selects GND on fixture-rc', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const s = store.getState()
    expect(s.groundNetId).not.toBeNull()
    const gnd = s.circuit!.nets.find(n => n.id === s.groundNetId)
    expect(gnd?.kicadName).toBe('GND')
  })

  it('suggestedSupplyNetIds is an array (may be empty for fixture-rc VIN)', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const s = store.getState()
    // suggestedSupplyNetIds is always an array (could be empty if no standard supply name)
    expect(Array.isArray(s.suggestedSupplyNetIds)).toBe(true)
    // fixture-rc nets: VIN, OUT, GND — VIN doesn't match standard supply heuristics
    // so this can be 0; that is the correct behavior
  })

  it('setGround(null) clears ground (Run disabled)', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    store.getState().setGround(null)
    expect(store.getState().groundNetId).toBeNull()
  })

  it('setGround(id) switches ground to a different net', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const vinNet = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!
    store.getState().setGround(vinNet.id)
    expect(store.getState().groundNetId).toBe(vinNet.id)
    // the designated net must now have spiceNode "0"
    const vinNetAfter = store.getState().circuit!.nets.find(n => n.id === vinNet.id)!
    expect(vinNetAfter.spiceNode).toBe('0')
  })

  it('powerOn returns null (no-op) when groundNetId is null', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    store.getState().setGround(null)
    mock.clearSent()
    const result = await store.getState().powerOn()
    expect(result).toBeNull()
    expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(false)
  })
})

// ── Instrument attach / detach ─────────────────────────────────────────────────

describe('Task22 — addInstrument / removeInstrument', () => {
  let store: ReturnType<typeof createAppStore>
  let vinId: number
  let outId: number

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
  })

  it('addInstrument dc-supply → appears in instruments, deckDirty = true', () => {
    store.getState().addInstrument({
      kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1,
    })
    const s = store.getState()
    expect(s.instruments.length).toBe(1)
    expect(s.instruments[0]).toMatchObject({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5 })
    expect(s.deckDirty).toBe(true)
  })

  it('addInstrument voltage-probe → appears in instruments', () => {
    store.getState().addInstrument({
      kind: 'voltage-probe', id: 'vp1', netId: outId, color: '#0f0',
    })
    expect(store.getState().instruments.length).toBe(1)
    expect(store.getState().instruments[0].kind).toBe('voltage-probe')
  })

  it('removeInstrument removes by id', () => {
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp1', netId: outId, color: '#f00' })
    expect(store.getState().instruments.length).toBe(2)

    store.getState().removeInstrument('psu1')
    expect(store.getState().instruments.length).toBe(1)
    expect(store.getState().instruments[0]).toMatchObject({ kind: 'voltage-probe', id: 'vp1' })
    expect(store.getState().deckDirty).toBe(true)
  })

  it('addInstrument ground-ref → accessible by kind', () => {
    const gndId = store.getState().groundNetId!
    store.getState().addInstrument({ kind: 'ground-ref', netId: gndId })
    const groundInst = store.getState().instruments.find(i => i.kind === 'ground-ref')
    expect(groundInst).toBeDefined()
    expect((groundInst as { netId: number }).netId).toBe(gndId)
  })

  it('addInstrument function-gen → appears in instruments with correct shape', () => {
    store.getState().addInstrument({
      kind: 'function-gen', id: 'fg1', netId: vinId,
      wave: 'sine', freqHz: 1000, amplitudeV: 2, offsetV: 0, outputOhms: 50,
    })
    const fg = store.getState().instruments.find(i => i.kind === 'function-gen')
    expect(fg).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((fg as any).freqHz).toBe(1000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((fg as any).wave).toBe('sine')
  })

  it('addInstrument logic-input → correct level stored', () => {
    store.getState().addInstrument({ kind: 'logic-input', id: 'li1', netId: vinId, level: 1, vHigh: 3.3 })
    const li = store.getState().instruments.find(i => i.kind === 'logic-input')
    expect(li).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((li as any).level).toBe(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((li as any).vHigh).toBe(3.3)
  })
})

// ── alter-safe vs reload-required routing ─────────────────────────────────────

describe('Task22 — updateInstrument alter-vs-reload routing', () => {
  let store: ReturnType<typeof createAppStore>
  let mock: ReturnType<typeof createMockSimClient>
  let vinId: number

  beforeEach(async () => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
    // Bring to running state
    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
    mock.emit({ type: 'status', running: true, simTimeSeconds: 0, realtimeFactor: 1 })
    mock.clearSent()
  })

  it('dc-supply volts change while running → sends live alter, no deckDirty', () => {
    store.getState().updateInstrument('psu1', {
      kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 9, seriesOhms: 0.1,
    })
    const alter = mock.sent.find(c => c.type === 'alter')
    expect(alter).toBeDefined()
    expect((alter as { device: string }).device).toMatch(/vpsu_psu1/)
    expect(store.getState().deckDirty).toBe(false)
  })

  it('logic-input level change while running + clean deck → sends live alter', async () => {
    // Add the logic-input first, then reload to clear deckDirty
    store.getState().addInstrument({ kind: 'logic-input', id: 'li1', netId: vinId, level: 0, vHigh: 5 })
    // Re-run powerOn to load the deck with the logic-input (clears deckDirty)
    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
    // Now simulate running
    mock.emit({ type: 'status', running: true, simTimeSeconds: 1, realtimeFactor: 1 })
    mock.clearSent()

    store.getState().updateInstrument('li1', { kind: 'logic-input', id: 'li1', netId: vinId, level: 1, vHigh: 5 })
    const alter = mock.sent.find(c => c.type === 'alter')
    expect(alter).toBeDefined()
    expect((alter as { device: string }).device).toMatch(/vlogic_li1/)
  })

  it('function-gen wave type change → deckDirty (reload-required)', () => {
    store.getState().addInstrument({
      kind: 'function-gen', id: 'fg1', netId: vinId,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    })
    mock.clearSent()
    store.getState().updateInstrument('fg1', {
      kind: 'function-gen', id: 'fg1', netId: vinId,
      wave: 'pulse', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    })
    expect(store.getState().deckDirty).toBe(true)
    expect(mock.sent.some(c => c.type === 'alter')).toBe(false)
  })

  it('function-gen freq change while running + clean deck → sends live alter (SIN vector form)', async () => {
    store.getState().addInstrument({
      kind: 'function-gen', id: 'fg2', netId: vinId,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    })
    // Re-run powerOn to load the deck with the function-gen (clears deckDirty)
    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
    mock.emit({ type: 'status', running: true, simTimeSeconds: 2, realtimeFactor: 1 })
    mock.clearSent()

    store.getState().updateInstrument('fg2', {
      kind: 'function-gen', id: 'fg2', netId: vinId,
      wave: 'sine', freqHz: 2000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    })
    const alter = mock.sent.find(c => c.type === 'alter')
    expect(alter).toBeDefined()
    const dev = (alter as { device: string }).device
    // device should reference the sin form
    expect(dev).toMatch(/vfgen_fg2.*sin/)
  })
})

// ── MCU interactive-pins stub ─────────────────────────────────────────────────

describe('Task22 — MCU interactive-pins instrument', () => {
  it('stubbing a part as interactive-pins + adding per-pin logic-inputs', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')

    // Stub R1 as interactive-pins (simulates an MCU stub workflow)
    store.getState().stubPart('R1', 'interactive-pins')
    const r1res = store.getState().resolutions.find(r => r.ref === 'R1')!
    expect(r1res.model).toMatchObject({ kind: 'stub', mode: 'interactive-pins' })

    // Now add a logic-input for one of R1's pads
    const r1 = store.getState().circuit!.parts.find(p => p.ref === 'R1')!
    const pad1NetId = r1.padNet.get('1')!
    store.getState().addInstrument({ kind: 'logic-input', id: 'r1p1', netId: pad1NetId, level: 0, vHigh: 3.3 })

    const li = store.getState().instruments.find(i => i.kind === 'logic-input')
    expect(li).toBeDefined()
    expect((li as { netId: number }).netId).toBe(pad1NetId)
    // Toggle to Hi
    store.getState().updateInstrument('r1p1', { kind: 'logic-input', id: 'r1p1', netId: pad1NetId, level: 1, vHigh: 3.3 })
    const updated = store.getState().instruments.find(i => 'id' in i && i.id === 'r1p1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((updated as any).level).toBe(1)
  })
})

// ── Multiple instruments + deck generation ────────────────────────────────────

describe('Task22 — multiple instruments produce valid deck via powerOn', () => {
  it('deck contains both dc-supply and voltage-probe save entries', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp1', netId: outId, color: '#0f0' })

    const p = store.getState().powerOn()
    const loadCmd = mock.sent.find(c => c.type === 'loadCircuit') as { deckLines: string[] }
    expect(loadCmd).toBeDefined()
    const deck = loadCmd.deckLines
    // Supply element present
    expect(deck.some(l => l.includes('vpsu_psu1'))).toBe(true)
    // .save all present
    expect(deck.some(l => l.startsWith('.save all'))).toBe(true)
    // ends with .end
    expect(deck[deck.length - 1]).toBe('.end')

    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
  })
})
