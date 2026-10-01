/**
 * The bundled discrete cards are the output of scripts/fit-model-cards.mjs
 * (issue #14): this test fails when a .model card in bjt.lib, diodes.lib or
 * led.lib drifts from what the script derives from its datasheet inputs, so the
 * "derived from datasheet parameters" statement in the file headers stays true.
 *
 * Pure Node, no ngspice. The simulated checks against the datasheet points are
 * the characterization rows (npm run test:characterization).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ASSUMPTIONS, deriveCards } from '../../../../scripts/fit-model-cards.mjs'

import { parseModelCards } from './spiceCards'

const MODELS_DIR = join(process.cwd(), 'resources', 'models')
const FILES = ['bjt.lib', 'diodes.lib', 'led.lib']

/** The lib prints three significant figures, so allow 0.6 percent. */
const TOL = 0.006

const bundled = new Map(
  FILES.flatMap((f) => parseModelCards(f, readFileSync(join(MODELS_DIR, f), 'utf8'))).map(
    (c) => [c.name, c] as const
  )
)
const derived = deriveCards()

describe('bundled discrete cards match scripts/fit-model-cards.mjs', () => {
  it('derives at least the BJT, diode, TVS and LED cards', () => {
    for (const n of [
      'Q2N2222',
      'Q2N3904',
      'Q2N3906',
      'QBC547',
      'QBC557',
      'D1N4148',
      'D1N4001',
      'D1N5819',
      'DSMAJ24A_F',
      'DSMAJ24A_B',
      'DSMAJ24A_Z',
      'LED_RED',
      'LED_GREEN',
      'LED_BLUE',
      'LED_WHITE'
    ]) {
      expect(Object.keys(derived), n).toContain(n)
    }
  })

  it.each(Object.entries(derived))('%s parameters equal the derived card', (name, card) => {
    const lib = bundled.get(name)
    expect(lib, `${name} must exist in the bundled libs`).toBeDefined()
    expect(lib!.type).toBe(card.type.toLowerCase())
    expect(Object.keys(lib!.params).sort()).toEqual(Object.keys(card.params).sort())
    for (const [k, v] of Object.entries(card.params)) {
      const got = lib!.params[k]
      const tol = TOL * Math.max(Math.abs(v), Math.abs(got))
      expect(Math.abs(got - v), `${name}.${k}: lib ${got} vs derived ${v}`).toBeLessThanOrEqual(tol)
    }
  })

  it('lists its non-datasheet assumptions', () => {
    expect(Object.keys(ASSUMPTIONS).length).toBeGreaterThan(5)
  })
})
