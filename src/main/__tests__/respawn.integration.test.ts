/**
 * src/main/__tests__/respawn.integration.test.ts
 *
 * Council review focus 5 (issues #16 and #75): a SimHost crash while the bench is
 * PAUSED. Wires the REAL pieces end to end, in one Node process:
 *
 *   real SimhostSupervisor  ->  fake child that hosts a REAL SimHost (real
 *   libngspice) on a real Node MessageChannel  ->  real PortSimClient  ->  real
 *   app store (run / pause / replayAfterCrash / run).
 *
 * The only stand-ins are the two Electron edges: `fork` (a fake child whose
 * "kill" disposes the SimHost and fires the exit listener) and `webContents`
 * (which does what createRendererStore does on 'circsim:simhost-port': attach
 * the new port and, from the second port on, call replayAfterCrash). The true
 * process-level kill is covered by the Electron E2E suite; this test pins the
 * supervisor/store/SimHost contract.
 *
 * Asserts: after the kill the supervisor re-delivers a fresh port2 with no manual
 * onRendererReady() call, the store drops the lost pause to idle with a notice
 * (nothing streams on the fresh host), and Run then does a fresh start and
 * streams samples again.
 *
 * Type-check note: this file spans the main, simhost and renderer projects, which
 * the composite tsconfigs cannot reference together, so tsconfig.node.json
 * excludes it. Vitest (esbuild) runs it; eslint still lints it.
 *
 * Skipped automatically when resources/ngspice/<platform> is missing. Wired into
 * `npm run test:integration`.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { MessageChannel } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'

import {
  SimhostSupervisor,
  unwrapPort,
  type ChildHandle,
  type PortHandle,
  type PortPair
} from '../simhostSupervisor'
import { SimHost } from '../../simhost'
import { ngspiceResourcesAvailable } from '../../simhost/ngspiceFfi'
import type { SimCommand, SimEvent } from '../../simhost/protocol'
import { createAppStore } from '../../renderer/src/store/appStore'
import { createPortSimClient } from '../../renderer/src/ipc/simClient'

const haveNgspice = ngspiceResourcesAvailable()

const fixturesDir = join(__dirname, '../../../fixtures')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(20)
  }
}

/** Wrap a Node MessagePort as the supervisor's PortHandle (keeps the raw port). */
function wrap(p: import('node:worker_threads').MessagePort): PortHandle {
  return {
    __raw: p,
    start: () => p.start(),
    close: () => p.close(),
    postMessage: (msg) => p.postMessage(msg),
    on: (event, listener) => p.on(event, listener as (...a: unknown[]) => void),
    off: (event, listener) => p.off(event, listener as (...a: unknown[]) => void)
  }
}

describe.skipIf(!haveNgspice)('SimHost crash while paused (real ngspice, #16 + #75)', () => {
  it('re-delivers the port on respawn, comes back idle with a notice, and Run streams again', async () => {
    // ── the fake child: hosts a real SimHost on the port1 it is handed ────────
    const hosts: SimHost[] = []
    let exitListener: ((code: number) => void) | null = null
    const disposers: (() => Promise<void>)[] = []

    const fork = (): ChildHandle => ({
      postMessage(_msg, ports) {
        const port1 = unwrapPort(ports?.[0]) as import('node:worker_threads').MessagePort
        const host = new SimHost({ emit: (ev: SimEvent) => { try { port1.postMessage(ev) } catch { /* closed */ } } })
        hosts.push(host)
        // Gate intake until start() resolves, exactly as the production bootstrap.
        let started = false
        const pending: SimCommand[] = []
        port1.on('message', (data: SimCommand) => {
          if (started) host.handleCommand(data)
          else pending.push(data)
        })
        void host.start().then(() => {
          started = true
          for (const c of pending.splice(0)) host.handleCommand(c)
        })
        // Idempotent: the test kills the child itself, and supervisor.dispose()
        // kills whichever child is current again at teardown.
        let done: Promise<void> | null = null
        disposers.push(() => {
          done ??= (async () => {
            port1.removeAllListeners('message')
            port1.close()
            await host.dispose()
          })()
          return done
        })
      },
      kill: () => {
        void disposers[disposers.length - 1]?.()
      },
      on: (_event, listener) => {
        exitListener = listener
      },
      off: () => {
        exitListener = null
      }
    })

    const portPairFactory = (): PortPair => {
      const ch = new MessageChannel()
      return { port1: wrap(ch.port1), port2: wrap(ch.port2) }
    }

    // ── the renderer edge: what createRendererStore does on each delivered port ─
    const client = createPortSimClient()
    const store = createAppStore({ simClient: client })
    let deliveries = 0
    const wc = {
      isDestroyed: () => false,
      postMessage: (channel: string, _msg: unknown, transfer?: PortHandle[]) => {
        if (channel !== 'simhost-port') return
        const port2 = unwrapPort(transfer?.[0]) as MessagePort
        client.attachPort(port2)
        deliveries++
        if (deliveries > 1) store.getState().replayAfterCrash()
      }
    }

    // Count streamed sample batches and vector announcements from the live port.
    let sampleBatches = 0
    let vectorEvents = 0
    client.onEvent((ev) => {
      if (ev.type === 'samples') sampleBatches++
      else if (ev.type === 'vectors') vectorEvents++
    })

    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.setWebContents(wc)

    try {
      // ── bench set up and running ───────────────────────────────────────────
      store
        .getState()
        .openBoardFromText(readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'), 'fixture-rc.kicad_pcb')
      const vinId = store.getState().circuit!.nets.find((n) => n.kicadName === 'VIN')!.id
      store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })

      supervisor.start()
      supervisor.onRendererReady() // did-finish-load: the ONLY call this test makes
      expect(deliveries).toBe(1)

      store.getState().run()
      expect(store.getState().simState).toBe('running')
      await waitFor(() => sampleBatches > 0, 20_000, 'first samples from the first SimHost')

      // ── pause, let it go quiet ─────────────────────────────────────────────
      store.getState().pause()
      expect(store.getState().simState).toBe('paused')
      expect(store.getState().deckDirty).toBe(false)
      await sleep(500)
      const batchesAtPause = sampleBatches
      await sleep(500)
      expect(sampleBatches).toBe(batchesAtPause)

      // ── kill the child while paused ────────────────────────────────────────
      const vectorsBeforeCrash = vectorEvents
      expect(hosts.length).toBe(1)
      await disposers[0]!() // SimHost gone, port closed (ngspice is process-global: drain first)
      store.getState().noteCrash(true)
      exitListener!(1) // the supervisor sees the exit and schedules the respawn

      // The respawn (250 ms backoff) must re-deliver the port with no help.
      await waitFor(() => deliveries === 2, 10_000, 'port re-delivery after the respawn')
      expect(hosts.length).toBe(2)

      // replayAfterCrash reloaded the deck on the fresh host and dropped the
      // (unrecoverable) pause to idle, with a notice. Nothing streams.
      await sleep(700)
      expect(store.getState().simState).toBe('idle')
      expect(store.getState().crashNotice).toMatchObject({ willRespawn: true, pausedRunLost: true })
      const batchesAfterRespawn = sampleBatches
      await sleep(700)
      expect(sampleBatches).toBe(batchesAfterRespawn)

      // ── Run works on the new process: fresh start streams samples again ────
      store.getState().run()
      expect(store.getState().simState).toBe('running')
      await waitFor(() => sampleBatches > batchesAfterRespawn, 20_000, 'samples after Run on the respawned SimHost')
      expect(vectorEvents).toBeGreaterThan(vectorsBeforeCrash)
      await waitFor(() => store.getState().simTimeSeconds > 0, 10_000, 'a status report from the new SimHost')
    } finally {
      supervisor.dispose()
      for (const d of disposers) await d()
    }
  }, 90_000)
})
