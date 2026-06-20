/**
 * criticOverlay.test.ts
 *
 * Headless tests for the critic marker-placement helper:
 *   - board-mm → world via kicadToWorld (y flips)
 *   - one marker per LOCATED finding (un-located findings skipped)
 *   - severity → color mapping (red / amber / grey)
 *   - deterministic order (findings order preserved)
 *
 * Pure math — no WebGL context needed.
 */

import { describe, it, expect } from 'vitest'
import {
  criticMarkerPlacements,
  createCriticOverlayController,
  SEVERITY_COLOR,
  MARKER_Z_LIFT,
  severityCssColor,
} from '../criticOverlay'
import { kicadToWorld } from '../boardGeometry'
import type { Finding } from '../../../../core/critic/types'

function finding(partial: Partial<Finding> & { id: string }): Finding {
  return {
    check: 'floating',
    severity: 'warn',
    title: 't',
    detail: 'd',
    ...partial,
  } as Finding
}

describe('criticMarkerPlacements', () => {
  it('maps board-mm location → world via kicadToWorld (Y flips)', () => {
    const f = finding({ id: 'x', location: { x: 12, y: 34 } })
    const [m] = criticMarkerPlacements([f])
    const expected = kicadToWorld(12, 34)
    expect(m.world.x).toBeCloseTo(expected.x)
    expect(m.world.y).toBeCloseTo(expected.y)
    // Y is flipped by the canonical transform.
    expect(m.world.x).toBeCloseTo(12)
    expect(m.world.y).toBeCloseTo(-34)
  })

  it('emits one marker per LOCATED finding, skipping those without a location', () => {
    const findings = [
      finding({ id: 'a', location: { x: 1, y: 2 } }),
      finding({ id: 'b' }), // no location → skipped
      finding({ id: 'c', location: { x: 3, y: 4 } }),
    ]
    const placements = criticMarkerPlacements(findings)
    expect(placements.map(p => p.id)).toEqual(['a', 'c'])
  })

  it('preserves findings order (deterministic)', () => {
    const findings = [
      finding({ id: 'z', location: { x: 0, y: 0 } }),
      finding({ id: 'm', location: { x: 0, y: 0 } }),
      finding({ id: 'a', location: { x: 0, y: 0 } }),
    ]
    expect(criticMarkerPlacements(findings).map(p => p.id)).toEqual(['z', 'm', 'a'])
  })

  it('colors markers by severity (error=red, warn=amber, info=grey)', () => {
    const findings = [
      finding({ id: 'e', severity: 'error', location: { x: 0, y: 0 } }),
      finding({ id: 'w', severity: 'warn', location: { x: 0, y: 0 } }),
      finding({ id: 'i', severity: 'info', location: { x: 0, y: 0 } }),
    ]
    const byId = new Map(criticMarkerPlacements(findings).map(p => [p.id, p]))
    expect(byId.get('e')!.color).toBe(SEVERITY_COLOR.error)
    expect(byId.get('w')!.color).toBe(SEVERITY_COLOR.warn)
    expect(byId.get('i')!.color).toBe(SEVERITY_COLOR.info)
    // distinct colors
    expect(new Set([byId.get('e')!.color, byId.get('w')!.color, byId.get('i')!.color]).size).toBe(3)
  })

  it('severityCssColor renders a 6-digit hex string', () => {
    expect(severityCssColor('error')).toMatch(/^#[0-9a-f]{6}$/)
    expect(severityCssColor('info')).toBe('#9aa0aa')
  })

  it('returns no markers for an all-unlocated report', () => {
    expect(criticMarkerPlacements([finding({ id: 'a' }), finding({ id: 'b' })])).toEqual([])
  })
})

describe('createCriticOverlayController — markers survive a board reload', () => {
  // Regression (HIGH): on board open the store pushes findings (setCriticFindings)
  // BEFORE the viewport's loadBoard runs; loadBoard then clears the overlay. The
  // controller must REMEMBER the last findings and re-apply them after a clear so
  // the current report's markers survive the (re)load.
  const located = [
    finding({ id: 'a', severity: 'error', location: { x: 1, y: 2 } }),
    finding({ id: 'c', severity: 'info', location: { x: 3, y: 4 } }),
    finding({ id: 'b' }), // un-located → no marker
  ]

  it('reapplyLast restores one marker per located finding after a clear', () => {
    const ctrl = createCriticOverlayController()
    ctrl.setFindings(located, 1.6)
    expect(ctrl.group.children.length).toBe(2)

    // loadBoard() clears the overlay during geometry rebuild.
    ctrl.clear()
    expect(ctrl.group.children.length).toBe(0)

    // At the end of loadBoard the scene re-applies the remembered findings.
    ctrl.reapplyLast(1.6)
    expect(ctrl.group.children.length).toBe(2)
    // Markers sit on the marker plane (thickness + lift), not zeroed away.
    for (const m of ctrl.group.children) {
      expect(m.position.z).toBeCloseTo(1.6 + MARKER_Z_LIFT)
    }
  })

  it('reapplyLast after an empty report leaves no markers', () => {
    const ctrl = createCriticOverlayController()
    ctrl.setFindings([], 1.6)
    ctrl.clear()
    ctrl.reapplyLast(1.6)
    expect(ctrl.group.children.length).toBe(0)
  })
})
