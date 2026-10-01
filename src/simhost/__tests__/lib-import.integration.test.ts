/**
 * src/simhost/__tests__/lib-import.integration.test.ts (issue #17)
 *
 * Import .lib end to end against the REAL bundled libngspice. A vendor-style .lib
 * (written here from scratch; no vendor model text lives in this repo) is bound
 * to a board part the way the Model Doctor does it: libText.bundleSubckt builds
 * the text, store.saveUserModel stores it, and the store's own solve path loads
 * the resulting deck through SimHost, which gates every deck through
 * sanitizeDeck (issue #35), so the imported text has to pass the gate to load.
 *
 * Before the fix the Model Doctor stored the string "* user-import from <path>"
 * as the model, the deck generator found no `.subckt` in it, and ngspice rejected
 * the whole deck with "unknown subckt". The first test keeps that stub as a
 * control, so the failure the fix removes stays documented and visible.
 *
 * Also proves persistence: the imported model goes into the per-board sidecar
 * and a fresh store that opens the board with that sidecar solves with it again.
 *
 * Skipped automatically when resources/ngspice/<platform> is missing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { bundleSubckt } from '../../core/models/libText'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimCommand, SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()

// The store lives in the renderer project, which the node tsconfig (this
// folder's project) does not include, so it is loaded dynamically and described
// by the narrow shape this test uses instead of a static import.
type SimEventListener = (event: SimEvent) => void
interface SimClientLike {
  send(command: SimCommand): void
  onEvent(listener: SimEventListener): () => void
  waitFor(type: SimEvent['type'], timeoutMs?: number): Promise<SimEvent>
}
interface StoreLike {
  getState(): {
    openBoardFromText(text: string, fileName: string, opts?: { boardPath?: string; sidecarText?: string | null }): void
    saveUserModel(
      ref: string,
      mpn: string,
      subcktText: string,
      subcktName: string,
      pinMap: Record<string, string>,
      provenance: 'llm-generated' | 'user-import'
    ): void
    energize(): Promise<Map<number, number> | null>
    buildSidecarText(): string | null
    circuit: { nets: { id: number; kicadName: string }[]; parts: { ref: string; value: string }[] } | null
    userModels: Map<string, { subcktText: string }>
    sidecar: { note: { restored: number; messages: string[] } | null }
  }
}
const STORE_MODULE = '../../renderer/src/store/appStore'
async function createAppStore(opts: { simClient: SimClientLike }): Promise<StoreLike> {
  const mod = (await import(/* @vite-ignore */ STORE_MODULE)) as {
    createAppStore(o: { simClient: SimClientLike }): StoreLike
  }
  return mod.createAppStore(opts)
}

/** A SimClient over a real in-process SimHost that records every deck it is sent and every log line. */
function createHostClient(): {
  client: SimClientLike
  host: SimHost
  decks: string[][]
  errors: string[]
  start(): Promise<void>
} {
  const listeners = new Set<SimEventListener>()
  const decks: string[][] = []
  const errors: string[] = []
  const host = new SimHost({
    emit: (e) => {
      if (e.type === 'log' && e.level === 'error') errors.push(e.text)
      for (const l of [...listeners]) l(e)
    },
    disableWatchdog: true,
    disableTimers: true
  })
  const client: SimClientLike = {
    send(cmd: SimCommand) {
      if (cmd.type === 'loadCircuit') decks.push([...cmd.deckLines])
      host.handleCommand(cmd)
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitFor(type, timeoutMs) {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const off = client.onEvent((e) => {
          if (e.type === type) {
            if (timer) clearTimeout(timer)
            off()
            resolve(e as never)
          }
        })
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            off()
            reject(new Error(`waitFor('${type}') timed out`))
          }, timeoutMs)
        }
      })
    }
  }
  return { client, host, decks, errors, start: () => host.start() }
}

/**
 * A fictional 8-pin part for U1 of the 555 fixture: OUT sits at exactly half of
 * the supply through an ideal source inside a helper subckt, a top-level .param
 * sets the ratio and a top-level .model backs a (reverse biased) clamp diode, so
 * the test exercises helper-subckt and hoisted-card handling too. An unrelated
 * part with a control block rides along in the file and must not matter.
 */
const VENDOR_LIB = [
  '* Fictional half-supply part (test fixture, not a vendor model)',
  '.param ratio=0.5',
  '.model dclamp D(Is=1e-14)',
  '',
  '.subckt HALFCORE in out gnd',
  'e1 out gnd in gnd {ratio}',
  'd1 gnd out dclamp',
  '.ends HALFCORE',
  '',
  '.SUBCKT HALF555 p1 p2 p3 p4 p5 p6 p7 p8',
  'xh p8 p3 p1 HALFCORE',
  'r2 p2 p1 1meg',
  'r4 p4 p8 1meg',
  'r5 p5 p1 1meg',
  'r6 p6 p1 1meg',
  'r7 p7 p1 1meg',
  '.ends HALF555',
  '',
  '.subckt NOT_BOUND a b',
  '.control',
  'echo never reached',
  '.endc',
  'r1 a b 1k',
  '.ends NOT_BOUND',
  ''
].join('\r\n')

const PIN_MAP: Record<string, string> = {
  '1': 'p1',
  '2': 'p2',
  '3': 'p3',
  '4': 'p4',
  '5': 'p5',
  '6': 'p6',
  '7': 'p7',
  '8': 'p8'
}

const board = readFileSync(join(process.cwd(), 'fixtures', 'fixture-555.kicad_pcb'), 'utf-8')
const BOARD_PATH = 'C:\\work\\fixture-555.kicad_pcb'

function netId(store: StoreLike, name: string): number {
  return store.getState().circuit!.nets.find((n) => n.kicadName === name)!.id
}

describe.skipIf(!haveNgspice)('issue #17: Import .lib binds the real model, end to end through SimHost', () => {
  let dispose: (() => Promise<void>) | null = null
  afterEach(async () => {
    await dispose?.()
    dispose = null
  })

  it('control: the old comment stub makes ngspice reject the deck with "unknown subckt"', async () => {
    const { client, host, decks, errors, start } = createHostClient()
    dispose = () => host.dispose()
    await start()
    const store = await createAppStore({ simClient: client })
    store.getState().openBoardFromText(board, 'fixture-555.kicad_pcb')
    store
      .getState()
      .saveUserModel('U1', 'NE555', '* user-import from C:/models/half555.lib', 'HALF555', PIN_MAP, 'user-import')
    await store.getState().energize()

    const deck = decks[decks.length - 1]
    expect(deck.some((l) => /^x_u1 .* HALF555$/i.test(l))).toBe(true)
    expect(deck.some((l) => /^\.subckt HALF555/i.test(l))).toBe(false)
    expect(errors.join('\n')).toMatch(/unknown subckt/i)
  }, 60_000)

  it('the bundled text loads, solves with the imported model, and is exactly what the deck inlines', async () => {
    const { client, host, decks, errors, start } = createHostClient()
    dispose = () => host.dispose()
    await start()
    const store = await createAppStore({ simClient: client })
    store.getState().openBoardFromText(board, 'fixture-555.kicad_pcb')

    // What the Model Doctor does on Bind: bundle the chosen subckt, store it.
    const bundle = bundleSubckt(VENDOR_LIB, 'HALF555')
    expect(bundle.ok).toBe(true)
    if (!bundle.ok) return
    store.getState().saveUserModel('U1', 'NE555', bundle.text, 'HALF555', PIN_MAP, 'user-import')

    const op = await store.getState().energize()
    expect(errors).toEqual([])
    expect(op).not.toBeNull()

    const deck = decks[decks.length - 1]
    expect(deck.some((l) => /^\.subckt HALF555/i.test(l))).toBe(true)
    expect(deck.some((l) => /^\.subckt HALFCORE/i.test(l))).toBe(true)
    expect(deck.some((l) => /\.control/i.test(l))).toBe(false)

    const vcc = op!.get(netId(store, 'VCC'))!
    const out = op!.get(netId(store, 'OUT'))!
    expect(vcc).toBeGreaterThan(1)
    // The imported model, not the bundled NE555, drives OUT: exactly half the supply.
    expect(out).toBeCloseTo(vcc / 2, 3)
  }, 60_000)

  it('persists: a fresh store that opens the board with the sidecar solves with the imported model', async () => {
    const first = createHostClient()
    dispose = () => first.host.dispose()
    await first.start()
    const store = await createAppStore({ simClient: first.client })
    store.getState().openBoardFromText(board, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    const bundle = bundleSubckt(VENDOR_LIB, 'HALF555')
    expect(bundle.ok).toBe(true)
    if (!bundle.ok) return
    store.getState().saveUserModel('U1', 'NE555', bundle.text, 'HALF555', PIN_MAP, 'user-import')
    const sidecarText = store.getState().buildSidecarText()!
    expect(sidecarText).toContain('HALF555')
    expect(sidecarText).not.toContain('user-import from')
    await dispose()

    // "Restart": a new store and a new host, only the sidecar text carried over.
    const second = createHostClient()
    dispose = () => second.host.dispose()
    await second.start()
    const reopened = await createAppStore({ simClient: second.client })
    reopened
      .getState()
      .openBoardFromText(board, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText })
    expect(reopened.getState().userModels.get('U1')?.subcktText).toBe(bundle.text)

    const op = await reopened.getState().energize()
    expect(second.errors).toEqual([])
    const vcc = op!.get(netId(reopened, 'VCC'))!
    expect(op!.get(netId(reopened, 'OUT'))!).toBeCloseTo(vcc / 2, 3)
  }, 60_000)

  it('a comment stub left in a sidecar by an older build is dropped with a note, and the board still solves', async () => {
    const { client, host, errors, start } = createHostClient()
    dispose = () => host.dispose()
    await start()
    const seed = await createAppStore({ simClient: client })
    seed.getState().openBoardFromText(board, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH })
    seed
      .getState()
      .saveUserModel('U1', 'NE555', '* user-import from C:/models/half555.lib', 'HALF555', PIN_MAP, 'user-import')
    const stubSidecar = seed.getState().buildSidecarText()!
    expect(stubSidecar).toContain('user-import from')

    const store = await createAppStore({ simClient: client })
    store.getState().openBoardFromText(board, 'fixture-555.kicad_pcb', { boardPath: BOARD_PATH, sidecarText: stubSidecar })
    expect(store.getState().userModels.has('U1')).toBe(false)
    expect(store.getState().sidecar.note?.messages.join(' ')).toMatch(/does not define \.subckt HALF555/)

    const op = await store.getState().energize()
    expect(errors).toEqual([])
    expect(op).not.toBeNull()
  }, 60_000)
})
