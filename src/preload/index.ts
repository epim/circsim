/**
 * src/preload/index.ts
 *
 * Typed contextBridge API exposed to the renderer as `window.circsim`.
 *
 * The preload runs with Node access but the renderer does NOT (contextIsolation:
 * true, nodeIntegration: false — Spec §6). This bridge is the only surface
 * between the renderer and the main process.
 *
 * API:
 *   window.circsim = {
 *     openFileDialog(opts)            → open-dialog result (paths + cancelled flag)
 *     readFile(path)                  → UTF-8 file contents as string
 *     fileExists(path)                → true when the path is an existing regular file
 *     getSimPort()                    → Promise<MessagePort>  (the SimHost port2)
 *     onSimhostCrashed(cb)            → register crash callback ({ willRespawn })
 *     platformPaths()                 → { platform, resourcesPath, appPath, userData }
 *   }
 *
 * Notes:
 *  - `getSimPort` returns a MessagePort transferred via ipcRenderer.on
 *    (the one-time handshake from simhostSupervisor). Calling it multiple times
 *    after a respawn each returns the latest port (re-registered per spawn).
 *  - `onSimhostCrashed` is NOT the MessagePort channel — the port dies with the
 *    process; this callback comes via ipcRenderer.on('circsim:simhostCrashed')
 *    from Main (Spec §6.1).
 */

import { contextBridge, ipcRenderer } from 'electron'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenDialogOptions {
  title?: string
  filters?: { name: string; extensions: string[] }[]
  properties?: ('openFile' | 'openDirectory' | 'multiSelections')[]
}

export interface OpenDialogResult {
  cancelled: boolean
  filePaths: string[]
}

export interface PlatformPaths {
  platform: string
  resourcesPath: string
  appPath: string
  userData: string
}

export interface SimhostCrashedPayload {
  willRespawn: boolean
}

export interface LicenseTexts {
  appVersion: string
  appLicense: string
  ngspiceCopying: string
  licensingDoc: string
  modelProvenance: string
}

export interface ModelLibraryPayload {
  /** Parsed resources/models/index.json entries (LibraryEntry[] for tier-3). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entries: any[]
  /** filename → file contents for every referenced .lib / .json model file. */
  texts: Record<string, string>
}

// ─── Internal state: latest port from the handshake ───────────────────────────

/** Resolvers waiting for the first/next port. */
let portResolvers: ((port: MessagePort) => void)[] = []
/** The latest port received (valid after first handshake). */
let latestPort: MessagePort | null = null

// Listen for the one-time port handshake from the main process. This fires:
//  - once at initial load (onRendererReady in supervisor)
//  - again after each SimHost respawn (supervisor re-runs the handshake)
ipcRenderer.on('simhost-port', (_event, _msg) => {
  // The port arrives via the MessageEvent's ports array (transfer).
  // Electron delivers transferred ports in the ipcRenderer MessageEvent.
  // The main process calls webContents.postMessage('simhost-port', msg, [port2]).
  const port = _event.ports?.[0] as MessagePort | undefined
  if (!port) return

  // Deliver the live MessagePort to the MAIN world via `window.postMessage` with
  // the port in the transfer list. This is the canonical Electron pattern and is
  // RELIABLE across the contextIsolation boundary, whereas returning a
  // MessagePort from a contextBridge-exposed function is not: the bridge proxies
  // the object and the underlying port's message pump stays bound to the preload
  // world, so renderer↔SimHost traffic intermittently went dead in BOTH
  // directions (observed via E2E: child emitted `ready`, renderer never received
  // it; renderer posted `loadCircuit`, child never received it).
  //
  // We do NOT call port.start() here — the main-world consumer
  // (createPortSimClient.attachPort) sets onmessage + start() in the world that
  // actually uses the port.
  window.postMessage('circsim:simhost-port', '*', [port])

  // Keep the legacy getSimPort() promise working too (some callers may still use
  // it): resolve it with the same port. NOTE — the port is transferred by the
  // window.postMessage above, so this reference is now neutered for messaging;
  // the main-world window listener owns the live port. getSimPort() is retained
  // only for API compatibility and resolves so awaiters don't hang.
  latestPort = port
  const resolvers = portResolvers
  portResolvers = []
  for (const resolve of resolvers) {
    resolve(port)
  }
})

// ─── Crash notification (contextBridge path, Spec §6.1) ───────────────────────

/** All registered crash callbacks. */
const crashCallbacks: ((payload: SimhostCrashedPayload) => void)[] = []

ipcRenderer.on('circsim:simhostCrashed', (_event, payload: SimhostCrashedPayload) => {
  for (const cb of crashCallbacks) {
    cb(payload)
  }
})

// ─── Exposed API ─────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('circsim', {
  /**
   * Open a native file-open dialog. Returns the cancelled flag and selected
   * file paths.
   */
  openFileDialog: async (opts: OpenDialogOptions = {}): Promise<OpenDialogResult> => {
    const result = await ipcRenderer.invoke('circsim:openFileDialog', opts)
    return result as OpenDialogResult
  },

  /**
   * Read a file from disk by absolute path. Returns UTF-8 text. Throws if the
   * file does not exist or the path is outside the user's home directory.
   */
  readFile: async (filePath: string): Promise<string> => {
    return ipcRenderer.invoke('circsim:readFile', filePath) as Promise<string>
  },

  /**
   * True when the path exists and is a regular file. Stat-based and non-throwing
   * — used to probe optional sidecar files (sibling .kicad_sch, BOM) before
   * reading, so a missing sidecar never logs an ENOENT stack in main.
   */
  fileExists: async (filePath: string): Promise<boolean> => {
    return ipcRenderer.invoke('circsim:fileExists', filePath) as Promise<boolean>
  },

  /**
   * Return the MessagePort connected to SimHost. Waits for the port handshake
   * if it hasn't happened yet. After a SimHost respawn, call this again to get
   * the new port — old ports are dead.
   *
   * Usage in renderer:
   *   const port = await window.circsim.getSimPort()
   *   port.onmessage = (e) => { ... }
   *   port.postMessage({ type: 'loadCircuit', deckLines: [...] })
   */
  getSimPort: (): Promise<MessagePort> => {
    if (latestPort) return Promise.resolve(latestPort)
    return new Promise<MessagePort>((resolve) => {
      portResolvers.push(resolve)
    })
  },

  /**
   * Register a callback that fires whenever SimHost exits (crash or clean exit).
   * The payload `{ willRespawn: boolean }` indicates whether Main will attempt
   * a respawn. Use this to surface a toast and re-run the port handshake:
   *
   *   window.circsim.onSimhostCrashed(({ willRespawn }) => {
   *     toast('SimHost crashed')
   *     if (willRespawn) {
   *       const port = await window.circsim.getSimPort() // waits for new port
   *       // re-send loadCircuit + replay instrument state
   *     }
   *   })
   *
   * Returns an unsubscribe function.
   */
  onSimhostCrashed: (
    cb: (payload: SimhostCrashedPayload) => void
  ): (() => void) => {
    crashCallbacks.push(cb)
    return () => {
      const idx = crashCallbacks.indexOf(cb)
      if (idx !== -1) crashCallbacks.splice(idx, 1)
    }
  },

  /**
   * Platform and path information for the renderer (e.g., resourcesPath for
   * constructing paths to bundled resources, userData for user library storage).
   */
  platformPaths: (): Promise<PlatformPaths> => {
    return ipcRenderer.invoke('circsim:platformPaths') as Promise<PlatformPaths>
  },

  /**
   * Return the absolute path to the bundled sample project's .kicad_pcb file.
   * Used by the "Open sample project" empty-state button (Spec §11, Task 26).
   */
  getSampleProjectPath: (): Promise<string> => {
    return ipcRenderer.invoke('circsim:getSampleProjectPath') as Promise<string>
  },

  /**
   * Return the absolute path to the bundled "First Light" demo .kicad_pcb (the
   * minimal DC LED dimmer). Used by the "Open First Light demo" button.
   */
  getFirstLightDemoPath: (): Promise<string> => {
    return ipcRenderer.invoke('circsim:getFirstLightDemoPath') as Promise<string>
  },

  /**
   * Open the "what circsim can tell you" fidelity documentation in the
   * system browser. Used by the fidelity banner and About panel (Task 28).
   * Returns a promise that resolves once the open is dispatched.
   */
  openDocs: (): Promise<void> => {
    return ipcRenderer.invoke('circsim:openDocs') as Promise<void>
  },

  /**
   * Return the licensing texts for the About dialog (Task 27, Spec §14):
   * app version + license, the verbatim ngspice COPYING text, the bundled
   * model-library provenance statement, and docs/licensing.md.
   */
  getLicenseTexts: (): Promise<LicenseTexts> => {
    return ipcRenderer.invoke('circsim:getLicenseTexts') as Promise<LicenseTexts>
  },

  /**
   * Return the bundled model library: `{ entries, texts }`. The renderer feeds
   * `entries` to the store's `setLibrary` (tier-3 resolution) at boot and keeps
   * `texts` (filename → contents) so the deck generator can inline the matching
   * .subckt / .model definitions and expand xspice-digital templates from memory.
   */
  getModelLibrary: (): Promise<ModelLibraryPayload> => {
    return ipcRenderer.invoke('circsim:getModelLibrary') as Promise<ModelLibraryPayload>
  },
})
