/**
 * src/simhost/__tests__/validate-subckt.integration.test.ts (issue #18)
 *
 * The Ask-your-LLM paste path against the REAL bundled libngspice. The Model
 * Doctor hands a pasted multi-line `.subckt ... .ends` block to the store's
 * `validateSubckt`, which builds a probe deck and loads it through SimHost. The
 * pasted block and the dummy bleed resistors are multi-line strings, and
 * ngSpice_Circ treats every array entry as exactly ONE card, so before the fix
 * ngspice saw a `.subckt`/`.ends` mismatch and every real model was rejected.
 *
 * Two layers:
 *   - SimHost.loadCircuit accepts entries with embedded newlines (the guard that
 *     keeps any future caller from regressing this);
 *   - the store's validateSubckt, driven through a SimClient backed by a real
 *     SimHost (the exact probe deck the UI builds), accepts a valid paste,
 *     rejects a broken one, resolves on load completion (not the 8 s timer),
 *     leaves the displayed board results alone, and dirties the board deck.
 *
 * Skipped automatically when resources/ngspice/<platform> is missing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
    openBoardFromText(text: string, fileName: string): void
    validateSubckt(
      subcktText: string,
      subcktName: string,
      nodeCount: number
    ): Promise<{ ok: true } | { ok: false; error: string }>
    opVoltages: Map<number, number> | null
    deckDirty: boolean
  }
  setState(partial: Record<string, unknown>): void
}
const STORE_MODULE = '../../renderer/src/store/appStore'
type CreateAppStore = (opts: { simClient: SimClientLike }) => StoreLike

// The first import of the renderer store transforms and evaluates its whole
// module graph (core pipeline, solve seam, models). That is cold-start cost, not
// validation work: it takes ~0.3 s alone but several seconds when many fork
// workers compete for the CPU, and when it ran inside the first test body it
// was charged against that test's 5 s budget (issue #152). Importing at module
// level runs it in the collection phase, which has no per-test timeout, so the
// tests below time only the validation they exercise. Skipped with the suite
// when the bundled ngspice is missing.
const createAppStore: CreateAppStore = haveNgspice
  ? ((await import(/* @vite-ignore */ STORE_MODULE)) as { createAppStore: CreateAppStore })
      .createAppStore
  : () => {
      throw new Error('createAppStore is unavailable: ngspice resources are missing')
    }

const VALID_SUBCKT = [
  '* a hand-written two-pin part',
  '.subckt tsub a b',
  'r1 a b 1000',
  'c1 a b 1p',
  '.ends tsub',
  '',
].join('\n')

// Parses cleanly, but its own 5 V source fights the probe's v_test (which pins
// _tst1 to 0 V), so the dummy op fails ("Transient op failed, timestep too
// small"). The paste is valid; the harness op is not part of the verdict.
const OP_FAILS_SUBCKT = ['.subckt tv a b', 'v1 a 0 5', 'r1 a b 1k', '.ends', ''].join('\n')

// Missing .ends: a genuinely broken paste that must still be rejected.
const BROKEN_SUBCKT = ['.subckt tbad a b', 'r1 a b 1000', ''].join('\n')

/** How one waitFor call ended: by the awaited event, or by the (backstop) timer. */
interface WaitRecord {
  type: SimEvent['type']
  requestedTimeoutMs: number | undefined
  endedBy: 'pending' | 'event' | 'timer'
}

/** Long enough that a slow CI runner never trips it; it only turns a hang into a failure. */
const WAIT_BACKSTOP_MS = 60_000

/**
 * A SimClient over a real in-process SimHost (what the utility process runs).
 *
 * waitFor records how each call ended instead of racing the production timeout
 * (8 s) against the runner's speed: the test asserts on the outcome, never on
 * elapsed wall-clock time.
 */
function createHostClient(): {
  client: SimClientLike
  host: SimHost
  events: SimEvent[]
  waits: WaitRecord[]
  start(): Promise<void>
} {
  const waits: WaitRecord[] = []
  const listeners = new Set<SimEventListener>()
  const events: SimEvent[] = []
  const host = new SimHost({
    emit: (e) => {
      events.push(e)
      for (const l of [...listeners]) l(e)
    },
    disableWatchdog: true,
    disableTimers: true,
  })
  const client: SimClientLike = {
    send(cmd: SimCommand) {
      host.handleCommand(cmd)
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitFor(type, timeoutMs) {
      const record: WaitRecord = { type, requestedTimeoutMs: timeoutMs, endedBy: 'pending' }
      waits.push(record)
      return new Promise((resolve, reject) => {
        const off = client.onEvent((e) => {
          if (e.type === type) {
            clearTimeout(timer)
            off()
            record.endedBy = 'event'
            resolve(e as never)
          }
        })
        const timer = setTimeout(() => {
          off()
          record.endedBy = 'timer'
          reject(new Error(`waitFor('${type}') timed out`))
        }, WAIT_BACKSTOP_MS)
      })
    },
  }
  return { client, host, events, waits, start: () => host.start() }
}

describe.skipIf(!haveNgspice)('issue #18: multi-line subckt through real ngspice', () => {
  let disposeHost: (() => Promise<void>) | null = null
  afterEach(async () => {
    await disposeHost?.()
    disposeHost = null
  })

  it('SimHost.loadCircuit splits entries with embedded newlines into separate cards', async () => {
    const { host, events, start } = createHostClient()
    disposeHost = () => host.dispose()
    await start()

    await host.loadCircuit([
      '* t',
      '.subckt tsub a b\nr1 a b 1000\n.ends',
      'x_test _tst1 _tst2 tsub',
      'r_chk_1 _tst1 0 1000meg\r\nr_chk_2 _tst2 0 1000meg',
      'v_test _tst1 0 dc 0',
      '.op',
      '.end',
    ])
    const op = await host.runOp()

    const errors = events.filter((e) => e.type === 'log' && e.level === 'error')
    expect(errors).toEqual([])
    expect(op['_tst1']).toBeCloseTo(0, 9)
    expect(op['_tst2']).toBeCloseTo(0, 9)
  })

  describe('store.validateSubckt (the exact probe deck the UI builds)', () => {
    const sample = readFileSync(
      join(process.cwd(), 'resources', 'sample', 'first-light.kicad_pcb'),
      'utf-8'
    )

    it('accepts a valid multi-line subckt, promptly, without touching the board readout', async () => {
      const { client, host, waits, start } = createHostClient()
      disposeHost = () => host.dispose()
      await start()
      const store = createAppStore({ simClient: client })
      store.getState().openBoardFromText(sample, 'first-light.kicad_pcb')
      // A displayed board result the probe must not overwrite.
      const shown = new Map<number, number>([[1, 3.3]])
      store.setState({ opVoltages: shown, deckDirty: false })

      const res = await store.getState().validateSubckt(VALID_SUBCKT, 'tsub', 2)

      expect(res).toEqual({ ok: true })
      // Resolves on load completion (the opResult event), not by running out the
      // fallback timer. Asserted on how the wait ended, never on elapsed time:
      // the wall clock says nothing reliable on a slow CI runner.
      expect(waits.filter((w) => w.type === 'opResult').map((w) => w.endedBy)).toEqual(['event'])
      expect(store.getState().opVoltages).toBe(shown)
      // The probe deck replaced the board deck in the live engine.
      expect(store.getState().deckDirty).toBe(true)
    })

    it('rejects a broken paste and reports the ngspice error', async () => {
      const { client, host, waits, start } = createHostClient()
      disposeHost = () => host.dispose()
      await start()
      const store = createAppStore({ simClient: client })
      store.getState().openBoardFromText(sample, 'first-light.kicad_pcb')
      store.setState({ deckDirty: false })

      const res = await store.getState().validateSubckt(BROKEN_SUBCKT, 'tbad', 2)

      expect(res.ok).toBe(false)
      expect(res.ok === false && res.error).toMatch(/subckt/i)
      // A rejected paste also resolves on the opResult event, not the fallback timer.
      expect(waits.filter((w) => w.type === 'opResult').map((w) => w.endedBy)).toEqual(['event'])
      expect(store.getState().deckDirty).toBe(true)
    })

    it('accepts a subckt that parses but whose dummy-harness op fails to converge', async () => {
      const { client, host, events, start } = createHostClient()
      disposeHost = () => host.dispose()
      await start()
      const store = createAppStore({ simClient: client })

      const res = await store.getState().validateSubckt(OP_FAILS_SUBCKT, 'tv', 2)

      // Real ngspice does emit op-phase errors for this probe (the premise)...
      expect(
        events.some((e) => e.type === 'log' && e.level === 'error' && /operating point|Transient op failed/i.test(e.text))
      ).toBe(true)
      // ...but they are not a verdict on the paste.
      expect(res).toEqual({ ok: true })
    })

    it('a valid paste validates again after a rejected one (engine not wedged)', async () => {
      const { client, host, start } = createHostClient()
      disposeHost = () => host.dispose()
      await start()
      const store = createAppStore({ simClient: client })

      const bad = await store.getState().validateSubckt(BROKEN_SUBCKT, 'tbad', 2)
      expect(bad.ok).toBe(false)
      const good = await store.getState().validateSubckt(VALID_SUBCKT, 'tsub', 2)
      expect(good).toEqual({ ok: true })
    })
  })
})
