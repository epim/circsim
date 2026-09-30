/**
 * padRotation.test.ts
 *
 * Issue #3: pad geometry in the 3D view (which feeds the per-net copper mesh
 * that the picker uses) must sit where KiCad puts each pad. Reference values
 * are the pad centers kicad-cli plotted from fixture-rotated.kicad_pcb.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parseBoard } from '../../../../core/kicad/board'
import { checkPadsAgainstFlashes, type PadFlash } from '../../../../core/critic/__tests__/padOracle'
import { buildPadGeometry } from '../copperGeometry'
import { computePlaceholderBox } from '../componentGeometry'
import { kicadToWorld } from '../boardGeometry'

const fx = (name: string): string => path.resolve(__dirname, '../../../../../fixtures', name)
const board = parseBoard(fs.readFileSync(fx('fixture-rotated.kicad_pcb'), 'utf-8'))
const flashes = (JSON.parse(fs.readFileSync(fx('fixture-rotated.flashes.json'), 'utf-8')) as { flashes: PadFlash[] })
  .flashes

function bounds(geo: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number } }) {
  const pos = geo.getAttribute('position')
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < pos.count; i++) {
    minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i))
    minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i))
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY }
}

describe('buildPadGeometry on rotated footprints', () => {
  it('centers every pad where kicad-cli plots it', () => {
    // Reuse the oracle by expressing the geometry center as a board position.
    const geoPos = (fp: (typeof board.footprints)[number], pad: (typeof board.footprints)[number]['pads'][number]) => {
      const geo = buildPadGeometry(pad, fp.at.x, fp.at.y, fp.at.rotDeg)!
      const b = bounds(geo as never)
      // world back to KiCad frame: kicadToWorld is a Y flip
      return { x: b.cx, y: -b.cy }
    }
    const { checked, mismatches } = checkPadsAgainstFlashes(board, geoPos, flashes, 0.001)
    expect(checked).toBe(10)
    expect(mismatches).toEqual([])
  })

  it('orients pad outlines with the absolute pad angle (0805 pad on a 90 degree part is 1.4 wide, 1.025 tall)', () => {
    const r1 = board.footprints.find((f) => f.ref === 'R1')!
    const geo = buildPadGeometry(r1.pads[0], r1.at.x, r1.at.y, r1.at.rotDeg)!
    const b = bounds(geo as never)
    const c = kicadToWorld(20, 19.0875)
    expect(b.cx).toBeCloseTo(c.x, 3)
    expect(b.cy).toBeCloseTo(c.y, 3)
    // KiCad plots this pad as RoundRect 0.8875 x 0.5125 half-extents plus radius: 1.4 x 1.025
    expect(b.w).toBeCloseTo(1.4, 3)
    expect(b.h).toBeCloseTo(1.025, 3)
  })
})

describe('computePlaceholderBox on rotated footprints', () => {
  it('sizes the box from rotated pad extents', () => {
    // R1: pads centered (20, 19.0875) and (20, 20.9125), each 1.4 wide by
    // 1.025 tall on the board (pad angle 90 swaps the 1.025 x 1.4 size).
    const r1 = board.footprints.find((f) => f.ref === 'R1')!
    const box = computePlaceholderBox(r1, board.boardThicknessMm)
    expect(box.w).toBeCloseTo(1.4 + 0.8, 3)
    expect(box.h).toBeCloseTo(1.825 + 1.025 + 0.8, 3)
  })
})
