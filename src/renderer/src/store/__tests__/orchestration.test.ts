/**
 * orchestration.test.ts — Task 24
 *
 * End-to-end orchestration unit tests for the sim-orchestration slice of the
 * store, driven entirely by an INJECTED mock simClient (no live MessagePort /
 * Electron / ngspice). This is the unit-test surrogate for the Spec §4 primary
 * scenario; the TRUE runtime acceptance (real ngspice + real GUI) is Phase 6's
 * Playwright E2E.
 *
 * Covered:
 *   - powerOn (fixture-rc) → mock opResult{out:2.5} → assert the board hooks
 *     (showOpAnnotations / applyNetVoltages) are invoked with out = 2.5
 *   - run → loadCircuit (when dirty) + runTransient with the §7.5 bounded
 *     window (tstep = min(1/(200·fmax),10µs), tstop = 30 s, never unbounded)
 *   - run → mock samples → per-probe ring buffer populated → scope can read it
 *   - pause / resume route through halt / resume (user-owner)
 *   - setPace → setPace command
 *   - alter supply while running → live alter (no reload)
 *   - benchRestarted → toast state (+ sequential-logic caveat when digital parts)
 *   - convergenceFailure → plain-language card state
 *   - fidelity banner derived state (refs + modes) when any status !== 'ok'
 *   - simulated crash → replay re-sends deck + re-applies instruments, resumes
 *     if was running
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore, fidelityBannerItems, mapOpResultToCurrents, type AppStore } from '../appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'
import type { Resolution } from '../../../../core/models/types'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

/** Make a tiny board-hook spy that records calls. */
function makeBoardHooks(): {
  hooks: import('../appStore').BoardHooks
  appliedVoltages: { voltages: Map<number, number>; min: number; max: number }[]
  annotations: Map<number, number>[]
} {
  const appliedVoltages: { voltages: Map<number, number>; min: number; max: number }[] = []
  const annotations: Map<number, number>[] = []
  return {
    appliedVoltages,
    annotations,
    hooks: {
      applyNetVoltages(voltages, min, max) {
        appliedVoltages.push({ voltages: new Map(voltages), min, max })
      },
      showOpAnnotations(voltages) {
        annotations.push(new Map(voltages))
      },
    },
  }
}

describe('orchestration — powerOn applies op annotations + tint (fixture-rc)', () => {
  let store: AppStore
  let mock: MockSimClient
  let board: ReturnType<typeof makeBoardHooks>

  beforeEach(() => {
    mock = createMockSimClient()
    board = makeBoardHooks()
    store = createAppStore({ simClient: mock })
    store.getState().setBoardHooks(board.hooks)
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const vin = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vin.id, volts: 5, seriesOhms: 0.1 })
  })

  it('powerOn → opResult{out:2.5} drives showOpAnnotations + applyNetVoltages with out=2.5', async () => {
    const p = store.getState().powerOn()
    expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(true)
    expect(mock.sent.some(c => c.type === 'runOp')).toBe(true)

    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p

    const outNet = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!

    // board annotation hook called with OUT = 2.5
    expect(board.annotations.length).toBeGreaterThan(0)
    const lastAnn = board.annotations[board.annotations.length - 1]
    expect(lastAnn.get(outNet.id)).toBeCloseTo(2.5, 5)

    // copper tint hook called with OUT = 2.5
    expect(board.appliedVoltages.length).toBeGreaterThan(0)
    const lastTint = board.appliedVoltages[board.appliedVoltages.length - 1]
    expect(lastTint.voltages.get(outNet.id)).toBeCloseTo(2.5, 5)
  })
})

describe('orchestration — run / pause / resume / pace (fixture-rc)', () => {
  let store: AppStore
  let mock: MockSimClient
  let vinId: number

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
    // add a voltage probe on OUT so samples can land in a ring buffer
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp1', netId: outId, color: '#6f6' })
  })

  it('run loads the deck (dirty) then runs a BOUNDED transient (tstop=30s, tstep<=10µs)', () => {
    store.getState().run()
    const load = mock.sent.find(c => c.type === 'loadCircuit')
    expect(load).toBeDefined()
    const tran = mock.sent.find(c => c.type === 'runTransient') as
      | Extract<import('../../../../simhost/protocol').SimCommand, { type: 'runTransient' }>
      | undefined
    expect(tran).toBeDefined()
    // bounded window — never unbounded (Spec §7.5)
    expect(tran!.tstopSeconds).toBe(30)
    // no function-gen → fmax falls back → tstep capped at 10 µs
    expect(tran!.tstepSeconds).toBeLessThanOrEqual(10e-6)
    expect(tran!.tstepSeconds).toBeGreaterThan(0)
    expect(store.getState().simState).toBe('running')
  })

  it('tstep derives from the fastest function-gen: min(1/(200·fmax),10µs)', () => {
    // 1 MHz gen → 1/(200·1e6) = 5e-9 s, well under the 10 µs cap
    store.getState().addInstrument({
      kind: 'function-gen', id: 'fg1', netId: vinId,
      wave: 'sine', freqHz: 1_000_000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    })
    store.getState().run()
    const tran = mock.sent.find(c => c.type === 'runTransient') as
      | Extract<import('../../../../simhost/protocol').SimCommand, { type: 'runTransient' }>
      | undefined
    expect(tran).toBeDefined()
    expect(tran!.tstepSeconds).toBeCloseTo(1 / (200 * 1_000_000), 15)
  })

  it('run does NOT reload an already-clean deck on resume-from-pause', () => {
    store.getState().run()
    mock.emit({ type: 'status', running: true, simTimeSeconds: 0, realtimeFactor: 1 })
    store.getState().pause()
    expect(mock.sent.some(c => c.type === 'halt')).toBe(true)
    expect(store.getState().simState).toBe('paused')
    mock.clearSent()
    // resume should NOT reload (deck is clean) — just resume
    store.getState().run()
    expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(false)
    expect(mock.sent.some(c => c.type === 'resume')).toBe(true)
  })

  it('setPace forwards a setPace command and records the factor', () => {
    store.getState().setPace('max')
    expect(mock.sent.some(c => c.type === 'setPace' && c.realtimeFactor === 'max')).toBe(true)
    expect(store.getState().paceFactor).toBe('max')
    store.getState().setPace(0.1)
    expect(mock.sent.some(c => c.type === 'setPace' && c.realtimeFactor === 0.1)).toBe(true)
    expect(store.getState().paceFactor).toBe(0.1)
  })

  it('run sends the current pace before the transient (so the engine honours it)', () => {
    store.getState().setPace(0.1)
    mock.clearSent()
    store.getState().run()
    const idxPace = mock.sent.findIndex(c => c.type === 'setPace')
    const idxTran = mock.sent.findIndex(c => c.type === 'runTransient')
    expect(idxPace).toBeGreaterThanOrEqual(0)
    expect(idxTran).toBeGreaterThan(idxPace)
  })

  it('supply knob-drag while running sends a live alter, no reload (Spec §4 step 5)', () => {
    store.getState().run()
    mock.emit({ type: 'status', running: true, simTimeSeconds: 0, realtimeFactor: 1 })
    expect(store.getState().simState).toBe('running')
    expect(store.getState().deckDirty).toBe(false)
    mock.clearSent()

    store.getState().updateInstrument('psu1', {
      kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 9, seriesOhms: 0.1,
    })
    const alter = mock.sent.find(c => c.type === 'alter')
    expect(alter).toBeDefined()
    expect((alter as { device: string }).device).toContain('vpsu_psu1')
    expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(false)
    expect(store.getState().deckDirty).toBe(false)
  })
})

describe('orchestration — samples feed per-probe ring buffers + live overlay', () => {
  let store: AppStore
  let mock: MockSimClient
  let board: ReturnType<typeof makeBoardHooks>
  let outId: number

  beforeEach(() => {
    mock = createMockSimClient()
    board = makeBoardHooks()
    store = createAppStore({ simClient: mock })
    store.getState().setBoardHooks(board.hooks)
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp1', netId: outId, color: '#6f6' })
    store.getState().run()
  })

  it('a samples event populates the OUT probe ring buffer', () => {
    // vectors then samples (OUT spiceNode is "out")
    mock.emit({ type: 'vectors', names: ['time', 'out', 'vin'] })
    mock.emit({
      type: 'samples',
      vectorNames: ['out'],
      columns: [new Float64Array([2.4, 2.5, 2.5])],
      simTime: new Float64Array([0, 1e-6, 2e-6]),
    })
    const ring = store.getState().getProbeRingBuffer('vp1')
    expect(ring).not.toBeNull()
    expect(ring!.length).toBe(3)
    const read = ring!.read(0, 3)
    expect(read.values[2]).toBeCloseTo(2.5, 5)
    expect(read.times[2]).toBeCloseTo(2e-6, 12)
  })

  it('the latest sample per probed net drives the live voltage overlay', () => {
    mock.emit({ type: 'vectors', names: ['time', 'out'] })
    mock.emit({
      type: 'samples',
      vectorNames: ['out'],
      columns: [new Float64Array([2.4, 2.5])],
      simTime: new Float64Array([0, 1e-6]),
    })
    // applyNetVoltages was called with the latest OUT sample (2.5)
    expect(board.appliedVoltages.length).toBeGreaterThan(0)
    const last = board.appliedVoltages[board.appliedVoltages.length - 1]
    expect(last.voltages.get(outId)).toBeCloseTo(2.5, 5)
  })
})

describe('orchestration — benchRestarted toast + sequential-logic caveat', () => {
  it('benchRestarted on an analog board sets a toast WITHOUT the digital caveat', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    mock.emit({ type: 'benchRestarted', reason: 'window-elapsed' })
    const toast = store.getState().benchRestartToast
    expect(toast).not.toBeNull()
    expect(toast!.reason).toBe('window-elapsed')
    expect(toast!.sequentialLogicCaveat).toBe(false)
  })

  it('benchRestarted with a digital part present adds the sequential-logic caveat', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    // Inject a fake digital resolution to flip the caveat.
    const digital: Resolution = {
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: { kind: 'xspice-digital', templateId: '74HC00', pinMap: {} },
    }
    store.setState({ resolutions: [...store.getState().resolutions, digital] })
    mock.emit({ type: 'benchRestarted', reason: 'memory' })
    const toast = store.getState().benchRestartToast
    expect(toast!.reason).toBe('memory')
    expect(toast!.sequentialLogicCaveat).toBe(true)
  })
})

describe('orchestration — convergenceFailure card', () => {
  it('convergenceFailure event sets a plain-language card with the raw detail', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    store.setState({ simState: 'op' })
    mock.emit({ type: 'convergenceFailure', detail: 'timestep too small' })
    const card = store.getState().convergenceCard
    expect(card).not.toBeNull()
    expect(card!.rawDetail).toContain('timestep too small')
    expect(card!.plainLanguage.length).toBeGreaterThan(0)
    // a convergence failure drops us out of the active run state
    expect(store.getState().simState).toBe('idle')
  })
})

describe('orchestration — fidelity banner', () => {
  it('no banner when every resolution is ok', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    expect(fidelityBannerItems(store.getState().resolutions)).toEqual([])
  })

  it('banner lists ref + mode for every stubbed/unresolved part', () => {
    const resolutions: Resolution[] = [
      { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 a b 10000' } },
      { ref: 'U2', status: 'stubbed', tier: 6, warnings: [], model: { kind: 'stub', mode: 'open' } },
      { ref: 'D5', status: 'unresolved', tier: 6, warnings: [] },
    ]
    const items = fidelityBannerItems(resolutions)
    expect(items.map(i => i.ref)).toEqual(['U2', 'D5'])
    const u2 = items.find(i => i.ref === 'U2')!
    expect(u2.mode).toBe('stubbed (open)')
    const d5 = items.find(i => i.ref === 'D5')!
    expect(d5.mode).toBe('unresolved')
  })
})

describe('orchestration — SimHost crash replay', () => {
  let store: AppStore
  let mock: MockSimClient
  let vinId: number

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
  })

  it('replay after crash while RUNNING re-sends loadCircuit + restarts the transient', () => {
    store.getState().run()
    mock.emit({ type: 'status', running: true, simTimeSeconds: 0, realtimeFactor: 1 })
    expect(store.getState().simState).toBe('running')
    mock.clearSent()

    // crash + replay (createRendererStore calls these after the new port attaches)
    store.getState().noteCrash(true)
    store.getState().replayAfterCrash()

    // deck re-sent
    const load = mock.sent.find(c => c.type === 'loadCircuit')
    expect(load).toBeDefined()
    expect((load as { deckLines: string[] }).deckLines.some(l => l.includes('vpsu_psu1'))).toBe(true)
    // transient restarted (was running)
    expect(mock.sent.some(c => c.type === 'runTransient')).toBe(true)
  })

  it('replay after crash while in OP re-sends loadCircuit + re-runs op', () => {
    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    return p.then(() => {
      // powerOn resolves to idle; simulate a crash mid-op by forcing op state
      store.setState({ simState: 'op' })
      mock.clearSent()
      store.getState().replayAfterCrash()
      expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(true)
      expect(mock.sent.some(c => c.type === 'runOp')).toBe(true)
    })
  })

  it('crashed instrument state is preserved across replay (alters re-baked into deck)', () => {
    // change the supply to 9V (deckDirty) so the replayed deck reflects it
    store.getState().updateInstrument('psu1', { kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 9, seriesOhms: 0.1 })
    mock.clearSent()
    store.getState().replayAfterCrash()
    const load = mock.sent.find(c => c.type === 'loadCircuit') as { deckLines: string[] } | undefined
    expect(load).toBeDefined()
    // the 9 V supply card is in the replayed deck
    expect(load!.deckLines.some(l => /vpsu_psu1\s+\S+\s+0\s+DC\s+9\b/i.test(l))).toBe(true)
  })
})

describe('mapOpResultToCurrents — LED ammeter branch currents → part refs', () => {
  it('maps an LED ref to its ammeter branch current via the ref↔sensename map', () => {
    const ledSpiceNames = new Map<string, string>([['D1', 'vsense_d1']])
    const values = { vin: 5, out: 2.5, 'i(vsense_d1)': 0.011 }
    const currents = mapOpResultToCurrents(values, ledSpiceNames)
    expect(currents.get('D1')).toBeCloseTo(0.011)
    expect(currents.size).toBe(1)
  })

  it('accepts the #branch encoding, is case-insensitive, and stores the magnitude', () => {
    const ledSpiceNames = new Map<string, string>([['D2', 'vsense_d2']])
    // A 0V ammeter's branch current can read back negative depending on wiring;
    // the store keeps the magnitude (ledIntensity uses magnitude).
    const currents = mapOpResultToCurrents({ 'VSENSE_D2#branch': -0.008 }, ledSpiceNames)
    expect(currents.get('D2')).toBeCloseTo(0.008)
  })

  it('omits refs whose current is absent from the result', () => {
    const ledSpiceNames = new Map<string, string>([['D1', 'vsense_d1'], ['D9', 'vsense_d9']])
    const currents = mapOpResultToCurrents({ 'i(vsense_d1)': 0.01 }, ledSpiceNames)
    expect(currents.has('D1')).toBe(true)
    expect(currents.has('D9')).toBe(false)
  })

  it('populates currentsByRef from the LED ammeter branch current (magnitude)', () => {
    // An op result that carries the LED's 0V series-ammeter branch current under
    // the normalized key i(vsense_<ref>) → mapOpResultToCurrents stores the
    // magnitude in currentsByRef keyed by the part ref (the glow data source).
    const ledSpiceNames = new Map<string, string>([['D1', 'vsense_d1']])
    const opResult = { vin: 5, leda: 1.8, 'i(vsense_d1)': -0.0104 }
    const currentsByRef = mapOpResultToCurrents(opResult, ledSpiceNames)
    expect(currentsByRef.get('D1')).toBeCloseTo(0.0104, 6)
  })
})
