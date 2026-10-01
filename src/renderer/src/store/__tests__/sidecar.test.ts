/**
 * sidecar.test.ts - issue #27 (nothing survives reopen or restart).
 *
 * Reproduction: opening a board always resets ground, instruments, stubs, pin
 * maps and rail overrides; nothing is written anywhere, so a reopen after fixing
 * the board in KiCad throws the whole bench away. These tests drive the store the
 * way App does: open with an optional sidecar text, and capture the sidecar text
 * from the live state.
 *
 * Also covers the review-focus-4 failure mode: a v0 sidecar, a truncated file,
 * garbage and a newer-format file load what they can or report, and never break
 * the open.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore, AUTO_SUPPLY_ID } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import { UNWIRED } from '../../../../core/spicegen/instruments'
import { GROUND_LEAD_KEY } from '../../../../core/persist/sidecar'

const fixturesDir = join(__dirname, '../../../../../fixtures')
const BOARD_555 = readFileSync(join(fixturesDir, 'fixture-555.kicad_pcb'), 'utf-8')
const BOARD_RC = readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8')
const BOARD_PATH = 'C:\\work\\fixture-555.kicad_pcb'

function newStore(): ReturnType<typeof createAppStore> {
  return createAppStore({ simClient: createMockSimClient() })
}

function netId(store: ReturnType<typeof createAppStore>, name: string): number {
  return store.getState().circuit!.nets.find(n => n.kicadName === name)!.id
}

/** Rig a bench the way a user would, then return the sidecar text. */
function rigBench(store: ReturnType<typeof createAppStore>): string {
  const s = store.getState()
  s.setGround(netId(store, 'GND'))
  s.removeInstrument(AUTO_SUPPLY_ID)
  const sup = s.addBenchInstrument('dc-supply')
  s.assignTerminal(sup, 'net', { kind: 'net', netId: netId(store, 'VCC') }, { x: 12.5, y: -30.25 })
  s.setBomFromText('Reference,Value\nU1,NE555\n')
  s.stubPart('D1', 'open')
  s.setPinMap('D1', { '1': 'K', '2': 'A' })
  s.setRailOverride('OUT', 3.3)
  s.saveUserModel('U1', 'NE555', '.subckt NE555 1 2\nR1 1 2 1k\n.ends NE555\n', 'NE555', { '1': '1', '2': '2' }, 'user-import')
  return store.getState().buildSidecarText()!
}

describe('reproduction: reopening resets the bench (#27)', () => {
  it('without a sidecar a reopen starts from scratch (nothing is silently saved)', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    store.getState().stubPart('D1', 'open')
    store.getState().setRailOverride('OUT', 3.3)
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    expect(store.getState().stubOverrides.size).toBe(0)
    expect(store.getState().railOverrides.size).toBe(0)
    expect(store.getState().sidecar.autosave).toBe(false)
    expect(store.getState().sidecar.note).toBeNull()
  })

  it('with the saved sidecar a reopen restores ground, bench, overrides and models', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const text = rigBench(store)

    const reopened = newStore()
    reopened.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', {
      boardPath: BOARD_PATH,
      sidecarText: text,
    })
    const s = reopened.getState()
    expect(s.parseError).toBeNull()
    expect(s.groundNetId).toBe(netId(reopened, 'GND'))
    const sup = s.instruments.find(i => i.kind === 'dc-supply' && i.netId === netId(reopened, 'VCC'))
    expect(sup).toBeDefined()
    expect(s.instruments.some(i => 'id' in i && i.id === AUTO_SUPPLY_ID)).toBe(false)
    expect(s.leadPositions.get(`${(sup as { id: string }).id}:net`)).toEqual({ x: 12.5, y: -30.25 })
    expect(s.stubOverrides.get('D1')).toEqual({ kind: 'stub', mode: 'open' })
    expect(s.pinMapOverrides.get('D1')).toEqual({ '1': 'K', '2': 'A' })
    expect(s.railOverrides.get('OUT')).toBe(3.3)
    expect(s.userModels.get('U1')?.mpn).toBe('NE555')
    // The overrides reach the resolver, not just the maps.
    const d1 = s.resolutions.find(r => r.ref === 'D1')!
    expect(d1.model).toMatchObject({ kind: 'stub', mode: 'open' })
    // A visible note says what happened.
    expect(s.sidecar.note?.restored).toBeGreaterThanOrEqual(6)
    expect(s.sidecar.autosave).toBe(true)
    expect(s.sidecar.path).toBe('C:\\work\\fixture-555.circsim.json')
  })

  it('restored bench ids never collide with ids allocated afterwards', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const text = rigBench(store)
    const restoredId = store.getState().instruments.find(i => i.kind === 'dc-supply' && i.netId === netId(store, 'VCC'))
    const fresh = newStore()
    fresh.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText: text })
    const newId = fresh.getState().addBenchInstrument('dc-supply')
    const ids = fresh.getState().instruments.map(i => ('id' in i ? i.id : ''))
    expect(ids.filter(id => id === newId)).toHaveLength(1)
    expect(newId).not.toBe((restoredId as { id: string }).id)
  })

  it('the ground lead position is restored under the ground key', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    store.getState().assignTerminal('ground', 'gnd', { kind: 'net', netId: netId(store, 'GND') }, { x: 1, y: 2 })
    expect(store.getState().leadPositions.get(GROUND_LEAD_KEY)).toEqual({ x: 1, y: 2 })
    const text = store.getState().buildSidecarText()!
    const fresh = newStore()
    fresh.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText: text })
    expect(fresh.getState().leadPositions.get(GROUND_LEAD_KEY)).toEqual({ x: 1, y: 2 })
  })
})

describe('lead positions follow the leads', () => {
  it('detaching a lead or removing its instrument drops the position', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const id = store.getState().addBenchInstrument('voltage-probe')
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: netId(store, 'OUT') }, { x: 5, y: 6 })
    expect(store.getState().leadPositions.get(`${id}:net`)).toEqual({ x: 5, y: 6 })
    store.getState().detachTerminalWire(id, 'net')
    expect(store.getState().leadPositions.has(`${id}:net`)).toBe(false)
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: netId(store, 'OUT') }, { x: 5, y: 6 })
    store.getState().removeInstrument(id)
    expect(store.getState().leadPositions.has(`${id}:net`)).toBe(false)
  })

  it('rewiring without a position clears a stale one', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const id = store.getState().addBenchInstrument('voltage-probe')
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: netId(store, 'OUT') }, { x: 5, y: 6 })
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: netId(store, 'VCC') })
    expect(store.getState().leadPositions.has(`${id}:net`)).toBe(false)
  })
})

describe('the board changed since the sidecar was saved', () => {
  it('restores by name and drops what is gone, with a note', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const text = rigBench(store)
    // A different board: no VCC net, no D1, no U1.
    const other = newStore()
    other.getState().openBoardFromText(BOARD_RC, 'fixture-rc.kicad_pcb', {
      boardPath: 'C:\\work\\fixture-rc.kicad_pcb',
      sidecarText: text,
    })
    const s = other.getState()
    expect(s.parseError).toBeNull()
    expect(s.circuit).not.toBeNull()
    expect(s.stubOverrides.size).toBe(0)
    expect(s.sidecar.note?.messages.length).toBeGreaterThan(0)
    // GND exists in both boards, so ground was restored by name.
    expect(s.groundNetId).toBe(netId(other, 'GND'))
    // The supply's VCC net is gone: it is kept on the shelf, unwired.
    const sup = s.instruments.find(i => i.kind === 'dc-supply')
    expect(sup).toMatchObject({ netId: UNWIRED })
  })
})

describe('review focus 4: older, truncated and damaged sidecars never break the open', () => {
  it('a v0 sidecar (no version, bare ground name, flat instrument) loads', () => {
    const v0 = JSON.stringify({
      ground: 'GND',
      instruments: [{ kind: 'dc-supply', id: 'psu', netId: 'VCC', volts: 9, seriesOhms: 0.2 }],
      railOverrides: { OUT: 3.3 },
    })
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText: v0 })
    const s = store.getState()
    expect(s.parseError).toBeNull()
    expect(s.groundNetId).toBe(netId(store, 'GND'))
    expect(s.instruments).toEqual([
      { kind: 'dc-supply', id: 'psu', netId: netId(store, 'VCC'), volts: 9, seriesOhms: 0.2 },
    ])
    expect(s.railOverrides.get('OUT')).toBe(3.3)
    expect(s.sidecar.diskStatus).toBe('legacy')
    // A v0 file is upgraded on the next save, with a backup of the original first.
    expect(s.sidecar.autosave).toBe(true)
    expect(s.sidecar.backupFirst).toBe(true)
  })

  it('a truncated file loads the complete part and reports the rest', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const full = rigBench(store)
    const cut = full.slice(0, full.indexOf('"userModels"') - 5)
    const fresh = newStore()
    fresh.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText: cut })
    const s = fresh.getState()
    expect(s.parseError).toBeNull()
    expect(s.board).not.toBeNull()
    expect(s.groundNetId).toBe(netId(fresh, 'GND'))
    expect(s.railOverrides.get('OUT')).toBe(3.3)
    expect(s.sidecar.diskStatus).toBe('salvaged')
    expect(s.sidecar.note?.messages.join(' ')).toMatch(/cut off|damaged/)
    expect(s.sidecar.backupFirst).toBe(true)
  })

  it('every possible truncation point opens the board', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const full = rigBench(store)
    for (let n = 0; n < full.length; n += 17) {
      const fresh = newStore()
      fresh.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', {
        boardPath: BOARD_PATH,
        sidecarText: full.slice(0, n),
      })
      expect(fresh.getState().parseError).toBeNull()
      expect(fresh.getState().circuit).not.toBeNull()
    }
  })

  it('garbage opens the board with the default bench and leaves the file alone', () => {
    for (const junk of ['', 'not json at all', '[1,2,3]', '{"format":"something-else"}', '\u0000\u0001', 'null']) {
      const store = newStore()
      store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText: junk })
      const s = store.getState()
      expect(s.parseError).toBeNull()
      expect(s.circuit).not.toBeNull()
      // Default open: the auto supply is still attached.
      expect(s.instruments.some(i => 'id' in i && i.id === AUTO_SUPPLY_ID)).toBe(true)
      expect(s.sidecar.autosave).toBe(false)
      expect(s.sidecar.note).not.toBeNull()
    }
  })

  it('a file from a newer circsim is read but never auto-overwritten', () => {
    const newer = JSON.stringify({
      format: 'circsim-sidecar',
      version: 7,
      ground: { net: 'GND' },
      railOverrides: { OUT: 2.5 },
      someFutureThing: { a: 1 },
    })
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText: newer })
    const s = store.getState()
    expect(s.railOverrides.get('OUT')).toBe(2.5)
    expect(s.sidecar.diskStatus).toBe('newer')
    expect(s.sidecar.autosave).toBe(false)
  })

  it('a read error is reported and the open proceeds', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', {
      boardPath: BOARD_PATH,
      sidecarError: 'EACCES: permission denied',
    })
    const s = store.getState()
    expect(s.parseError).toBeNull()
    expect(s.sidecar.autosave).toBe(false)
    expect(s.sidecar.note?.messages.join(' ')).toContain('EACCES')
  })

  it('a hostile model in a sidecar is refused (no .control block reaches ngspice)', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const text = JSON.parse(rigBench(store))
    text.userModels.U1.subcktText = '.subckt NE555 1 2\n.control\nshell calc\n.endc\n.ends\n'
    const fresh = newStore()
    fresh.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', {
      boardPath: BOARD_PATH,
      sidecarText: JSON.stringify(text),
    })
    expect(fresh.getState().userModels.has('U1')).toBe(false)
    expect(fresh.getState().sidecar.note?.messages.join(' ')).toMatch(/control/)
  })
})

describe('persistence is opt-in until a sidecar exists', () => {
  it('a board with no sidecar waits for the user: autosave off, path known', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const s = store.getState()
    expect(s.sidecar.path).toBe('C:\\work\\fixture-555.circsim.json')
    expect(s.sidecar.autosave).toBe(false)
    expect(s.sidecar.diskStatus).toBe('absent')
    store.getState().enableAutosave()
    expect(store.getState().sidecar.autosave).toBe(true)
    expect(store.getState().sidecar.backupFirst).toBe(false)
  })

  it('a board opened without a path (bundled sample, drop of raw text) has nothing to save', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb')
    expect(store.getState().sidecar.path).toBeNull()
    store.getState().enableAutosave()
    expect(store.getState().sidecar.autosave).toBe(false)
  })

  it('explicit save over an unreadable file asks for a backup first', () => {
    const store = newStore()
    store.getState().openBoardFromText(BOARD_555, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText: '{{{{' })
    expect(store.getState().sidecar.autosave).toBe(false)
    store.getState().enableAutosave()
    expect(store.getState().sidecar.autosave).toBe(true)
    expect(store.getState().sidecar.backupFirst).toBe(true)
  })
})
