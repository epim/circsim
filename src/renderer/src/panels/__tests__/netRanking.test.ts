/**
 * netRanking.test.ts: ranked supply / ground pickers (issue #72).
 *
 * The supply picker and the "Change..." ground quick-picks used to list nets in
 * board order (`allNets.map`, `.slice(0, 4)`), which on a few-hundred-net board
 * buries the power net. These rank by the same evidence the open-time heuristics
 * use, then by pad degree.
 */

import { describe, it, expect } from 'vitest'
import type { CircuitNet } from '../../../../core/netlist/extract'
import {
  rankSupplyCandidates,
  rankGroundCandidates,
  filterNets,
  MAX_PICKER_ROWS,
} from '../netRanking'

function net(id: number, kicadName: string, degree = 0): CircuitNet {
  return {
    id,
    kicadName,
    spiceNode: `n${id}`,
    padRefs: Array.from({ length: degree }, (_, i) => ({ ref: `X${id}_${i}`, pad: '1' })),
  }
}

describe('rankSupplyCandidates', () => {
  const nets = [
    net(0, '', 0),
    net(1, '/sig/A', 2),
    net(2, '/sig/BIG', 40),
    net(3, 'GND', 90),
    net(4, '+5V', 12),
    net(5, '/VBUS_C', 8),
    net(6, '/sig/B', 3),
    net(7, 'VCC', 30),
  ]

  it('puts suggestSupplies candidates first, in their ranking (full-name before partial)', () => {
    const ranked = rankSupplyCandidates(nets, 3).map(n => n.kicadName)
    // VCC (30 pads) outranks +5V (12 pads) on pad degree; /VBUS_C is partial evidence.
    expect(ranked.slice(0, 3)).toEqual(['VCC', '+5V', '/VBUS_C'])
  })

  it('then the rest by pad degree, descending', () => {
    const ranked = rankSupplyCandidates(nets, 3).map(n => n.kicadName)
    expect(ranked.slice(3)).toEqual(['/sig/BIG', '/sig/B', '/sig/A'])
  })

  it('never lists the ground net, the SPICE node 0 placeholder, or unnamed nets', () => {
    const ranked = rankSupplyCandidates(nets, 3)
    expect(ranked.map(n => n.id)).not.toContain(3)
    expect(ranked.map(n => n.id)).not.toContain(0)
    expect(ranked).toHaveLength(6)
  })

  it('with no ground set, a ground-named net is simply not a supply suggestion', () => {
    const ranked = rankSupplyCandidates(nets, null).map(n => n.kicadName)
    // GND is still listed (it is a net) but sorts by pad degree among the non-suggestions.
    expect(ranked.slice(0, 3)).toEqual(['VCC', '+5V', '/VBUS_C'])
    expect(ranked).toContain('GND')
  })
})

describe('rankGroundCandidates', () => {
  const nets = [
    net(1, '/sig/A', 50),
    net(2, 'AGND', 4),
    net(3, 'GND', 90),
    net(4, '/sig/B', 20),
    net(5, '/Power/VSS', 6),
  ]

  it('ground-named nets come first, by pad degree, then everything else by pad degree', () => {
    const ranked = rankGroundCandidates(nets, null).map(n => n.kicadName)
    expect(ranked).toEqual(['GND', '/Power/VSS', 'AGND', '/sig/A', '/sig/B'])
  })

  it('excludes the current ground', () => {
    const ranked = rankGroundCandidates(nets, 3).map(n => n.kicadName)
    expect(ranked[0]).toBe('/Power/VSS')
    expect(ranked).not.toContain('GND')
  })
})

describe('filterNets', () => {
  const nets = [net(1, '+5V'), net(2, '/Power/VBUS'), net(3, 'GND')]

  it('is a case-insensitive substring match on the net name', () => {
    expect(filterNets(nets, 'vbus').map(n => n.id)).toEqual([2])
    expect(filterNets(nets, '5V').map(n => n.id)).toEqual([1])
  })

  it('a blank query returns everything', () => {
    expect(filterNets(nets, '  ')).toHaveLength(3)
  })
})

describe('MAX_PICKER_ROWS', () => {
  it('is a sane cap for a 240 px dock', () => {
    expect(MAX_PICKER_ROWS).toBeGreaterThanOrEqual(20)
    expect(MAX_PICKER_ROWS).toBeLessThanOrEqual(100)
  })
})
