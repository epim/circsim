/**
 * errorStates.test.ts — Task 28
 *
 * Store-level unit tests for every Spec §12 error / guided-empty state.
 * All assertions are against the store's derived flags and fields — no UI tested here.
 *
 * States covered (Spec §12 checklist):
 *   1. Parse error → parseError carries line/col + viewerOnly set when netlist fails
 *   2. No-ground guided state → run() / powerOn() are no-ops; store signals the need
 *   3. No-source guided state → powerOn() is a no-op; store signals the need
 *   4. Convergence failure → plain-language card + retry-ladder note + raw detail
 *   5. Fidelity banner (non-dismissable) → fidelityBannerItems lists stubbed/unresolved
 *   6. SimHost crash toast → noteCrash/crashNotice state
 *
 * Spec §12, §16 risk 7.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createAppStore,
  fidelityBannerItems,
  type AppStore,
} from '../appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'
import type { Resolution } from '../../../../core/models/types'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

// ─── 1. Parse error card (Spec §12 first bullet) ─────────────────────────────

describe('Spec §12 — parse error card with line/col + viewer-only mode', () => {
  let store: AppStore
  let mock: MockSimClient

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
  })

  it('opening a board with a broken S-expression sets parseError with line/col', () => {
    // Inject a deliberately broken .kicad_pcb (unclosed paren)
    const broken = '(kicad_pcb (version 20221018)\n  (net 1 "VIN"\n'
    store.getState().openBoardFromText(broken, 'broken.kicad_pcb')
    const s = store.getState()

    expect(s.parseError).not.toBeNull()
    expect(s.parseError!.fileName).toBe('broken.kicad_pcb')
    // The parser (core/sexpr) attaches line/col on SexprError
    expect(s.parseError!.line).toBeTypeOf('number')
  })

  it('parse error ⇒ board is null, circuit is null, resolutions is empty', () => {
    const broken = '(kicad_pcb (net 1 "X"'
    store.getState().openBoardFromText(broken, 'broken.kicad_pcb')
    const s = store.getState()
    expect(s.board).toBeNull()
    expect(s.circuit).toBeNull()
    expect(s.resolutions).toHaveLength(0)
  })

  it('a successful open clears any previous parseError', () => {
    const broken = '(kicad_pcb (net 1 "X"'
    store.getState().openBoardFromText(broken, 'broken.kicad_pcb')
    expect(store.getState().parseError).not.toBeNull()

    // Now open a valid file
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    expect(store.getState().parseError).toBeNull()
  })

  it('a valid board with ≥1 part is NOT in viewer-only mode', () => {
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    expect(store.getState().viewerOnly).toBe(false)
  })

  it('viewer-only mode is set when the board has no parts (empty circuit)', () => {
    // Minimal valid S-expression but no footprints → no parts, empty circuit
    const emptyBoard = `(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (net 0 "")
  (net 1 "VCC")
)`
    store.getState().openBoardFromText(emptyBoard, 'empty.kicad_pcb')
    const s = store.getState()
    // Circuit extracted successfully but has no parts → viewerOnly
    expect(s.parseError).toBeNull()
    expect(s.viewerOnly).toBe(true)
  })
})

// ─── 2. No-ground guided state (Spec §12 second bullet) ──────────────────────

describe('Spec §12 — no-ground guided empty state', () => {
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

  it('powerOn() returns null without sending any commands when groundNetId is null', async () => {
    store.getState().setGround(null)
    mock.clearSent()
    const result = await store.getState().powerOn()
    expect(result).toBeNull()
    expect(mock.sent).toHaveLength(0)
  })

  it('run() sends nothing when groundNetId is null — guided no-op, not a crash', () => {
    store.getState().setGround(null)
    mock.clearSent()
    store.getState().run()
    expect(mock.sent).toHaveLength(0)
    // simState stays idle; the UI shows the guided state instead
    expect(store.getState().simState).toBe('idle')
  })

  it('groundNetId is auto-suggested to GND on fixture-rc load', () => {
    const s = store.getState()
    expect(s.groundNetId).not.toBeNull()
    const gndNet = s.circuit!.nets.find(n => n.id === s.groundNetId!)!
    expect(gndNet.kicadName).toBe('GND')
  })
})

// ─── 3. No-source guided state (Spec §12 second bullet — zero resolved sources) ─

describe('Spec §12 — no-source guided empty state', () => {
  let store: AppStore
  let mock: MockSimClient

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    // Ground is auto-suggested. No instruments attached.
  })

  it('powerOn() returns null (no source) without sending commands', async () => {
    // groundNetId is set by auto-suggest, but no instruments
    expect(store.getState().groundNetId).not.toBeNull()
    expect(store.getState().instruments).toHaveLength(0)

    mock.clearSent()
    const result = await store.getState().powerOn()
    expect(result).toBeNull()
    expect(mock.sent).toHaveLength(0)
  })

  it('run() sends nothing when there is no source instrument', () => {
    mock.clearSent()
    store.getState().run()
    expect(mock.sent).toHaveLength(0)
    expect(store.getState().simState).toBe('idle')
  })

  it('the toolbar can derive "no source" by checking instruments for supply kinds', () => {
    const instruments = store.getState().instruments
    const hasSource = instruments.some(
      i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
    )
    expect(hasSource).toBe(false)
  })

  it('adding a dc-supply enables powerOn', async () => {
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
    // Now there is a source → powerOn sends commands
    const p = store.getState().powerOn()
    expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(true)
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
  })
})

// ─── 4. Convergence failure card (Spec §12 third bullet) ─────────────────────

describe('Spec §12 — convergence-failure card wording', () => {
  let store: AppStore
  let mock: MockSimClient

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
  })

  it('convergenceFailure event sets a plain-language card (not raw ngspice text as title)', () => {
    store.setState({ simState: 'op' })
    mock.emit({ type: 'convergenceFailure', detail: 'no convergence in iter' })
    const card = store.getState().convergenceCard
    expect(card).not.toBeNull()
    // The plain-language message must NOT be the raw ngspice string
    expect(card!.plainLanguage).not.toEqual('no convergence in iter')
    // It must be a human-readable explanation
    expect(card!.plainLanguage).toMatch(/couldn.t find a stable solution/i)
  })

  it('convergence card includes the retry-ladder note', () => {
    mock.emit({ type: 'convergenceFailure', detail: 'timestep too small' })
    const card = store.getState().convergenceCard
    expect(card).not.toBeNull()
    expect(card!.retryLadderNote).toMatch(/gmin|source.?step/i)
  })

  it('convergence card preserves the raw ngspice detail (expandable section)', () => {
    const rawDetail = 'doAnalysis: iteration limit exceeded at timestep 1.23e-9'
    mock.emit({ type: 'convergenceFailure', detail: rawDetail })
    expect(store.getState().convergenceCard!.rawDetail).toBe(rawDetail)
  })

  it('convergence failure drops simState to idle', () => {
    store.setState({ simState: 'running' })
    mock.emit({ type: 'convergenceFailure', detail: 'no convergence' })
    expect(store.getState().simState).toBe('idle')
  })

  it('dismissConvergenceCard clears the card', () => {
    mock.emit({ type: 'convergenceFailure', detail: 'no convergence' })
    expect(store.getState().convergenceCard).not.toBeNull()
    store.getState().dismissConvergenceCard()
    expect(store.getState().convergenceCard).toBeNull()
  })
})

// ─── 5. Fidelity banner — non-dismissable + lists refs (Spec §8.6, §12) ──────

describe('Spec §12 — fidelity banner is non-dismissable and lists refs', () => {
  it('fidelityBannerItems is empty when all parts are resolved ok', () => {
    const resolutions: Resolution[] = [
      { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 a b 10k' } },
      { ref: 'R2', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r2 a b 10k' } },
    ]
    expect(fidelityBannerItems(resolutions)).toHaveLength(0)
  })

  it('fidelityBannerItems lists every stubbed ref with "stubbed (open)"', () => {
    const resolutions: Resolution[] = [
      { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 a b 10k' } },
      { ref: 'U2', status: 'stubbed', tier: 6, warnings: [], model: { kind: 'stub', mode: 'open' } },
    ]
    const items = fidelityBannerItems(resolutions)
    expect(items).toHaveLength(1)
    expect(items[0].ref).toBe('U2')
    expect(items[0].mode).toBe('stubbed (open)')
  })

  it('fidelityBannerItems lists every unresolved ref with "unresolved"', () => {
    const resolutions: Resolution[] = [
      { ref: 'D1', status: 'unresolved', tier: 6, warnings: [] },
    ]
    const items = fidelityBannerItems(resolutions)
    expect(items[0].ref).toBe('D1')
    expect(items[0].mode).toBe('unresolved')
  })

  it('banner lists short-stub mode correctly', () => {
    const resolutions: Resolution[] = [
      { ref: 'J1', status: 'stubbed', tier: 6, warnings: [], model: { kind: 'stub', mode: 'short' } },
    ]
    const items = fidelityBannerItems(resolutions)
    expect(items[0].mode).toBe('stubbed (short)')
  })

  it('the store does NOT expose any action to dismiss the fidelity banner (it is non-dismissable)', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    store.getState().stubPart('R1', 'open')

    // No "dismiss banner" action in the store — the banner is non-dismissable
    // by design. We assert the store's action list has no such method.
    const actions = Object.keys(store.getState())
    expect(actions).not.toContain('dismissFidelityBanner')
    expect(actions).not.toContain('hideFidelityBanner')
    expect(actions).not.toContain('clearFidelityBanner')
  })
})

// ─── 6. SimHost crash toast (Spec §6.1, §12) ─────────────────────────────────

describe('Spec §12 — SimHost crash toast', () => {
  let store: AppStore
  let mock: MockSimClient

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
  })

  it('noteCrash(true) sets crashNotice with willRespawn:true', () => {
    store.getState().noteCrash(true)
    const notice = store.getState().crashNotice
    expect(notice).not.toBeNull()
    expect(notice!.willRespawn).toBe(true)
    expect(typeof notice!.at).toBe('number')
  })

  it('noteCrash(false) sets crashNotice with willRespawn:false (fatal crash)', () => {
    store.getState().noteCrash(false)
    expect(store.getState().crashNotice!.willRespawn).toBe(false)
  })

  it('crash notice can be cleared by setting crashNotice to null (toast dismissed)', () => {
    store.getState().noteCrash(true)
    expect(store.getState().crashNotice).not.toBeNull()
    store.setState({ crashNotice: null })
    expect(store.getState().crashNotice).toBeNull()
  })

  it('replayAfterCrash re-sends loadCircuit and preserves instrument state', () => {
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 7, seriesOhms: 0.1 })
    // Simulate running state
    store.setState({ simState: 'running' })
    mock.clearSent()

    store.getState().noteCrash(true)
    store.getState().replayAfterCrash()

    expect(mock.sent.some(c => c.type === 'loadCircuit')).toBe(true)
    // The replayed deck includes the 7 V supply
    const load = mock.sent.find(c => c.type === 'loadCircuit') as { deckLines: string[] } | undefined
    expect(load).toBeDefined()
    expect(load!.deckLines.some(l => /DC\s+7\b/.test(l))).toBe(true)
    // Running state → transient restarted
    expect(mock.sent.some(c => c.type === 'runTransient')).toBe(true)
  })
})
