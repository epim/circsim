/**
 * src/simhost/__tests__/formatSpiceValue.integration.test.ts
 *
 * Property test against the real libngspice (issue #67): every number that
 * formatSpiceValue can emit is accepted by ngspice AND read back as the same
 * value. Resistor values are sampled across the full range the formatter
 * handles (exponent form below 1 mOhm, plain decimal in the middle) and each
 * one is driven by its own 1 V source, so i(v_k) = -1/R_k reveals how ngspice
 * parsed the card text.
 *
 * Wired into `npm run test:integration`; skipped when no ngspice is bundled.
 */

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { formatSpiceValue } from '../../core/spicegen/generate'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()

async function op(deck: string[]): Promise<{ errs: string[]; v: Record<string, number> }> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    const v = await host.runOp()
    const errs = (
      events.filter((e) => e.type === 'log' && e.level === 'error') as Extract<
        SimEvent,
        { type: 'log' }
      >[]
    ).map((e) => e.text)
    return { errs, v }
  } finally {
    await host.dispose()
  }
}

describe.skipIf(!haveNgspice)('formatSpiceValue output is accepted and read back by ngspice', () => {
  it('sampled resistor values across 1e-6..1e8 ohm parse to the intended value', async () => {
    const values = fc.sample(
      fc.oneof(
        fc.double({ min: 1e-6, max: 0.000999, noNaN: true }),
        fc.double({ min: 0.001, max: 1e8, noNaN: true }),
        fc.integer({ min: 1, max: 999_999 })
      ),
      { numRuns: 120, seed: 20260929 }
    )
    const deck = ['* formatSpiceValue round trip through ngspice']
    const emitted: string[] = []
    values.forEach((val, k) => {
      const text = formatSpiceValue(val)
      emitted.push(text)
      deck.push(`v${k} n${k} 0 DC 1`, `r${k} n${k} 0 ${text}`)
    })
    deck.push('.op', '.end')

    const { errs, v } = await op(deck)
    expect(errs).toEqual([])
    const bad: string[] = []
    values.forEach((val, k) => {
      const amps = -v[`i(v${k})`]
      const got = 1 / amps
      if (!(Math.abs(got - val) / val < 1e-6)) bad.push(`${emitted[k]} -> ${got} (want ${val})`)
    })
    expect(bad, bad.join('\n')).toEqual([])
  }, 60_000)

  it('every emitted string is plain decimal or d.ddde[+-]dd, with no locale or NaN forms', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: 1e-15, max: 1e12, noNaN: true }),
          fc.integer({ min: 1, max: 1_000_000_000 })
        ),
        (val) => {
          expect(formatSpiceValue(val)).toMatch(/^-?\d+(\.\d+)?(e[+-]\d{2,3})?$/)
        }
      ),
      { numRuns: 1000 }
    )
  })
})
