/**
 * renderer/store/createRendererStore.ts — Task 21
 *
 * Wires the production app store to the live SimHost MessagePort and the crash
 * channel. Kept out of appStore.ts so the store core stays Electron-free and
 * unit-testable with an injected mock.
 *
 * Flow:
 *   1. create a PortSimClient (no port yet — handshake may not have happened).
 *   2. create the store with that client injected.
 *   3. await the first port and attachPort.
 *   4. subscribe to crashes: on respawn, await the new port, attachPort, and
 *      replay the deck + instrument state (Spec §6.1 routine crash recovery).
 */

import { createAppStore, type AppStore } from './appStore'
import { createPortSimClient } from '../ipc/simClient'

export function createRendererStore(): AppStore {
  const client = createPortSimClient()
  const store = createAppStore({ simClient: client })

  // The live SimHost MessagePort is delivered to the MAIN world by the preload
  // via `window.postMessage('circsim:simhost-port', '*', [port])` — the canonical
  // Electron pattern that reliably transfers a MessagePort across the
  // contextIsolation boundary (returning one from a contextBridge function does
  // NOT reliably transfer the live port). This listener runs in the main world,
  // so the port it receives is a real, fully-functional MessagePort.
  //
  // It fires once at initial load AND again after each SimHost respawn (the
  // supervisor re-runs the handshake → preload re-forwards a fresh port). On the
  // FIRST port we just attach; on SUBSEQUENT ports (a respawn) we attach + replay
  // the deck/instrument state (Spec §6.1).
  let attachedOnce = false
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data !== 'circsim:simhost-port') return
    const port = e.ports?.[0]
    if (!port) return
    client.attachPort(port)
    if (attachedOnce) {
      // A respawn delivered a fresh port — replay so the bench resumes.
      store.getState().replayAfterCrash()
    }
    attachedOnce = true
  })

  // Crash recovery notice: when SimHost dies, surface the toast. The fresh port
  // arrives via the window 'message' listener above (which also replays), so we
  // only record the crash notice here.
  window.circsim.onSimhostCrashed(({ willRespawn }) => {
    store.getState().noteCrash(willRespawn)
  })

  // Load the bundled model library in the BACKGROUND too (tier-3 resolution +
  // deck-gen definitions). Without this, tier-3 parts (e.g. the sample's LED)
  // show "unresolved" and subckt/model-card/digital definitions never get
  // inlined into the deck. setModelLibrary re-resolves, so any board already
  // open picks up the new tier-3 matches. Best-effort: a failure leaves the
  // store with no library (tiers 1/2/6 still work).
  void window.circsim
    .getModelLibrary()
    .then(({ entries, texts }) => {
      store.getState().setModelLibrary(entries, texts)
    })
    .catch((err: unknown) => {
      // The bundled model library failed to load — tier-3 resolution is disabled,
      // so LEDs / ICs (and any subckt/model-card/digital part) will show as
      // UNRESOLVED and their definitions won't be inlined into the deck. Surface
      // this instead of swallowing it silently, so the failure is diagnosable.
      const detail = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.warn('[circsim] bundled model library failed to load:', detail)
      store.setState(s => ({
        logLines: [
          ...s.logLines,
          {
            level: 'warn' as const,
            text:
              'Bundled model library failed to load — LEDs and ICs will be unresolved ' +
              `until it is available (${detail}).`,
          },
        ].slice(-2000),
      }))
    })

  return store
}
