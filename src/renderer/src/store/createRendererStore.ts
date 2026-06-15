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

  // Crash recovery: when SimHost dies, the old port is gone. After respawn the
  // supervisor re-runs the handshake and getSimPort() resolves with a new port.
  window.circsim.onSimhostCrashed(async ({ willRespawn }) => {
    store.getState().noteCrash(willRespawn)
    if (!willRespawn) return
    const newPort = await window.circsim.getSimPort()
    client.attachPort(newPort)
    store.getState().replayAfterCrash()
  })

  // Initial handshake runs in the BACKGROUND — the UI must render immediately
  // (empty state, file-open, 3D view all work without the simulator). Blocking
  // boot on the port handshake meant any SimHost hiccup blanked the whole app.
  // Sim actions (Power On / Run) await client readiness on their own.
  void window.circsim
    .getSimPort()
    .then((port) => {
      client.attachPort(port)
    })
    .catch(() => {
      // Leave the client portless; the UI stays usable and sim commands no-op
      // until a port arrives (the store re-sends on crash recovery).
    })

  return store
}
