/**
 * Pad world-position oracle for issue #3 (footprint pad rotation handedness).
 *
 * The fixture is a KiCad-written board with 90 and 270 degree footprints on
 * both F.Cu and B.Cu, asymmetric pad patterns (SOT-23) and routed copper. It
 * is checked against kicad-cli twice: through a committed copy of the pad
 * centers kicad-cli plotted (always runs), and live against kicad-cli itself
 * when the binary is available (so the committed copy cannot drift).
 *
 * The corpus suite reuses `checkPadsAgainstCopper` from ./padOracle.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { padWorldPos } from '../geom'
import {
  checkPadsAgainstCopper,
  checkPadsAgainstFlashes,
  findKicadCli,
  parseGerberPadFlashes,
  plotPadCentersWithKicadCli,
  type PadFlash,
} from './padOracle'

const FIXTURE = join(__dirname, '../../../../fixtures/fixture-rotated.kicad_pcb')
const FLASHES = join(__dirname, '../../../../fixtures/fixture-rotated.flashes.json')

const board = parseBoard(readFileSync(FIXTURE, 'utf8'))
const committed = (JSON.parse(readFileSync(FLASHES, 'utf8')) as { flashes: PadFlash[] }).flashes

describe('fixture-rotated', () => {
  it('has rotated footprints on both sides (guards against a vacuous oracle)', () => {
    // KiCad 10 writes 270 as -90
    const rots = board.footprints.map((f) => `${f.layer}${((f.at.rotDeg % 360) + 360) % 360}`).sort()
    expect(rots).toEqual(['B270', 'B90', 'F270', 'F90'])
  })
})

describe('padWorldPos vs KiCad', () => {
  it('lands every routed pad on same-net copper (routed-copper oracle)', () => {
    const { checked, mismatches } = checkPadsAgainstCopper(board, padWorldPos)
    expect(checked).toBe(10)
    expect(mismatches).toEqual([])
  })

  it('matches the pad centers kicad-cli plotted (committed flashes)', () => {
    const { checked, mismatches } = checkPadsAgainstFlashes(board, padWorldPos, committed)
    expect(checked).toBe(10)
    expect(mismatches).toEqual([])
  })

  const cli = findKicadCli()
  it.skipIf(!cli)('matches kicad-cli run live on the fixture', () => {
    const live = plotPadCentersWithKicadCli(cli as string, FIXTURE)
    expect(live.length).toBe(10)
    const { checked, mismatches } = checkPadsAgainstFlashes(board, padWorldPos, live)
    expect(checked).toBe(10)
    expect(mismatches).toEqual([])
    // the committed copy must not have drifted from what kicad-cli says today
    const drift = checkPadsAgainstFlashes(board, padWorldPos, committed)
    expect(drift.mismatches).toEqual([])
  })
})

describe('parseGerberPadFlashes', () => {
  it('reads reference, pad, net and Y-flipped coordinates from X2 attributes', () => {
    const gbr = ['D10*', '%TO.P,R1,2*%', '%TO.N,MID*%', 'X20000000Y-20912500D03*', '%TD*%'].join('\n')
    expect(parseGerberPadFlashes(gbr)).toEqual([{ ref: 'R1', pad: '2', net: 'MID', x: 20, y: 20.9125 }])
  })
})
