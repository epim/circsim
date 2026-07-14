/**
 * railSensing.test.ts — op-informed rail sensing (Tasks 4 + 5)
 *
 * Store-level coverage for the digital rail-voltage precedence work:
 *   Task 4 — railOverrides state (kicadName→volts), setRailOverride /
 *            clearRailOverride actions, and railOverrideNetMap() resolution.
 *   Task 5 — powerOn's conditional two-pass op orchestration (added below).
 */

import { describe, it, expect } from 'vitest'
import { createAppStore, type AppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Circuit } from '../../../../core/netlist/extract'

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
