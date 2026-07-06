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
import { createAppStore, AUTO_SUPPLY_ID } from '../appStore'
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
    // fixture-rc's VIN is now recognised as a supply, so a default supply
    // auto-attaches on open. Clear instruments so these add/remove count tests
    // start from an empty rack.
    for (const inst of [...store.getState().instruments]) {
      if ('id' in inst) store.getState().removeInstrument(inst.id)
    }
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

// ── Milestone 2: attachSupplyToNet (click-to-attach supply chips) ─────────────

describe('Milestone2 — attachSupplyToNet', () => {
  // Board whose nets carry NO rail-like names (IN / OUT / GND): nothing is
  // suggested and no supply auto-attaches — the manual-designation case.
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

  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
  })

  it('attaching to a fresh net creates a 5 V / 0.1 Ω dc-supply on it and selects it', () => {
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().attachSupplyToNet(outId)

    const s = store.getState()
    const supplies = s.instruments.filter(
      i => i.kind === 'dc-supply' && i.netId === outId,
    ) as Extract<(typeof s.instruments)[number], { kind: 'dc-supply' }>[]
    expect(supplies).toHaveLength(1)
    expect(supplies[0].volts).toBe(5)
    expect(supplies[0].seriesOhms).toBe(0.1)
    expect(s.selectedInstrumentId).toBe(supplies[0].id)
    expect(s.deckDirty).toBe(true)
  })

  it('attaching twice to the same net does not duplicate — it re-selects the existing supply', () => {
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().attachSupplyToNet(outId)
    const firstId = store.getState().selectedInstrumentId
    expect(firstId).not.toBeNull()

    // deselect, then attach again
    store.getState().selectInstrument(null)
    store.getState().attachSupplyToNet(outId)

    const s = store.getState()
    expect(s.instruments.filter(i => i.kind === 'dc-supply' && i.netId === outId)).toHaveLength(1)
    expect(s.selectedInstrumentId).toBe(firstId)
  })

  it('attaching to the net that already has the auto supply just selects it (no new instrument)', () => {
    // fixture-rc: VIN is recognised as a supply → the auto supply sits there.
    const s0 = store.getState()
    const vinId = s0.circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    expect(s0.instruments.filter(i => i.kind === 'dc-supply')).toHaveLength(1)

    store.getState().selectInstrument(null)
    store.getState().attachSupplyToNet(vinId)

    const s = store.getState()
    expect(s.instruments.filter(i => i.kind === 'dc-supply')).toHaveLength(1)
    expect(s.selectedInstrumentId).toBe(AUTO_SUPPLY_ID)
  })

  it('attachSupplyToNet on the designated ground net is a no-op (no instrument added, selection unchanged)', () => {
    const s0 = store.getState()
    const gndId = s0.groundNetId!
    const instrumentsBefore = s0.instruments
    const selectedBefore = s0.selectedInstrumentId

    store.getState().attachSupplyToNet(gndId)

    const s = store.getState()
    // No supply may land on SPICE node 0 — nothing added, nothing re-selected.
    expect(s.instruments).toEqual(instrumentsBefore)
    expect(
      s.instruments.some(i => i.kind === 'dc-supply' && (i as { netId: number }).netId === gndId),
    ).toBe(false)
    expect(s.selectedInstrumentId).toBe(selectedBefore)
  })

  it('works when no auto supply was attached (the no-suggestions board case)', () => {
    store.getState().openBoardFromText(noRailBoard, 'no-rail.kicad_pcb')
    const s0 = store.getState()
    expect(s0.suggestedSupplyNetIds).toEqual([])
    expect(s0.instruments.filter(i => i.kind === 'dc-supply')).toHaveLength(0)

    const inId = s0.circuit!.nets.find(n => n.kicadName === 'IN')!.id
    store.getState().attachSupplyToNet(inId)

    const s = store.getState()
    const supplies = s.instruments.filter(
      i => i.kind === 'dc-supply' && i.netId === inId,
    ) as Extract<(typeof s.instruments)[number], { kind: 'dc-supply' }>[]
    expect(supplies).toHaveLength(1)
    expect(supplies[0].volts).toBe(5)
    expect(supplies[0].seriesOhms).toBe(0.1)
    expect(s.selectedInstrumentId).toBe(supplies[0].id)
  })

  it('openBoardFromText selects the auto-attached supply; removeInstrument clears the selection', () => {
    // the auto supply is selected right after open (rack shows its props)
    expect(store.getState().selectedInstrumentId).toBe(AUTO_SUPPLY_ID)

    store.getState().removeInstrument(AUTO_SUPPLY_ID)
    expect(store.getState().selectedInstrumentId).toBeNull()
  })

  it('selectInstrument sets and clears the selection', () => {
    store.getState().selectInstrument('some-id')
    expect(store.getState().selectedInstrumentId).toBe('some-id')
    store.getState().selectInstrument(null)
    expect(store.getState().selectedInstrumentId).toBeNull()
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
