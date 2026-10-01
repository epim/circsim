/**
 * sidecarSync.test.ts - autosave of the per-board setup file (issue #27).
 *
 * Covers: nothing is written until the user opts in (or a file already exists);
 * edits are debounced; opening a board does not itself write; a failed write is
 * reported and retried; the first write over an old or damaged file asks for a
 * backup; the written text round-trips through a fresh open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import { attachSidecarSync, type SidecarIO } from '../sidecarSync'

const BOARD = readFileSync(join(__dirname, '../../../../../fixtures/fixture-555.kicad_pcb'), 'utf-8')
const BOARD_PATH = '/work/fixture-555.kicad_pcb'

interface Write { boardPath: string; text: string; backupExisting: boolean }

function setup(opts: { fail?: () => boolean } = {}): {
  store: ReturnType<typeof createAppStore>
  writes: Write[]
  sync: ReturnType<typeof attachSidecarSync>
} {
  const store = createAppStore({ simClient: createMockSimClient() })
  const writes: Write[] = []
  const io: SidecarIO = {
    async write(boardPath, text, o) {
      if (opts.fail?.()) throw new Error('disk full')
      writes.push({ boardPath, text, backupExisting: o.backupExisting })
    },
  }
  const sync = attachSidecarSync(store, io, { debounceMs: 100 })
  return { store, writes, sync }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('sidecar autosave', () => {
  it('writes nothing until the user opts in', async () => {
    const { store, writes, sync } = setup()
    store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    store.getState().stubPart('D1', 'open')
    store.getState().setRailOverride('OUT', 3.3)
    await vi.advanceTimersByTimeAsync(1000)
    await sync.flush()
    expect(writes).toHaveLength(0)
  })

  it('opting in writes immediately, then debounces edits into one write', async () => {
    const { store, writes } = setup()
    store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    store.getState().stubPart('D1', 'open')
    store.getState().enableAutosave()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveLength(1)
    expect(writes[0].boardPath).toBe(BOARD_PATH)
    expect(writes[0].backupExisting).toBe(false)
    expect(JSON.parse(writes[0].text).stubs).toEqual({ D1: 'open' })
    expect(store.getState().sidecar.lastSavedAt).not.toBeNull()
    expect(store.getState().sidecar.diskStatus).toBe('ok')

    // A burst of edits collapses into a single trailing write.
    for (let v = 1; v <= 5; v++) store.getState().setRailOverride('OUT', v)
    await vi.advanceTimersByTimeAsync(50)
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes[1].text).railOverrides).toEqual({ OUT: 5 })
  })

  it('opening a board with a setup file does not rewrite it', async () => {
    const first = setup()
    first.store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    first.store.getState().setRailOverride('OUT', 3.3)
    first.store.getState().enableAutosave()
    await vi.advanceTimersByTimeAsync(0)
    const text = first.writes[0].text

    const second = setup()
    second.store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', {
      boardPath: BOARD_PATH,
      sidecarText: text,
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(second.writes).toHaveLength(0)
    expect(second.store.getState().railOverrides.get('OUT')).toBe(3.3)
    // The first edit after the open saves.
    second.store.getState().setRailOverride('OUT', 2)
    await vi.advanceTimersByTimeAsync(200)
    expect(second.writes).toHaveLength(1)
    expect(JSON.parse(second.writes[0].text).railOverrides).toEqual({ OUT: 2 })
  })

  it('the first write over a v0 file asks for a backup, later writes do not', async () => {
    const { store, writes } = setup()
    store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', {
      boardPath: BOARD_PATH,
      sidecarText: JSON.stringify({ ground: 'GND' }),
    })
    store.getState().setRailOverride('OUT', 3.3)
    await vi.advanceTimersByTimeAsync(200)
    store.getState().setRailOverride('OUT', 3.4)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes.map(w => w.backupExisting)).toEqual([true, false])
    expect(JSON.parse(writes[0].text).version).toBe(1)
  })

  it('never writes over a newer-format file', async () => {
    const { store, writes } = setup()
    store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', {
      boardPath: BOARD_PATH,
      sidecarText: JSON.stringify({ format: 'circsim-sidecar', version: 9 }),
    })
    store.getState().setRailOverride('OUT', 3.3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toHaveLength(0)
  })

  it('a failed write is reported and retried on the next change', async () => {
    let failing = true
    const { store, writes } = setup({ fail: () => failing })
    store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    store.getState().enableAutosave()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().sidecar.error).toContain('disk full')
    expect(writes).toHaveLength(0)
    failing = false
    store.getState().setRailOverride('OUT', 3.3)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes).toHaveLength(1)
    expect(store.getState().sidecar.error).toBeNull()
  })

  it('a board with no path is never written', async () => {
    const { store, writes } = setup()
    store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb')
    store.getState().enableAutosave()
    store.getState().setRailOverride('OUT', 3.3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toHaveLength(0)
  })

  it('flush writes a pending change immediately', async () => {
    const { store, writes, sync } = setup()
    store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    store.getState().enableAutosave()
    await vi.advanceTimersByTimeAsync(0)
    store.getState().setRailOverride('OUT', 4)
    expect(writes).toHaveLength(1)
    await sync.flush()
    expect(writes).toHaveLength(2)
  })

  it('switching boards stops saving the old board', async () => {
    const { store, writes } = setup()
    store.getState().openBoardFromText(BOARD, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    store.getState().enableAutosave()
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveLength(1)
    store.getState().openBoardFromText(BOARD, 'other.kicad_pcb', { boardPath: '/work/other.kicad_pcb' })
    store.getState().setRailOverride('OUT', 3.3)
    await vi.advanceTimersByTimeAsync(1000)
    // The new board has no setup file and the user has not opted in.
    expect(writes).toHaveLength(1)
  })
})
