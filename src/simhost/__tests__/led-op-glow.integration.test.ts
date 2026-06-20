/**
 * src/simhost/__tests__/led-op-glow.integration.test.ts
 *
 * Engine integration test (Spec §6.1, §7.2, §13) — LOCKS IN the First Light LED
 * GLOW DATA SOURCE end-to-end: the deck the REAL generator now emits for an LED
 * carries the LED current back from a real OP solve.
 *
 * ROOT CAUSE this guards (proven in diode-op-current.integration.test.ts): on
 * ngspice 46 a diode's `@d_<ref>[i]` vector is announced but carries NO DATA, so
 * the LED current never reached currentsByRef and LEDs never glowed. THE FIX is a
 * 0 V series ammeter `vsense_<ref>` spliced on each LED's anode — an ideal ammeter
 * with no circuit effect whose branch current reads back via the WORKING
 * source-branch path in OP (`i(vsense_<ref>)`), uniform with the transient stream.
 *
 * This test builds a current-limited LED circuit THROUGH the real deck generator
 * (generateDeck on a one-LED Circuit), runs the OP on the REAL libngspice, and
 * asserts the ammeter branch `i(vsense_d1)` reads back finite ~5–12 mA. If the
 * glow data source ever stops carrying current, this fails.
 *
 * Runs the REAL libngspice via koffi against the bundled resources for this
 * platform. Skipped automatically when resources/ngspice/<platform> is missing so
 * unit-only CI stays green. Wired into `npm run test:integration`.
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'
import { generateDeck } from '../../core/spicegen/generate'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import type { Resolution } from '../../core/models/types'
import type { Instrument } from '../../core/spicegen/instruments'

const haveNgspice = ngspiceResourcesAvailable()

/** A current-limited one-LED circuit: VIN → R1(330Ω) → D1(LED) → GND. */
function makeLedCircuit(): Circuit {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
    { id: 2, kicadName: 'LEDA', spiceNode: 'leda', padRefs: [] },
    { id: 3, kicadName: 'GND', spiceNode: '0', padRefs: [] },
  ]
  const r1: Part = {
    ref: 'R1', value: '330', libId: 'Resistor_SMD:R_0805_2012Metric', layer: 'F',
    padNet: new Map([['1', 1], ['2', 2]]),
    properties: {},
  }
  // pinMap {1:"2",2:"1"} → anode (positional 1) = pad with value "1" = pad2 = LEDA;
  // cathode (positional 2) = pad with value "2" = pad1 = GND. So the LED conducts
  // VIN→R1→LEDA(anode)→D1→GND(cathode).
  const d1: Part = {
    ref: 'D1', value: 'LED', libId: 'LED:LED_0805', layer: 'F',
    padNet: new Map([['1', 3], ['2', 2]]),
    properties: {},
  }
  return { nets, parts: [r1, d1], warnings: [] }
}

function makeResolutions(): Resolution[] {
  return [
    {
      ref: 'R1', status: 'ok', tier: 2, warnings: [],
      model: { kind: 'primitive', card: 'r_r1 vin leda 330' },
    },
    {
      ref: 'D1', status: 'ok', tier: 3, warnings: [],
      model: { kind: 'subckt', libFile: 'led.lib', subcktName: 'LED_RED', pinMap: { '1': '2', '2': '1' } },
    },
  ]
}

// A simple red-LED diode model card. is/n chosen so (5 − Vf)/330 lands ~10 mA.
const LED_LIB = [
  '* led.lib',
  '.model LED_RED D(is=1e-15 n=2 rs=2.0 eg=1.9)',
].join('\n')

describe.skipIf(!haveNgspice)('SimHost op — LED ammeter glow source reads back (real libngspice)', () => {
  it('current-limited LED through generateDeck: i(vsense_d1) ~5-12 mA in OP', async () => {
    const circuit = makeLedCircuit()
    const deckBody = generateDeck({
      circuit,
      resolutions: makeResolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 3 },
        { kind: 'dc-supply', id: 'psu1', netId: 1, volts: 5, seriesOhms: 0.1 },
      ] as Instrument[],
      groundNetId: 3,
      modelTexts: { 'led.lib': LED_LIB },
      title: 'first-light LED op glow',
    })

    // Sanity: the generator emitted the spliced ammeter + diode + the targeted save.
    expect(deckBody.some(l => /^vsense_d1\s+leda\s+leda__ledsense_d1\s+DC 0$/.test(l))).toBe(true)
    expect(deckBody.some(l => /^d_d1\s+leda__ledsense_d1\s+0\s+LED_RED$/.test(l))).toBe(true)
    expect(deckBody).toContain('.save i(vsense_d1)')

    // generateDeck emits no .op card (SimHost issues the analysis); splice one in
    // before .end so the loaded deck self-solves the operating point.
    const endIdx = deckBody.lastIndexOf('.end')
    const deckLines = endIdx >= 0
      ? [...deckBody.slice(0, endIdx), '.op', '.end']
      : [...deckBody, '.op', '.end']

    const events: SimEvent[] = []
    const host = new SimHost({ emit: (e) => events.push(e) })
    try {
      await host.start()
      host.handleCommand({ type: 'loadCircuit', deckLines })
      const values = await host.runOp()

      // OP converged: VIN at the rail, LEDA at the diode forward drop (~1.4–2.2 V).
      expect(values['vin']).toBeCloseTo(5, 2)
      expect(values['leda']).toBeGreaterThan(1.3)
      expect(values['leda']).toBeLessThan(2.4)

      // The glow data source: the 0 V ammeter's branch current reads back finite
      // and in the LED operating band (~5–12 mA). normalizeVectorKey turns
      // "vsense_d1#branch" → "i(vsense_d1)".
      const branch = values['i(vsense_d1)']
      expect(branch, `op result keys: ${Object.keys(values).join(', ')}`).toBeDefined()
      const mag = Math.abs(branch)
      expect(Number.isFinite(mag)).toBe(true)
      expect(mag).toBeGreaterThan(5e-3)
      expect(mag).toBeLessThan(12e-3)

      const opEvent = events.find((e) => e.type === 'opResult')
      expect(opEvent).toBeDefined()
    } finally {
      host.dispose()
    }
  }, 30_000)
})
