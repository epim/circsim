/**
 * liveGlow.test.ts — L1b: live-transient LED glow
 *
 * Unit tests for the live glow path: during a transient run, each `samples`
 * batch carries the LED sense-ammeter branch current (`vsense_<ref>`, spliced
 * by the deck generator — see ledSenseName), and the store must drive the SAME
 * glow path the op result uses (currentsByRef + boardHooks.applyLedCurrents)
 * from the batch's NEWEST timepoint. Driven by an INJECTED mock simClient
 * (no Electron / ngspice); the bundled resources/sample/first-light.kicad_pcb
 * (VIN → R1 → D1 → GND) is the live fixture.
 *
 * GOTCHA under test (from led-current.integration.test.ts): unlike op results,
 * transient sample vector names are NOT normalized — the batch carries ngspice's
 * RAW names ("vsense_d1#branch"), never the canonical "i(vsense_d1)". The
 * mapping must accept both spellings, case-insensitively.
 *
 * Covered:
 *   - mapVectorNameToLedRef: raw #branch form, normalized i(...) form, mixed
 *     case, non-LED vectors (v(out), a supply's branch current, …) → null
 *   - samples batch with a vsense column → currentsByRef updated from the LAST
 *     row + applyLedCurrents driven with the same map (magnitude, like the op path)
 *   - samples batch with NO vsense column → currentsByRef untouched (same
 *     reference) and the glow path not driven
 *   - successive batches blink the LED on/off (the 555 blinker cadence)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createAppStore,
  mapVectorNameToLedRef,
  type AppStore,
  type BoardHooks,
} from '../appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'

const sampleDir = join(__dirname, '../../../../../resources/sample')
const firstLight = readFileSync(join(sampleDir, 'first-light.kicad_pcb'), 'utf-8')

// ─── pure helper ─────────────────────────────────────────────────────────────────

describe('mapVectorNameToLedRef — LED sense-ammeter vector name → part ref', () => {
  it('maps the RAW transient spelling vsense_<ref>#branch (transient names are not normalized)', () => {
    expect(mapVectorNameToLedRef('vsense_d1#branch')).toBe('D1')
    expect(mapVectorNameToLedRef('vsense_d12#branch')).toBe('D12')
  })

  it('maps the normalized op spelling i(vsense_<ref>)', () => {
    expect(mapVectorNameToLedRef('i(vsense_d1)')).toBe('D1')
  })

  it('is case-insensitive (ngspice vector-name casing is not guaranteed)', () => {
    expect(mapVectorNameToLedRef('VSENSE_D1#BRANCH')).toBe('D1')
    expect(mapVectorNameToLedRef('I(Vsense_D2)')).toBe('D2')
  })

  it('returns null for vectors that are not an LED sense-ammeter current', () => {
    expect(mapVectorNameToLedRef('v(out)')).toBeNull() // node voltage
    expect(mapVectorNameToLedRef('out')).toBeNull() // bare node voltage
    expect(mapVectorNameToLedRef('time')).toBeNull() // scale vector
    expect(mapVectorNameToLedRef('vpsu_psu1#branch')).toBeNull() // supply, not an LED ammeter
    expect(mapVectorNameToLedRef('vsense_d1')).toBeNull() // bare NODE name = a voltage, not a current
  })
})

// ─── store integration (first-light sample) ──────────────────────────────────────

/** Board-hook spy that records every applyLedCurrents call (the glow path). */
function makeGlowHooks(): { hooks: BoardHooks; ledCalls: Map<string, number>[] } {
  const ledCalls: Map<string, number>[] = []
  return {
    ledCalls,
    hooks: {
      applyNetVoltages() {},
      showOpAnnotations() {},
      applyLedCurrents(currentsByRef) {
        ledCalls.push(new Map(currentsByRef))
      },
    },
  }
}

describe('live transient LED glow — samples batches drive currentsByRef + the glow path', () => {
  let store: AppStore
  let mock: MockSimClient
  let glow: ReturnType<typeof makeGlowHooks>

  beforeEach(() => {
    mock = createMockSimClient()
    glow = makeGlowHooks()
    store = createAppStore({ simClient: mock })
    store.getState().setBoardHooks(glow.hooks)
    store.getState().openBoardFromText(firstLight, 'first-light.kicad_pcb')
    // The open flow auto-attaches a supply on VIN + designates ground, so Run is live.
    store.getState().run()
    expect(store.getState().simState).toBe('running')
  })

  it('updates currentsByRef from the LAST row (newest timepoint) and drives applyLedCurrents', () => {
    mock.emit({ type: 'vectors', names: ['time', 'vin', 'vsense_d1#branch'] })
    mock.emit({
      type: 'samples',
      vectorNames: ['vin', 'vsense_d1#branch'],
      columns: [new Float64Array([5, 5, 5]), new Float64Array([0.002, 0.005, 0.009])],
      simTime: new Float64Array([0, 1e-6, 2e-6]),
    })
    // The newest timepoint (0.009 A) won — not the first or an intermediate row.
    expect(store.getState().currentsByRef.get('D1')).toBeCloseTo(0.009, 9)
    // The SAME glow path the op result uses was driven with that map.
    expect(glow.ledCalls.length).toBeGreaterThan(0)
    const last = glow.ledCalls[glow.ledCalls.length - 1]
    expect(last.get('D1')).toBeCloseTo(0.009, 9)
  })

  it('stores the current MAGNITUDE (sign only reflects ammeter wiring), like the op path', () => {
    mock.emit({
      type: 'samples',
      vectorNames: ['vsense_d1#branch'],
      columns: [new Float64Array([-0.004, -0.008])],
      simTime: new Float64Array([0, 1e-6]),
    })
    expect(store.getState().currentsByRef.get('D1')).toBeCloseTo(0.008, 9)
  })

  it('a batch with NO vsense columns leaves currentsByRef untouched and skips the glow path', () => {
    // Seed a current first (as an earlier batch would).
    mock.emit({
      type: 'samples',
      vectorNames: ['vsense_d1#branch'],
      columns: [new Float64Array([0.009])],
      simTime: new Float64Array([0]),
    })
    const seeded = store.getState().currentsByRef
    const glowCallsAfterSeed = glow.ledCalls.length

    mock.emit({
      type: 'samples',
      vectorNames: ['vin'],
      columns: [new Float64Array([5, 5])],
      simTime: new Float64Array([1e-6, 2e-6]),
    })
    // Same Map REFERENCE — the current/glow path was not touched at all.
    expect(store.getState().currentsByRef).toBe(seeded)
    expect(glow.ledCalls.length).toBe(glowCallsAfterSeed)
  })

  it('blinks live: successive batches drive the glow on (mA) then off (~0)', () => {
    mock.emit({
      type: 'samples',
      vectorNames: ['vsense_d1#branch'],
      columns: [new Float64Array([0.009])],
      simTime: new Float64Array([0]),
    })
    expect(store.getState().currentsByRef.get('D1')).toBeCloseTo(0.009, 9)

    mock.emit({
      type: 'samples',
      vectorNames: ['vsense_d1#branch'],
      columns: [new Float64Array([1e-9])],
      simTime: new Float64Array([1e-3]),
    })
    expect(store.getState().currentsByRef.get('D1')).toBeCloseTo(1e-9, 12)
  })
})
