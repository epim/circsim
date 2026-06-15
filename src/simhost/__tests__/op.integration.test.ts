/**
 * src/simhost/__tests__/op.integration.test.ts
 *
 * SimHost integration test (Task 9 / Spec §6.1, §7.1, §7.2, §13).
 *
 * Runs the REAL libngspice via koffi against the bundled resources for this
 * platform. Skipped automatically when resources/ngspice/<platform> is missing
 * so unit-only CI environments stay green. Wired into `npm run test:integration`.
 *
 * Asserts:
 *   - the XSPICE .cm startup smoke check passes (final v(out) ≥ 4.5) — proves the
 *     code models loaded.
 *   - the RC divider deck → runOp → opResult.values["out"] ≈ 2.5 (±1 %),
 *     values["vin"] ≈ 5, with keys in the bare-lowercase normalized form
 *     ("out"/"vin", never "v(out)"/"OUT").
 *   - the source branch current is keyed "i(v1)" per the normalization rule.
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()

describe.skipIf(!haveNgspice)('SimHost op analysis (real libngspice)', () => {
  it('startup smoke check passes (XSPICE .cm models loaded)', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (e) => events.push(e) })
    try {
      host['engine'].init()
      const passed = await host.runStartupSmokeCheck()
      expect(passed).toBe(true)
    } finally {
      host.dispose()
    }
  }, 30_000)

  it('RC divider: opResult.values["out"] ≈ 2.5, ["vin"] ≈ 5', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (e) => events.push(e) })
    try {
      await host.start()

      host.handleCommand({
        type: 'loadCircuit',
        deckLines: ['* rc divider', 'v1 vin 0 dc 5', 'r1 vin out 10k', 'r2 out 0 10k', '.op', '.end']
      })
      const values = await host.runOp()

      // Keys must be bare lowercase node names (normalization rule, Spec §6.1).
      expect(Object.keys(values)).toContain('out')
      expect(Object.keys(values)).toContain('vin')
      expect(Object.keys(values)).not.toContain('v(out)')
      expect(Object.keys(values)).not.toContain('OUT')

      // RC voltage divider: 10k/10k from 5 V → 2.5 V at "out".
      expect(values['out']).toBeCloseTo(2.5, 2) // within 0.005 V (<1%)
      expect(values['vin']).toBeCloseTo(5.0, 2)

      // Source branch current normalized to i(v1) (5V/20k = 0.25 mA, sign-dependent).
      expect(Object.keys(values)).toContain('i(v1)')
      expect(Math.abs(values['i(v1)'])).toBeCloseTo(0.00025, 6)

      // opResult must also have been emitted on the event channel.
      const opEvent = events.find((e) => e.type === 'opResult')
      expect(opEvent).toBeDefined()
    } finally {
      host.dispose()
    }
  }, 30_000)
})

describe('SimHost protocol normalization (no engine)', () => {
  it('skip note when ngspice resources are absent', () => {
    // This test documents the skip behavior; it always runs.
    expect(typeof haveNgspice).toBe('boolean')
  })
})
