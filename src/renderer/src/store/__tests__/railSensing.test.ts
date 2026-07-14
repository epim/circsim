/**
 * railSensing.test.ts — op-informed rail sensing (Tasks 4 + 5)
 *
 * Store-level coverage for the digital rail-voltage precedence work:
 *   Task 4 — railOverrides state (kicadName→volts), setRailOverride /
 *            clearRailOverride actions, and railOverrideNetMap() resolution.
 *   Task 5 — powerOn's conditional two-pass op orchestration (added below).
 *
 * Review fixes:
 *   FIX 1 — markDeckDirty clears the sensed-rail cache (stale reference frame).
 *   FIX 2 — the global ingestEvent listener must NOT commit powerOn's interim
 *           (pass-1, family-default) op result during the pass-2 solve.
 *   FIX 3 — snapshot railOverrides once per powerOn.
 */

import { describe, it, expect, vi } from 'vitest'
import { createAppStore, type AppStore, type BoardHooks } from '../appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'
import type { Circuit } from '../../../../core/netlist/extract'
import type { Resolution } from '../../../../core/models/types'

/** Board-hook spy: records every net-voltage set applied to the 3D board. */
function makeBoardHooks(): {
  hooks: BoardHooks
  applied: Map<number, number>[]
} {
  const applied: Map<number, number>[] = []
  return {
    applied,
    hooks: {
      applyNetVoltages(voltages) {
        applied.push(new Map(voltages))
      },
      showOpAnnotations() {},
    },
  }
}

// Same CD40106 (schmitt, family default 12 V) fixture the core sensing tests use.
const LOGIC4000_JSON = JSON.stringify({
  family: {
    vHighDefault: 12.0,
    adc: { inLowFrac: 0.3, inHighFrac: 0.7 },
    schmittAdc: { inLowFrac: 0.4, inHighFrac: 0.6 },
  },
  templates: {
    CD40106: {
      schmitt: true,
      gates: [{ prim: 'd_inverter', in: ['1A'], out: '1Y' }],
      inputs: ['1A'],
      outputs: ['1Y'],
      power: { vcc: 'VCC', gnd: 'GND' },
      delaysNs: 80,
    },
  },
})

const RES: Resolution[] = [
  {
    ref: 'U1',
    status: 'ok',
    tier: 3,
    warnings: [],
    model: {
      kind: 'xspice-digital',
      templateId: 'CD40106',
      pinMap: { '1': '1A', '2': '1Y', '14': 'VCC', '7': 'GND' },
    },
  } as unknown as Resolution,
]

/**
 * A CD40106 whose VDD net `/VGATED` (id 4, node `vgated`) has NO directly
 * attached supply — the switched-rail scenario. Net 1 (IN) / net 2 (OUT) / net 5
 * (GND, node `0`) round it out.
 */
function switchedRailCircuit(): Circuit {
  return {
    nets: [
      { id: 1, kicadName: 'IN', spiceNode: 'a', padRefs: [] },
      { id: 2, kicadName: 'OUT', spiceNode: 'b', padRefs: [] },
      { id: 4, kicadName: '/VGATED', spiceNode: 'vgated', padRefs: [] },
      { id: 5, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ],
    parts: [
      {
        ref: 'U1',
        value: 'CD40106',
        libId: 'Logic:CD40106',
        layer: 'F',
        padNet: new Map([
          ['1', 1],
          ['2', 2],
          ['14', 4],
          ['7', 5],
        ]),
        properties: {},
      },
    ],
    warnings: [],
  } as unknown as Circuit
}

// ─── Task 4: railOverrides state + resolution ──────────────────────────────────

describe('railOverrides state (Task 4)', () => {
  function make(): AppStore {
    return createAppStore({ simClient: createMockSimClient() })
  }

  it('setRailOverride stores by kicadName and resolves to a netId map', () => {
    const store = make()
    store.setState({ circuit: switchedRailCircuit() })
    store.getState().setRailOverride('/VGATED', 3.3)
    expect(store.getState().railOverrides.get('/VGATED')).toBe(3.3)
    expect(store.getState().railOverrideNetMap().get(4)).toBe(3.3)
  })

  it('setRailOverride ignores non-finite / non-positive volts', () => {
    const store = make()
    store.setState({ circuit: switchedRailCircuit() })
    store.getState().setRailOverride('/VGATED', 0)
    store.getState().setRailOverride('/VGATED', -5)
    store.getState().setRailOverride('/VGATED', Number.NaN)
    expect(store.getState().railOverrides.has('/VGATED')).toBe(false)
  })

  it('setRailOverride marks the deck dirty', () => {
    const store = make()
    store.setState({ circuit: switchedRailCircuit(), deckDirty: false })
    store.getState().setRailOverride('/VGATED', 3.3)
    expect(store.getState().deckDirty).toBe(true)
  })

  it('clearRailOverride removes the entry and marks the deck dirty', () => {
    const store = make()
    store.setState({ circuit: switchedRailCircuit(), deckDirty: false })
    store.getState().setRailOverride('/VGATED', 3.3)
    store.setState({ deckDirty: false })
    store.getState().clearRailOverride('/VGATED')
    expect(store.getState().railOverrides.has('/VGATED')).toBe(false)
    expect(store.getState().deckDirty).toBe(true)
  })

  it('railOverrideNetMap only includes nets present in the current circuit', () => {
    const store = make()
    store.setState({ circuit: switchedRailCircuit() })
    store.getState().setRailOverride('/VGATED', 3.3)
    store.getState().setRailOverride('/NONEXISTENT', 9)
    const map = store.getState().railOverrideNetMap()
    expect(map.get(4)).toBe(3.3)
    expect(map.size).toBe(1)
  })
})

// ─── Task 5: two-pass op orchestration in powerOn ──────────────────────────────

/** Seed a switched-rail board straight into store state (no fixture parse). */
function seedSwitchedRailBoard(store: AppStore): void {
  store.setState({
    circuit: switchedRailCircuit(),
    resolutions: RES,
    modelTexts: { 'logic4000.json': LOGIC4000_JSON },
    groundNetId: 5,
    // A supply on IN (net 1) satisfies powerOn's hasSource guard; it is NOT on
    // the VDD net, so /VGATED is an unresolved (tier-3) rail at deck-gen.
    instruments: [{ kind: 'dc-supply', id: 'psu1', netId: 1, volts: 5, seriesOhms: 0.1 }],
  })
}

/**
 * Auto-respond to every `runOp` with a scripted opResult. `values(pass)` receives
 * the 1-based pass number so a test can vary the reply per pass, or return null to
 * withhold the reply (simulating a pass-2 timeout). Each `loadCircuit` deck is
 * recorded in `decks`; `opRunCount()` returns how many `runOp` commands were sent.
 *
 * The reply is emitted on a microtask so powerOn's `waitFor('opResult')` (called
 * synchronously right after `send({runOp})`) has registered its listener first.
 */
function autoRespond(
  mock: MockSimClient,
  values: (pass: number) => Record<string, number> | null,
): { decks: string[][]; opRunCount: () => number } {
  const decks: string[][] = []
  let pass = 0
  const rawSend = mock.send.bind(mock)
  mock.send = (command): void => {
    rawSend(command)
    if (command.type === 'loadCircuit') decks.push(command.deckLines)
    if (command.type === 'runOp') {
      pass += 1
      const thisPass = pass
      queueMicrotask(() => {
        const v = values(thisPass)
        if (v !== null) mock.emit({ type: 'opResult', values: v })
      })
    }
  }
  return { decks, opRunCount: () => pass }
}

describe('powerOn two-pass rail sensing (Task 5)', () => {
  it('runs a second op pass when a measured rail changes vHigh', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    seedSwitchedRailBoard(store)
    // /VGATED measures 12.6 V (upstream FET on) in both passes.
    const { decks, opRunCount } = autoRespond(mock, () => ({ vgated: 12.6, a: 5, b: 0 }))

    await store.getState().powerOn()

    expect(opRunCount()).toBe(2) // pass 1 + one conditional re-run
    // Pass-1 deck used the 12 V family default; pass-2 deck uses the measured swing.
    expect(decks[0].join('\n')).toContain('12.0000')
    expect(decks[1].join('\n')).toContain('12.6000')
    // The sensed rail is cached for transient reuse.
    expect(store.getState().measuredRails?.get(4)).toBeCloseTo(12.6)
    expect(store.getState().railNotes).toEqual([])
  })

  it('does NOT re-run when the measured rail equals the family default', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    seedSwitchedRailBoard(store)
    const { opRunCount } = autoRespond(mock, () => ({ vgated: 12.0, a: 5, b: 0 }))

    await store.getState().powerOn()

    // 12.0 == family default → deck unchanged (ignoring the provenance comment) → no pass 2.
    expect(opRunCount()).toBe(1)
    expect(store.getState().measuredRails?.get(4)).toBeCloseTo(12.0)
  })

  it('surfaces a gated-off warning and keeps the family default (no re-run)', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    seedSwitchedRailBoard(store)
    // /VGATED ~0 V: FET off → gated-off, below the rail floor.
    const { opRunCount } = autoRespond(mock, () => ({ vgated: 0.0, a: 5, b: 0 }))

    await store.getState().powerOn()

    expect(opRunCount()).toBe(1) // gated-off rail is not in `rails` → no re-run
    expect(store.getState().railNotes.map(n => n.kicadName)).toContain('/VGATED')
    expect(store.getState().railNotes[0].ref).toBe('U1')
    expect(store.getState().measuredRails?.has(4)).toBe(false)
  })

  it('falls back to the pass-1 voltages when the second op pass fails', async () => {
    vi.useFakeTimers()
    try {
      const mock = createMockSimClient()
      const store = createAppStore({ simClient: mock })
      seedSwitchedRailBoard(store)
      // Pass 1 measures 12.6 (triggers a re-run); pass 2 withholds its reply so
      // the 30 s waitFor rejects — powerOn must keep the pass-1 result.
      const { opRunCount } = autoRespond(mock, pass =>
        pass === 1 ? { vgated: 12.6, a: 5, b: 2.5 } : null,
      )

      const p = store.getState().powerOn()
      // Drain pass-1's microtask reply, then fire the pass-2 waitFor timeout.
      await vi.advanceTimersByTimeAsync(30_000)
      const opVoltages = await p

      expect(opRunCount()).toBe(2) // the re-run WAS attempted
      // Pass-2 never replied, so the committed voltages are the pass-1 result.
      const outNet = 2
      expect(opVoltages?.get(outNet)).toBeCloseTo(2.5)
      expect(store.getState().simState).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── Review fixes ──────────────────────────────────────────────────────────────

describe('sensed-rail cache invalidation (FIX 1)', () => {
  it('markDeckDirty clears measuredRails and railNotes (stale reference frame)', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    seedSwitchedRailBoard(store)
    autoRespond(mock, () => ({ vgated: 12.6, a: 5, b: 0 }))

    await store.getState().powerOn()
    expect(store.getState().measuredRails?.get(4)).toBeCloseTo(12.6)

    store.getState().markDeckDirty()
    expect(store.getState().measuredRails).toBeNull()
    expect(store.getState().railNotes).toEqual([])
  })

  it('a gated-off railNote is cleared by a deck-dirtying edit (setGround)', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    seedSwitchedRailBoard(store)
    autoRespond(mock, () => ({ vgated: 0.0, a: 5, b: 0 }))

    await store.getState().powerOn()
    expect(store.getState().railNotes.map(n => n.kicadName)).toContain('/VGATED')

    store.getState().setGround(5) // routes through markDeckDirty()
    expect(store.getState().railNotes).toEqual([])
    expect(store.getState().measuredRails).toBeNull()
  })
})

describe('powerOn is the sole committer for its own ops (FIX 2)', () => {
  it('never commits the interim pass-1 (family-default) result to the board', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    const board = makeBoardHooks()
    store.getState().setBoardHooks(board.hooks)
    seedSwitchedRailBoard(store)
    // Pass 1 (family default) reports OUT=1.0 and triggers a re-run (12.6 ≠ 12.0);
    // pass 2 (measured 12.6) reports the corrected OUT=2.0. The permanent
    // ingestEvent listener also receives pass-1's opResult — it must NOT push the
    // wrong interim value onto the board.
    autoRespond(mock, pass =>
      pass === 1 ? { vgated: 12.6, a: 5, b: 1.0 } : { vgated: 12.6, a: 5, b: 2.0 },
    )

    const opVoltages = await store.getState().powerOn()

    const OUT = 2
    // Final committed value is the pass-2 rail-corrected result.
    expect(opVoltages?.get(OUT)).toBeCloseTo(2.0)
    expect(store.getState().opVoltages?.get(OUT)).toBeCloseTo(2.0)
    // The interim pass-1 value (1.0) was NEVER applied to the board.
    expect(board.applied.length).toBeGreaterThan(0)
    for (const snap of board.applied) {
      expect(snap.get(OUT)).not.toBe(1.0)
    }
    expect(board.applied[board.applied.length - 1].get(OUT)).toBeCloseTo(2.0)
  })

  it('sets opCaveat from its own op method (moved off ingestEvent)', async () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    seedSwitchedRailBoard(store)
    // Single-pass op (measured == family default → no re-run) with a fallback method.
    const rawSend = mock.send.bind(mock)
    mock.send = (command): void => {
      rawSend(command)
      if (command.type === 'runOp') {
        queueMicrotask(() =>
          mock.emit({ type: 'opResult', values: { vgated: 12.0, a: 5, b: 0 }, method: 'gmin' }),
        )
      }
    }

    await store.getState().powerOn()

    expect(store.getState().opCaveat?.method).toBe('gmin')
  })
})
