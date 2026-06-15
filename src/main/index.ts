/**
 * src/main/index.ts
 *
 * Electron main process:
 *  - Creates the BrowserWindow with contextIsolation + the preload bridge.
 *  - Starts the SimhostSupervisor after app.whenReady().
 *  - Does the ONE-TIME port handshake: port1 → child, port2 → renderer via
 *    webContents.postMessage. Main is NOT in the steady-state message path
 *    after the handshake (Spec §6).
 *  - Notifies the renderer via contextBridge when SimHost crashes (the dead
 *    MessagePort cannot carry this event — Spec §6.1).
 *  - CSP: allows worker-src blob: for troika-three-text (Spec §5).
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { createProductionSupervisor, unwrapPort } from './simhostSupervisor'

// ─── Globals ──────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

/**
 * Base for bundled resources/docs.
 *  - Packaged (asar): extraResources land directly under process.resourcesPath
 *    (e.g. <resources>/sample, <resources>/ngspice, <resources>/docs).
 *  - Dev / Playwright-launched: main is at <repoRoot>/out/main/index.js, so the
 *    repo root is two levels up from __dirname. We resolve resources/docs from
 *    there rather than from app.getAppPath() — which returns the main script's
 *    own dir when Electron is launched with an explicit script path.
 */
const repoRoot = join(__dirname, '..', '..')
function resourcePath(...parts: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...parts) : join(repoRoot, 'resources', ...parts)
}
function docPath(...parts: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, 'docs', ...parts) : join(repoRoot, 'docs', ...parts)
}

// ─── Window creation ──────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'circsim',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // CSP: worker-src blob: is required by troika-three-text (Spec §5).
      // The Content-Security-Policy header is set below via session handler.
    }
  })

  // Set CSP via the will-navigate response, or use webContents session.
  // For development and production: inject CSP via a handler on the session.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';" +
          " script-src 'self' 'unsafe-inline';" +
          " style-src 'self' 'unsafe-inline';" +
          " worker-src blob:;" +
          " connect-src 'self';" +
          " img-src 'self' data: blob:;"
        ]
      }
    })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// ─── IPC handlers for the preload bridge ─────────────────────────────────────

function registerIpcHandlers(): void {
  /** Open a native file dialog (renderer calls via contextBridge). */
  ipcMain.handle('circsim:openFileDialog', async (_event, opts: Electron.OpenDialogOptions) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, opts)
    return result
  })

  /** Read a file from disk (renderer calls via contextBridge). */
  ipcMain.handle('circsim:readFile', async (_event, filePath: string) => {
    const buf = await readFile(filePath)
    return buf.toString('utf8')
  })

  /** Return platform path information. */
  ipcMain.handle('circsim:platformPaths', () => {
    return {
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      userData: app.getPath('userData')
    }
  })

  /**
   * Return the absolute path to the bundled sample project's .kicad_pcb file.
   * In dev: <appRoot>/resources/sample/blinker-555.kicad_pcb.
   * Packaged: <resourcesPath>/sample/blinker-555.kicad_pcb (via extraResources).
   */
  ipcMain.handle('circsim:getSampleProjectPath', () => {
    return resourcePath('sample', 'blinker-555.kicad_pcb')
  })

  /**
   * Open the "what circsim can tell you" fidelity doc.
   * In packaged builds, open the bundled docs/what-circsim-can-tell-you.md
   * via shell.openPath (rendered as plain text). In dev, open it from the
   * project root. If the file is not found, fall back to a no-op (graceful).
   * Task 28 — Spec §16 risk 7, §12.
   */
  ipcMain.handle('circsim:openDocs', async () => {
    try {
      await shell.openPath(docPath('what-circsim-can-tell-you.md'))
    } catch {
      // Non-fatal: if the doc isn't present (CI runner without a display),
      // the promise still resolves so the UI doesn't stall.
    }
  })

  /**
   * Return the licensing texts surfaced in the About dialog (Task 27, Spec §14):
   *  - appVersion + appLicense (MIT)
   *  - ngspiceCopying: the verbatim ngspice COPYING file shipped beside the
   *    binaries (resources/ngspice/COPYING in dev; <resources>/ngspice/COPYING
   *    when packaged via extraResources)
   *  - modelProvenance: the in-house model-library provenance statement
   *  - licensingDoc: docs/licensing.md (the Spec §14 table, expanded)
   * Each text read is best-effort; a missing file yields an empty string rather
   * than rejecting (the About panel falls back to its built-in summary).
   */
  ipcMain.handle('circsim:getLicenseTexts', async () => {
    const tryRead = async (p: string): Promise<string> => {
      try {
        return (await readFile(p)).toString('utf8')
      } catch {
        return ''
      }
    }
    const [ngspiceCopying, licensingDoc] = await Promise.all([
      tryRead(resourcePath('ngspice', 'COPYING')),
      tryRead(docPath('licensing.md'))
    ])
    return {
      appVersion: app.getVersion(),
      appLicense: 'MIT',
      ngspiceCopying,
      licensingDoc,
      modelProvenance:
        'The bundled SPICE model library was written in-house for circsim from ' +
        'public datasheet parameters and is MIT-licensed. Each file in ' +
        'resources/models/ carries a "Provenance:" header. No vendor (TI/ADI/' +
        'onsemi) or Micro-Cap/Intusoft model text is included. The GPL-encumbered ' +
        'ngspice "table.cm" code model is excluded from every platform bundle.'
    }
  })
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  registerIpcHandlers()

  mainWindow = createWindow()

  // Build the simhost output path RELATIVE TO THE MAIN SCRIPT (__dirname). main
  // is always at <base>/main/index.js and simhost at <base>/simhost/index.js,
  // where <base> is `out` in dev and `…/resources/app.asar/out` when packaged.
  // This is correct for ALL launch modes — electron-vite dev, a Playwright
  // `electron out/main/index.js` launch, and a packaged asar build — whereas
  // `app.getAppPath()` returns the main script's own dir when Electron is given
  // an explicit script path (yielding the wrong `out/main/out/simhost`).
  // utilityProcess.fork can load from inside asar; koffi's native addon is
  // asarUnpack'd, so `require('koffi')` still resolves to a real on-disk path.
  const simhostPath = join(__dirname, '..', 'simhost', 'index.js')

  // Boot the supervisor. The `onSimhostCrashed` callback delivers the crash
  // notification via contextBridge (not the dead MessagePort — Spec §6.1).
  const supervisor = await createProductionSupervisor({
    simhostPath,
    onSimhostCrashed: ({ willRespawn }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('circsim:simhostCrashed', { willRespawn })
      }
    }
  })

  // Wrap the BrowserWindow's webContents with the PortHandle interface.
  supervisor.setWebContents({
    isDestroyed: () => mainWindow?.isDestroyed() ?? true,
    postMessage: (channel, msg, ports) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Electron's webContents.postMessage(channel, message, [transfer]) needs
        // RAW MessagePortMain objects — unwrap the PortHandle wrappers (passing
        // the wrappers silently failed to transfer the port → renderer hung).
        mainWindow.webContents.postMessage(
          channel,
          msg,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ports ?? []).map(unwrapPort) as any
        )
      }
    }
  })

  // Start the first SimHost spawn.
  supervisor.start()

  // Deliver port2 to the renderer when the page is ready.
  mainWindow.webContents.on('did-finish-load', () => {
    supervisor.onRendererReady()
    // Let the renderer know the simhost is ready (initial log).
    if (mainWindow && !mainWindow.isDestroyed()) {
      // eslint-disable-next-line no-console
      console.log('[main] renderer ready — simhost port handshake complete')
    }
  })

  mainWindow.on('closed', () => {
    supervisor.dispose()
    mainWindow = null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
