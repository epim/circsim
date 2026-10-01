/**
 * core/critic/__tests__/supplyEntries.test.ts
 *
 * buildSupplyEntries turns the bench (instruments + lead positions) into the
 * critic's supply entries (issue #47).
 */

import { describe, it, expect } from 'vitest'
import { buildSupplyEntries } from '../supplyEntries'
import { GROUND_LEAD_KEY } from '../../persist/sidecar'
import type { Instrument } from '../../spicegen/instruments'

const psu = (id: string, netId: number): Instrument => ({ kind: 'dc-supply', id, netId, volts: 5, seriesOhms: 0.1 })

describe('buildSupplyEntries', () => {
  it('pairs each wired dc-supply with the position its net lead was clipped at', () => {
    const entries = buildSupplyEntries(
      [psu('p1', 3), psu('p2', 4)],
      new Map([['p1:net', { x: 10.5, y: -2 }]]),
      null,
    )
    expect(entries).toEqual([{ netId: 3, pos: { x: 10.5, y: -2 } }, { netId: 4 }])
  })

  it('skips an unwired supply and instruments that are not supplies', () => {
    const entries = buildSupplyEntries(
      [psu('p1', -1), { kind: 'voltage-probe', id: 'v1', netId: 3, color: '#fff' }],
      new Map([['v1:net', { x: 1, y: 1 }]]),
      null,
    )
    expect(entries).toEqual([])
  })

  it('adds the ground clip, with its position when recorded', () => {
    expect(buildSupplyEntries([], new Map([[GROUND_LEAD_KEY, { x: 1, y: 2 }]]), 7)).toEqual([
      { netId: 7, pos: { x: 1, y: 2 } },
    ])
    expect(buildSupplyEntries([], new Map(), 7)).toEqual([{ netId: 7 }])
  })
})
