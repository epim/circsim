/**
 * guidedStates.test.ts -- issue #32 (Spec section 12).
 *
 * Energize / Power On / Run must never no-op silently. When ground or a wired
 * source is missing the store records WHY in `guidedBlock` so the UI can mount
 * the NoGroundState / NoSourceState guided cards.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import { AUTO_NAMED_BOARD } from './autoNamedBoard'

const fixturesDir = join(__dirname, '../../../../../fixtures')

describe('guided states on blocked Energize / Power On / Run (#32)', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
  })

  it('starts with no guided block', () => {
    expect(store.getState().guidedBlock).toBeNull()
  })

  it('energize on an auto-named board returns null and records no-ground', async () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    expect(store.getState().groundNetId).toBeNull()

    const res = await store.getState().energize()

    expect(res).toBeNull()
    expect(store.getState().guidedBlock).toBe('no-ground')
  })

  it('powerOn without ground records no-ground', async () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    const res = await store.getState().powerOn()
    expect(res).toBeNull()
    expect(store.getState().guidedBlock).toBe('no-ground')
  })

  it('powerOn with ground but no wired source records no-source', async () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    store.getState().setGround(3)
    expect(store.getState().instruments).toHaveLength(0)

    const res = await store.getState().powerOn()

    expect(res).toBeNull()
    expect(store.getState().guidedBlock).toBe('no-source')
  })

  it('run() without ground or source records the matching block', () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    store.getState().run()
    expect(store.getState().guidedBlock).toBe('no-ground')

    store.getState().setGround(3)
    store.getState().run()
    expect(store.getState().guidedBlock).toBe('no-source')
  })

  it('dismissGuidedBlock clears the block', async () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    await store.getState().powerOn()
    expect(store.getState().guidedBlock).toBe('no-ground')
    store.getState().dismissGuidedBlock()
    expect(store.getState().guidedBlock).toBeNull()
  })

  it('opening a board resets a stale block', async () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    await store.getState().powerOn()
    expect(store.getState().guidedBlock).toBe('no-ground')

    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
        'fixture-rc.kicad_pcb',
      )
    expect(store.getState().guidedBlock).toBeNull()
  })

  it('a runnable board (ground + wired supply) does not set a block on run()', () => {
    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-555.kicad_pcb'), 'utf-8'),
        'fixture-555.kicad_pcb',
      )
    store.getState().run()
    expect(store.getState().guidedBlock).toBeNull()
  })
})
