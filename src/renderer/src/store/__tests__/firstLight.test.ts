/**
 * firstLight.test.ts — First Light (L3)
 *
 * Unit tests for the store logic added for the "First Light" experience, driven
 * by an INJECTED mock simClient (no Electron / ngspice). The bundled
 * resources/sample/first-light.kicad_pcb (VIN → R1 → D1 → GND) is the live
 * fixture: a real one-LED dimmer.
 *
 * Covered:
 *   - buildCoachInput: LED anode(pad1)/cathode(pad2) nets, hasSupply, voltages
 *   - hasSupplyAttached: ground + ≥1 source predicate
 *   - energize(): auto-attaches a supply when none, runs the op, lights the LED
 *   - re-op-on-change while energized: nudging the supply re-solves; lowering the
 *     supply voltage reduces the LED current (dimmer)
 *   - coach notes populated after an op (no supply → "nothing is powering")
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createAppStore,
  buildCoachInput,
  hasSupplyAttached,
  type AppStore,
} from '../appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'
import type { Circuit } from '../../../../core/netlist/extract'

const sampleDir = join(__dirname, '../../../../../resources/sample')
const firstLight = readFileSync(join(sampleDir, 'first-light.kicad_pcb'), 'utf-8')

// ─── pure helpers ────────────────────────────────────────────────────────────────

/** A minimal synthetic circuit with one LED D1 (pad1→net10, pad2→net20). */
function makeLedCircuit(): Circuit {
  return {
    nets: [
      { id: 10, kicadName: 'LEDA', spiceNode: 'leda', padRefs: [] },
      { id: 20, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ],
    parts: [
      {
        ref: 'D1',
        value: 'LED',
        libId: 'LED_SMD:LED_0805_2012Metric',
        layer: 'F',
        padNet: new Map([['1', 10], ['2', 20]]),
        properties: {},
      },
      {
        ref: 'R1',
        value: '330',
        libId: 'Resistor_SMD:R_0805_2012Metric',
        layer: 'F',
        padNet: new Map([['1', 1], ['2', 10]]),
        properties: {},
      },
    ],
    warnings: [],
  }
}

describe('buildCoachInput', () => {
  it('reads each LED anode(pad1)/cathode(pad2) net; skips non-LED parts', () => {
    const input = buildCoachInput(makeLedCircuit(), new Map(), null, false)
    expect(input.leds).toEqual([{ ref: 'D1', anodeNet: 10, cathodeNet: 20 }])
    expect(input.hasSupply).toBe(false)
    expect(input.netVoltages).toBeUndefined()
  })

  it('passes through currents + voltages + hasSupply', () => {
    const currents = new Map([['D1', 0.01]])
    const volts = new Map([[10, 2], [20, 0]])
    const input = buildCoachInput(makeLedCircuit(), currents, volts, true)
    expect(input.currentsByRef).toBe(currents)
    expect(input.netVoltages).toBe(volts)
    expect(input.hasSupply).toBe(true)
  })

  it('skips an LED whose anode/cathode net is unknown, and a null circuit', () => {
    const c = makeLedCircuit()
    c.parts[0].padNet = new Map([['1', 10]]) // no cathode
    expect(buildCoachInput(c, new Map(), null, true).leds).toHaveLength(0)
    expect(buildCoachInput(null, new Map(), null, true).leds).toHaveLength(0)
  })
})

describe('hasSupplyAttached', () => {
  it('false without a ground, false with ground but no source', () => {
    expect(hasSupplyAttached([{ kind: 'dc-supply', id: 'a', netId: 1, volts: 5, seriesOhms: 0.1 }], null)).toBe(false)
    expect(hasSupplyAttached([], 0)).toBe(false)
  })

  it('true with a ground AND a driving source', () => {
    expect(
      hasSupplyAttached([{ kind: 'dc-supply', id: 'a', netId: 1, volts: 5, seriesOhms: 0.1 }], 0),
    ).toBe(true)
  })
})

// ─── store integration (first-light sample) ──────────────────────────────────────

/**
 * The op-result key carrying D1's LED current. The deck splices a 0V series
 * ammeter `vsense_<ref>` on the LED anode and saves its branch current; the op
 * result normalizer yields `i(vsense_<ref>)` (vsense_<ref>#branch → i(vsense_…)),
 * which mapOpResultToCurrents (buildLedSpiceNames → ledSenseName) reverses back
 * to the ref. The diode's own @d_<ref>[i] vector carries no data on ngspice 46.
 */
function d1CurrentKey(): string {
  return 'i(vsense_d1)'
}

/** Let queued microtasks (awaited promise continuations) drain a few turns. */
async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

/** The deckLines of the most recent loadCircuit command sent through the mock. */
function lastLoadedDeck(mock: MockSimClient): string[] | undefined {
  const loads = mock.sent.filter(
    (c): c is Extract<typeof c, { type: 'loadCircuit' }> => c.type === 'loadCircuit',
  )
  return loads.length > 0 ? loads[loads.length - 1].deckLines : undefined
}

describe('energize() — auto-rig + op solve lights the LED', () => {
  let store: AppStore
  let mock: MockSimClient

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(firstLight, 'first-light.kicad_pcb')
  })

  it('attaches the supply to the VIN net (not LEDA between R1 and D1)', async () => {
    // Drop any auto-attached supply so energize() must re-rig from scratch.
    for (const inst of [...store.getState().instruments]) {
      if ('id' in inst) store.getState().removeInstrument(inst.id)
    }
    const p = store.getState().energize()

    const supply = store.getState().instruments.find(i => i.kind === 'dc-supply')!
    expect(supply).toBeDefined()
    const vin = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!
    const leda = store.getState().circuit!.nets.find(n => n.kicadName === 'LEDA')!
    // The supply must land on VIN (before R1), NOT on LEDA (between R1 and D1):
    // powering LEDA directly puts 5 V across the LED, bypassing the limiter.
    expect((supply as { netId: number }).netId).toBe(vin.id)
    expect((supply as { netId: number }).netId).not.toBe(leda.id)

    mock.emit({ type: 'opResult', values: { [d1CurrentKey()]: 0.01, leda: 1.8, vin: 5 } })
    await p
  })

  it('attaches a supply if missing, loads + runs the op', async () => {
    // Drop any auto-attached supply to prove energize() re-rigs one.
    for (const inst of [...store.getState().instruments]) {
      if ('id' in inst) store.getState().removeInstrument(inst.id)
    }
    expect(store.getState().instruments).toHaveLength(0)

    const p = store.getState().energize()
    // A supply was auto-attached so the op can run.
    expect(
      store.getState().instruments.some(i => i.kind === 'dc-supply'),
    ).toBe(true)
    expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(true)
    expect(mock.sent.some(c => c.type === 'runOp')).toBe(true)

    // LED conducting ~10 mA → currentsByRef + coach silent (lit).
    mock.emit({ type: 'opResult', values: { [d1CurrentKey()]: 0.01, leda: 1.8, vin: 5 } })
    await p
    expect(store.getState().currentsByRef.get('D1')).toBeCloseTo(0.01, 6)
    expect(store.getState().coachNotes).toHaveLength(0)
  })
})

describe('re-op while energized — lowering the supply dims the LED', () => {
  let store: AppStore
  let mock: MockSimClient
  let supplyId: string

  beforeEach(async () => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(firstLight, 'first-light.kicad_pcb')

    // energize() auto-attaches the supply on the VIN rail (suggestSupplies now
    // recognises VIN), then runs the op at 5 V.
    const p = store.getState().energize()
    const supply = store.getState().instruments.find(i => i.kind === 'dc-supply')!
    supplyId = (supply as { id: string }).id
    mock.emit({ type: 'opResult', values: { [d1CurrentKey()]: 0.01, leda: 1.8, vin: 5 } })
    await p
    expect(store.getState().simState).toBe('idle')
  })

  it('updateInstrument while energized re-loads + re-runs the op with the lowered voltage', async () => {
    const before = mock.sent.filter(c => c.type === 'runOp').length
    const supply = store.getState().instruments.find(
      i => 'id' in i && i.id === supplyId,
    )!
    store.getState().updateInstrument(supplyId, { ...supply, volts: 2 } as typeof supply)

    // A fresh op solve was kicked off by the energized re-op.
    const after = mock.sent.filter(c => c.type === 'runOp').length
    expect(after).toBeGreaterThan(before)

    // BEHAVIOUR: the re-op deck reflects the lowered supply voltage (DC 2), not a
    // hand-fed current literal — proving the deck regenerated from the new value.
    const deck = lastLoadedDeck(mock)!
    expect(deck).toBeDefined()
    const supplyLine = deck.find(l => /^vpsu_/i.test(l))!
    expect(supplyLine).toMatch(/\bDC 2\b/)

    // Lower supply → lower LED current (dimmer). Resolve the pending op.
    mock.emit({ type: 'opResult', values: { [d1CurrentKey()]: 0.002, leda: 1.7, vin: 2 } })
    await store.getState().whenReopSettled()
    expect(store.getState().currentsByRef.get('D1')!).toBeLessThan(0.01)
  })

  it('coalesces a knob-drag flood: bounded op solves, settles on the FINAL value', async () => {
    const before = mock.sent.filter(c => c.type === 'runOp').length
    const supply = store.getState().instruments.find(
      i => 'id' in i && i.id === supplyId,
    )! as { id: string; kind: 'dc-supply'; netId: number; volts: number; seriesOhms: number }

    // Simulate a rapid drag: many updateInstrument calls before any op resolves.
    // The FIRST kicks off an op (now in flight, awaiting an opResult the mock has
    // not emitted yet); the rest just queue the latest value (reopRequested).
    for (const v of [4, 3, 2, 1]) {
      store.getState().updateInstrument(supply.id, { ...supply, volts: v })
    }

    // (a) BOUNDED: not one full re-op per call. Only the FIRST drag value started
    // an op solve; the other three coalesced into the pending request.
    const midRunOps = mock.sent.filter(c => c.type === 'runOp').length - before
    expect(midRunOps).toBe(1)

    // Resolve the in-flight op → the coalescer re-solves ONCE for the latest (1 V).
    mock.emit({ type: 'opResult', values: { [d1CurrentKey()]: 0.004, leda: 1.75, vin: 4 } })
    // Let the first op's continuation run + the trailing solve get issued (its
    // loadCircuit+runOp are sent and a fresh opResult listener is registered).
    await flushMicrotasks()
    mock.emit({ type: 'opResult', values: { [d1CurrentKey()]: 0.001, leda: 1.6, vin: 1 } })
    await store.getState().whenReopSettled()

    // (b) The FINAL state reflects the LAST drag value (1 V), and the total op
    // solves stayed bounded (far fewer than one-per-call would have produced).
    const totalRunOps = mock.sent.filter(c => c.type === 'runOp').length - before
    expect(totalRunOps).toBe(2) // initial in-flight + one trailing re-solve
    expect(store.getState().instruments.find(i => 'id' in i && i.id === supply.id))
      .toMatchObject({ volts: 1 })
    const deck = lastLoadedDeck(mock)!
    const supplyLine = deck.find(l => /^vpsu_/i.test(l))!
    expect(supplyLine).toMatch(/\bDC 1\b/)
  })

  it('does not re-op again when the final value equals the last solved value', async () => {
    const supply = store.getState().instruments.find(
      i => 'id' in i && i.id === supplyId,
    )! as { id: string; kind: 'dc-supply'; netId: number; volts: number; seriesOhms: number }
    const before = mock.sent.filter(c => c.type === 'runOp').length

    // One change starts an op; a second change BACK to the in-flight value must not
    // trigger an extra trailing solve (no-op guard against an infinite loop).
    store.getState().updateInstrument(supply.id, { ...supply, volts: 3 })
    store.getState().updateInstrument(supply.id, { ...supply, volts: 3 })
    mock.emit({ type: 'opResult', values: { [d1CurrentKey()]: 0.003, leda: 1.7, vin: 3 } })
    await store.getState().whenReopSettled()

    const totalRunOps = mock.sent.filter(c => c.type === 'runOp').length - before
    expect(totalRunOps).toBe(1)
  })

  it('does NOT re-op when not energized (no op shown yet)', () => {
    // Fresh store: open board, attach a supply, but never run an op (opVoltages
    // null → not energized), so a knob nudge must not trigger an op solve.
    const m2 = createMockSimClient()
    const s2 = createAppStore({ simClient: m2 })
    s2.getState().openBoardFromText(firstLight, 'first-light.kicad_pcb')
    const vin = s2.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!
    s2.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vin.id, volts: 5, seriesOhms: 0.1 })
    expect(s2.getState().opVoltages).toBeNull()
    s2.getState().updateInstrument('psu1', {
      kind: 'dc-supply', id: 'psu1', netId: vin.id, volts: 2, seriesOhms: 0.1,
    })
    expect(m2.sent.some(c => c.type === 'runOp')).toBe(false)
  })
})

describe('coach notes after an op', () => {
  it('no supply attached → "nothing is powering" note for the dark LED', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(firstLight, 'first-light.kicad_pcb')
    // Remove the auto supply so the board has a ground but no source.
    for (const inst of [...store.getState().instruments]) {
      if ('id' in inst) store.getState().removeInstrument(inst.id)
    }
    // Drive the coach through the REAL op-ingest path (ingestEvent's opResult
    // case), not a setState injection: emit a standalone opResult with no current
    // for D1. The store rebuilds coachNotes from buildCoachInput/diagnoseDarkLeds,
    // with hasSupply=false because no source is attached.
    mock.emit({ type: 'opResult', values: { leda: 0, vin: 0 } })

    const notes = store.getState().coachNotes
    expect(notes).toHaveLength(1)
    expect(notes[0].ref).toBe('D1')
    expect(notes[0].detail).toMatch(/Nothing is powering the board/)
    expect(store.getState().currentsByRef.get('D1')).toBeUndefined()
  })
})
