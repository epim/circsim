/**
 * diagnostics.test.ts: issue #26. The store keeps what a bug report needs
 * (both decks, the op, the crash reason), and saveDiagnostics turns it into the
 * bundle files main zips.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore, type AppStore } from '../appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'
import { collectDiagnosticsFiles, saveDiagnostics } from '../../diagnostics/saveDiagnostics'
import { sha256Hex } from '../../../../core/report/diagnostics'

const fixturesDir = join(__dirname, '../../../../../fixtures')
const boardText = readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8')

function file(files: { name: string; text: string }[], name: string): string {
  const f = files.find(x => x.name === name)
  if (!f) throw new Error(`missing ${name}`)
  return f.text
}

describe('diagnostics bundle (issue #26)', () => {
  let store: AppStore
  let mock: MockSimClient

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(boardText, 'fixture-rc.kicad_pcb')
    const vin = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vin.id, volts: 5, seriesOhms: 0.1 })
  })

  it('noteCrash keeps the exit code and reason', () => {
    store.getState().noteCrash(true, { exitCode: 86, reason: 'watchdog' })
    expect(store.getState().crashNotice).toMatchObject({ willRespawn: true, exitCode: 86, reason: 'watchdog' })
    store.getState().noteCrash(false)
    expect(store.getState().crashNotice!.exitCode).toBeUndefined()
  })

  it('powerOn records the pass-1 deck and the committed op', async () => {
    const p = store.getState().powerOn()
    mock.emit({ type: 'ready', ngspiceVersion: 'ngspice-46' })
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 }, method: 'gmin' })
    await p
    const solve = store.getState().lastSolve
    expect(solve).not.toBeNull()
    expect(solve!.pass1Deck.length).toBeGreaterThan(3)
    expect(solve!.pass1Deck.join('\n')).toContain('r_')
    expect(solve!.opValues).toEqual({ vin: 5, out: 2.5 })
    expect(solve!.opMethod).toBe('gmin')
    expect(solve!.pass2).toBe('not-needed')
  })

  describe('a failed pass-1 solve', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    async function failSolve(): Promise<void> {
      const p = store.getState().powerOn()
      mock.emit({ type: 'convergenceFailure', detail: 'trouble with node "out"' })
      await vi.advanceTimersByTimeAsync(30_000)
      await p
    }

    it('records the deck that failed, not the previous solve deck', async () => {
      const ok = store.getState().powerOn()
      mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
      await ok
      const goodDeck = store.getState().lastSolve!.pass1Deck

      store.getState().updateInstrument('psu1', { kind: 'dc-supply', id: 'psu1', netId: store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id, volts: 9, seriesOhms: 0.1 })
      await failSolve()

      const solve = store.getState().lastSolve!
      expect(solve.status).toBe('pass1-failed')
      expect(solve.pass1Deck).not.toEqual(goodDeck)
      const loads = mock.sent.filter(c => c.type === 'loadCircuit') as { deckLines: string[] }[]
      expect(solve.pass1Deck).toEqual(loads[loads.length - 1].deckLines)

      const { files } = await collectDiagnosticsFiles(store, '1.0.0')
      expect(file(files, 'decks/pass1.cir')).toBe(solve.pass1Deck.join('\n') + '\n')
      const manifest = JSON.parse(file(files, 'manifest.json'))
      expect(manifest.solve.status).toBe('pass1-failed')
      expect(manifest.opMethod).toBeNull()
      expect(manifest.decks.pass2Status).toBeNull()
      expect(JSON.parse(file(files, 'op.json'))).toBeNull()
    })

    it('ships the failed deck when the very first solve fails', async () => {
      expect(store.getState().lastSolve).toBeNull()
      await failSolve()
      const { files } = await collectDiagnosticsFiles(store, '1.0.0')
      expect(file(files, 'decks/pass1.cir')).toContain('.end')
      expect(JSON.parse(file(files, 'manifest.json')).solve.status).toBe('pass1-failed')
    })

    it('a later good solve replaces the failure record', async () => {
      await failSolve()
      const ok = store.getState().powerOn()
      mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
      await ok
      expect(store.getState().lastSolve!.status).toBe('solved')
    })
  })

  it('a new board clears the retained solve', async () => {
    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
    expect(store.getState().lastSolve).not.toBeNull()
    store.getState().openBoardFromText(boardText, 'again.kicad_pcb')
    expect(store.getState().lastSolve).toBeNull()
    expect(store.getState().lastRunDeck).toBeNull()
  })

  it('run records the deck it loaded', () => {
    store.getState().run()
    const sent = mock.sent.find(c => c.type === 'loadCircuit') as { deckLines: string[] }
    expect(store.getState().lastRunDeck).toEqual(sent.deckLines)
  })

  it('collects deck, log, board hash, crash reason and versions', async () => {
    const p = store.getState().powerOn()
    mock.emit({ type: 'ready', ngspiceVersion: 'ngspice-46' })
    mock.emit({ type: 'log', level: 'warn', text: 'gmin stepping' })
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p
    store.getState().noteCrash(true, { exitCode: 3221225477, reason: 'crashed' })

    const { suggestedName, files } = await collectDiagnosticsFiles(
      store,
      '9.9.9',
      new Date(2026, 8, 30, 16, 57, 3),
    )
    expect(suggestedName).toBe('circsim-diagnostics-fixture-rc-20260930-165703.zip')
    const manifest = JSON.parse(file(files, 'manifest.json'))
    expect(manifest.app).toBe('9.9.9')
    expect(manifest.ngspice).toBe('ngspice-46')
    expect(manifest.board.fileName).toBe('fixture-rc.kicad_pcb')
    expect(manifest.board.sha256).toBe(await sha256Hex(boardText))
    expect(manifest.crash).toMatchObject({ exitCode: 3221225477, reason: 'crashed' })
    expect(file(files, 'decks/pass1.cir')).toContain('.end')
    expect(file(files, 'ngspice.log')).toContain('[warn] gmin stepping')
    expect(JSON.parse(file(files, 'resolutions.json')).length).toBeGreaterThan(0)
    expect(JSON.parse(file(files, 'instruments.json')).some((i: { kind: string }) => i.kind === 'dc-supply')).toBe(true)
    // The board file itself is never part of the bundle.
    expect(JSON.stringify(files)).not.toContain('(kicad_pcb')
  })

  it('saveDiagnostics passes the files to main and returns its result', async () => {
    const calls: { suggestedName: string; files: { name: string }[] }[] = []
    const result = await saveDiagnostics(
      store,
      {
        saveDiagnosticsBundle: async req => {
          calls.push(req)
          return { saved: true, path: 'C:\\tmp\\bundle.zip' }
        },
      },
      '1.0.0',
    )
    expect(result).toEqual({ saved: true, path: 'C:\\tmp\\bundle.zip' })
    expect(calls).toHaveLength(1)
    expect(calls[0].files.map(f => f.name)).toContain('manifest.json')
  })

  it('saveDiagnostics reports an IPC failure instead of throwing', async () => {
    const result = await saveDiagnostics(
      store,
      {
        saveDiagnosticsBundle: async () => {
          throw new Error('ipc down')
        },
      },
      '1.0.0',
    )
    expect(result).toEqual({ saved: false, error: 'ipc down' })
  })
})
