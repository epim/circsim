/**
 * src/simhost/__tests__/diode-op-current.integration.test.ts
 *
 * Engine integration test (Spec §6.1, §7.2, §13) — LOCKS IN the OP glow data
 * source for First Light, and PINS a real ngspice-46 gotcha discovered here.
 *
 * Unlike the TRANSIENT stream (where a device-internal "@d1[i]" vector makes
 * ngspice's SendData dispatch skip the whole run — see led-current.integration.
 * test.ts), the OPERATING-POINT path reads vectors via ngGet_Vec_Info, so a
 * diode's forward current DOES read back. This test proves it against the REAL
 * libngspice with a current-limited LED deck.
 *
 * GOTCHA (load-bearing, ngspice 46): a diode's current is NOT carried by the
 * generic "@d1[i]" device vector. `.save @d1[i]` DOES make "@d1[i]" appear in the
 * plot's vector-name list, but ngGet_Vec_Info returns NO real data for it
 * (vectorData('@d1[i]') === undefined), so readPlotValues drops it. The diode's
 * forward current is instead exposed two ways that BOTH carry data:
 *   - the device parameter "@d1[id]"  (≈ +10.45 mA), and
 *   - the source branch current "i(v1)" / "v1#branch" (≈ −10.45 mA; this series
 *     circuit's source current equals the LED current).
 * This test asserts the current reads back finite and in the LED band (~5–12 mA)
 * via the working forms, and tripwires the empty "@d1[i]" slot — so if a future
 * ngspice makes "@d1[i]" carry data (which would let the store's per-device glow
 * lookup work directly), the `@d1[i]`-is-empty assertion starts failing and we
 * revisit the glow data source.
 *
 * Runs the REAL libngspice via koffi against the bundled resources for this
 * platform. Skipped automatically when resources/ngspice/<platform> is missing so
 * unit-only CI stays green. Wired into `npm run test:integration`.
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()

describe.skipIf(!haveNgspice)('SimHost op — diode forward current reads back (real libngspice)', () => {
  it('current-limited LED: diode forward current ~5-12 mA in OP', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (e) => events.push(e) })
    try {
      await host.start()

      // v1 vcc 0 5 / r1 vcc a 330 / d1 a 0 dled (.model dled d(is=1e-15 n=2)).
      // i ≈ (5 − Vf)/330 with Vf ≈ 1.55 V → ≈ 10.4 mA, comfortably in 5–12 mA.
      host.handleCommand({
        type: 'loadCircuit',
        deckLines: [
          '* current-limited LED — diode device current in OP',
          'v1 vcc 0 5',
          'r1 vcc a 330',
          'd1 a 0 dled',
          '.model dled d(is=1e-15 n=2)',
          '.save all @d1[i]',
          '.op',
          '.end',
        ],
      })
      const values = await host.runOp()

      // The op converged: node voltages came back, and node "a" sits at the diode
      // forward drop (~1.4–2.2 V), confirming forward conduction.
      expect(values['vcc']).toBeCloseTo(5, 3)
      expect(values['a']).toBeGreaterThan(1.4)
      expect(values['a']).toBeLessThan(2.4)

      // The forward current reads back finite and in the LED operating band. On
      // ngspice 46 the diode current is carried by the source branch "i(v1)"
      // (series circuit ⇒ source current == LED current), since the generic
      // "@d1[i]" device slot carries no data (pinned below).
      const branch = values['i(v1)']
      expect(branch, `op result keys: ${Object.keys(values).join(', ')}`).toBeDefined()
      const mag = Math.abs(branch)
      expect(Number.isFinite(mag)).toBe(true)
      expect(mag).toBeGreaterThan(5e-3)
      expect(mag).toBeLessThan(12e-3)

      // Cross-check the device-parameter form that DOES carry the diode current:
      // "@d1[id]" (not "@d1[i]"). Read it straight off the engine plot.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eng = (host as any).engine
      const plot = eng.currentPlot()
      const namesInPlot: string[] = eng.allVectors(plot)
      // "@d1[i]" is ANNOUNCED in the plot name list...
      expect(namesInPlot).toContain('@d1[i]')
      // ...but carries NO real data (the documented gotcha → readPlotValues skips
      // it, so it never appears in the normalized op result).
      expect(eng.vectorData('@d1[i]')).toBeUndefined()
      expect(Object.keys(values)).not.toContain('i(d1)')
      // The diode current IS available under "@d1[id]", matching i(v1)'s magnitude.
      const idData: Float64Array | undefined = eng.vectorData('@d1[id]')
      expect(idData, '@d1[id] (diode device current) not present').toBeDefined()
      const id = Math.abs(idData![idData!.length - 1])
      expect(id).toBeGreaterThan(5e-3)
      expect(id).toBeLessThan(12e-3)
      expect(id).toBeCloseTo(mag, 4)

      const opEvent = events.find((e) => e.type === 'opResult')
      expect(opEvent).toBeDefined()
    } finally {
      await host.dispose()
    }
  }, 30_000)
})
