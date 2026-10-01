/**
 * src/simhost/__tests__/deckGate.integration.test.ts
 *
 * Issue #35 end to end against REAL bundled ngspice: a hostile user model (a
 * `.control` block inside its `.subckt`) bound to a part flows through
 * generateDeck into the deck, and SimHost must refuse to load it.
 *
 * The control block only echoes a marker; nothing spawns a shell. The first
 * test is the positive control: the same deck pushed straight at the engine
 * (bypassing the gate) DOES execute the block, so the assertions that the
 * gated path does not are meaningful. Skipped when resources/ngspice/<platform>
 * is missing.
 */

import { describe, expect, it } from 'vitest'

import { generateDeck } from '../../core/spicegen/generate'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import type { Resolution } from '../../core/models/types'
import type { SpiceEngine } from '../engine'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
const MARKER = 'COUNCIL_MARKER_EXECUTED'

const EVIL_MODEL = [
  '.subckt evil a b',
  '.control',
  `echo ${MARKER}`,
  '.endc',
  'r1 a b 1000',
  '.ends'
].join('\n')

function hostileDeck(): string[] {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
    { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [] }
  ]
  const u1: Part = {
    ref: 'U1',
    value: 'EVIL',
    libId: 'User:EVIL',
    layer: 'F',
    padNet: new Map([
      ['1', 1],
      ['2', 2]
    ]),
    properties: {}
  }
  const circuit: Circuit = { nets, parts: [u1], warnings: [] }
  const resolutions: Resolution[] = [
    {
      ref: 'U1',
      status: 'ok',
      tier: 4,
      warnings: [],
      model: {
        kind: 'subckt',
        libFile: '__user_model__:EVIL',
        subcktName: 'evil',
        pinMap: { '1': 'a', '2': 'b' }
      }
    }
  ]
  return generateDeck({
    circuit,
    resolutions,
    instruments: [
      { kind: 'ground-ref', netId: 2 },
      { kind: 'dc-supply', id: 'v1', netId: 1, volts: 5, seriesOhms: 0.1 }
    ],
    groundNetId: 2,
    modelTexts: { '__user_model__:EVIL': EVIL_MODEL }
  })
}

function logTexts(events: SimEvent[], level?: 'info' | 'warn' | 'error'): string[] {
  return events
    .filter((e): e is Extract<SimEvent, { type: 'log' }> => e.type === 'log')
    .filter((e) => (level ? e.level === level : true))
    .map((e) => e.text)
}

describe.skipIf(!haveNgspice)('deck gate against real ngspice (hostile user model)', () => {
  it('the generated deck really contains the control block (the exposure)', () => {
    const deck = hostileDeck()
    expect(deck).toContain('.control')
    expect(deck).toContain(`echo ${MARKER}`)
  })

  it('positive control: the raw engine executes the block, the gated host does not', async () => {
    const deck = hostileDeck()
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
    try {
      await host.start()

      // Gated path first: refused, nothing executes.
      host.handleCommand({ type: 'loadCircuit', deckLines: deck })
      await host.whenIdle()
      expect(logTexts(events).filter((t) => t.includes(MARKER) && !t.includes('rejected'))).toEqual([])
      const errors = logTexts(events, 'error')
      expect(errors.some((t) => /deck rejected/.test(t) && /\.control/.test(t))).toBe(true)
      await expect(host.loadCircuit(deck)).rejects.toThrow(/deck rejected/)

      // Ungated path (engine directly, as SimHost did before the gate): executes.
      events.length = 0
      const engine = (host as unknown as { engine: SpiceEngine }).engine
      engine.loadCircuit(deck)
      await engine.command('destroy all', false)
      await new Promise((r) => setTimeout(r, 50))
      expect(logTexts(events).some((t) => t.includes(MARKER))).toBe(true)
    } finally {
      await host.dispose()
    }
  }, 60_000)

  it('a clean deck still loads and solves after a refused one', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
    try {
      await host.start()
      await expect(host.loadCircuit(hostileDeck())).rejects.toThrow(/deck rejected/)
      await host.loadCircuit(['* divider', 'v1 in 0 dc 5', 'r1 in out 1k', 'r2 out 0 1k', '.end'])
      const op = await host.runOp()
      expect(op.out).toBeCloseTo(2.5, 6)
      expect(logTexts(events).some((t) => t.includes(MARKER) && !t.includes('rejected'))).toBe(false)
    } finally {
      await host.dispose()
    }
  }, 60_000)
})
