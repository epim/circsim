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

export async function createRendererStore(): Promise<AppStore> {
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

  // Initial handshake.
  const port = await window.circsim.getSimPort()
  client.attachPort(port)

  return store
}
