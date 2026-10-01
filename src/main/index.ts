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

import { app, BrowserWindow, ipcMain, dialog, shell, net } from 'electron'
import { join } from 'path'
import { copyFile, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { createProductionSupervisor, unwrapPort } from './simhostSupervisor'
import { openFidelityDocs } from './openDocs'
import { sidecarPathFor } from '../core/persist/paths'
import { MAX_SIDECAR_BYTES } from '../core/persist/sidecar'
import { addRecent, normalizeRecent, removeRecent } from '../core/persist/recent'

/** Shape of resources/models/index.json (only the fields we read here). */
interface ModelIndex {
  entries: {
    id: string
    model?: { type?: string; file?: string; name?: string }
    [k: string]: unknown
  }[]
}

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

// ─── GPU fallback ─────────────────────────────────────────────────────────────

// The Chromium in Electron 44 no longer falls back to SwiftShader for WebGL
// on machines without a usable GPU (headless Linux CI under xvfb, VMs, remote
// desktops): WebGL2 is blocklisted, `new WebGLRenderer` in the viewport throws,
// and no board ever renders. Opting in to the software rasterizer restores the
// older fallback behaviour. It only takes effect when no hardware GPU path is
// available, and the app loads only local content, so the "unsafe" caveat on
// the flag (untrusted web content) does not apply. Must run before app ready.
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

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

// ─── Report export ────────────────────────────────────────────────────────────

/**
 * Render a standalone report HTML page to PDF in a hidden, script-disabled,
 * sandboxed window. The page goes through a temp file (a data: URL would hit
 * URL length limits on a large board) which is removed afterwards.
 */
async function renderPdf(html: string): Promise<Buffer> {
  const tmp = join(app.getPath('temp'), `circsim-report-${process.pid}-${Date.now()}.html`)
  await writeFile(tmp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await win.loadFile(tmp)
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
  } finally {
    win.destroy()
    await unlink(tmp).catch(() => undefined)
  }
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

  /**
   * True when `filePath` exists and is a regular file (stat-based, never
   * throws). The renderer uses this to probe OPTIONAL sidecar files (sibling
   * .kicad_sch, BOM) before reading them, so a missing sidecar doesn't spray an
   * "Error occurred in handler for 'circsim:readFile'" ENOENT stack into the
   * main-process log on every board open. Required files are still read
   * directly and error loudly.
   */
  ipcMain.handle('circsim:fileExists', async (_event, filePath: string) => {
    try {
      return (await stat(filePath)).isFile()
    } catch {
      return false
    }
  })

  // ── Per-board setup file (`<board>.circsim.json`, issue #27) ──────────────────
  // The renderer never supplies a destination path: both handlers take the BOARD
  // path and derive the sidecar name from it (sidecarPathFor refuses anything that
  // is not a .kicad_pcb), so this bridge can read and write exactly one kind of
  // file and can never touch the board itself.

  /** Read the setup file beside a board. Never throws: absent, text, or an error string. */
  ipcMain.handle('circsim:readSidecar', async (_event, boardPath: string) => {
    const p = typeof boardPath === 'string' ? sidecarPathFor(boardPath) : null
    if (!p) return { exists: false }
    try {
      const st = await stat(p)
      if (!st.isFile()) return { exists: false }
      if (st.size > MAX_SIDECAR_BYTES) return { exists: true, error: 'the file is larger than 8 MB' }
      return { exists: true, text: (await readFile(p)).toString('utf8') }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
      return { exists: true, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Write the setup file beside a board, atomically (temp file + rename). With
   * `backupExisting` the current file is first copied to `<file>.bak`, used for
   * the first write over an old-format, truncated or unreadable file.
   */
  ipcMain.handle(
    'circsim:writeSidecar',
    async (_event, boardPath: string, text: string, opts?: { backupExisting?: boolean }) => {
      const p = typeof boardPath === 'string' ? sidecarPathFor(boardPath) : null
      if (!p) throw new Error('Not a .kicad_pcb path; refusing to write a setup file.')
      if (typeof text !== 'string' || text.length > MAX_SIDECAR_BYTES) throw new Error('Setup text is not valid.')
      if (opts?.backupExisting) {
        try {
          await copyFile(p, p + '.bak')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }
      const tmp = `${p}.${process.pid}.tmp`
      try {
        await writeFile(tmp, text, 'utf8')
        await rename(tmp, p)
      } catch (err) {
        await unlink(tmp).catch(() => undefined)
        throw err
      }
      return { path: p }
    },
  )

  // ── Recent boards (userData/recent-boards.json) ────────────────────────────────
  const recentFile = (): string => join(app.getPath('userData'), 'recent-boards.json')
  const readRecent = async (): Promise<string[]> => {
    try {
      return normalizeRecent(JSON.parse((await readFile(recentFile())).toString('utf8')))
    } catch {
      return []
    }
  }
  const writeRecent = async (list: string[]): Promise<string[]> => {
    try {
      await writeFile(recentFile(), JSON.stringify({ boards: list }, null, 2), 'utf8')
    } catch {
      // Best effort: a read-only profile just means no recent list.
    }
    return list
  }
  ipcMain.handle('circsim:getRecentBoards', () => readRecent())
  ipcMain.handle('circsim:addRecentBoard', async (_event, boardPath: string) =>
    writeRecent(addRecent(await readRecent(), boardPath)),
  )
  ipcMain.handle('circsim:removeRecentBoard', async (_event, boardPath: string) =>
    writeRecent(removeRecent(await readRecent(), boardPath)),
  )
  ipcMain.handle('circsim:clearRecentBoards', () => writeRecent([]))

  // ── Report export (markdown or PDF) ────────────────────────────────────────────
  // The save location always comes from the native save dialog; the renderer only
  // supplies the content and a suggested file name.
  ipcMain.handle(
    'circsim:exportReport',
    async (_event, req: { format: 'md' | 'pdf'; content: string; suggestedName: string }) => {
      if (!mainWindow) return { cancelled: true }
      if (!req || (req.format !== 'md' && req.format !== 'pdf') || typeof req.content !== 'string') {
        throw new Error('Invalid report export request.')
      }
      if (req.content.length > 16 * 1024 * 1024) throw new Error('The report is too large to export.')
      const safeName = String(req.suggestedName || 'circsim-report')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .slice(0, 120)
      const ext = req.format
      const result = await dialog.showSaveDialog(mainWindow, {
        title: ext === 'md' ? 'Export report as markdown' : 'Export report as PDF',
        defaultPath: `${safeName}.${ext}`,
        filters: [ext === 'md' ? { name: 'Markdown', extensions: ['md'] } : { name: 'PDF', extensions: ['pdf'] }],
      })
      if (result.canceled || !result.filePath) return { cancelled: true }
      const filePath = result.filePath.toLowerCase().endsWith(`.${ext}`) ? result.filePath : `${result.filePath}.${ext}`
      if (ext === 'md') {
        await writeFile(filePath, req.content, 'utf8')
      } else {
        await writeFile(filePath, await renderPdf(req.content))
      }
      return { cancelled: false, filePath }
    },
  )

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
   * Return the absolute path to the bundled "First Light" demo .kicad_pcb — the
   * minimal DC LED dimmer (VIN → R1 → D1 → GND) used by the Energize / first-run
   * experience. Same dev/packaged resolution as getSampleProjectPath.
   */
  ipcMain.handle('circsim:getFirstLightDemoPath', () => {
    return resourcePath('sample', 'first-light.kicad_pcb')
  })

  /**
   * Open the "what circsim can tell you" fidelity doc and report the outcome.
   * Online: the published page via the system browser; offline (or if that
   * hand-off throws): the bundled docs/what-circsim-can-tell-you.html (rendered
   * from website/docs/concepts/fidelity.md by scripts/fidelity-doc.mjs) via
   * shell.openPath. Packaged: <resources>/docs; dev: the project docs/ dir.
   * shell.openPath never rejects, so its resolved error string is returned to
   * the renderer as `{ ok: false, error }` (issue #62).
   * Task 28 — Spec §16 risk 7, §12; issues #61, #62.
   */
  ipcMain.handle('circsim:openDocs', () =>
    openFidelityDocs({
      shell,
      localPath: docPath('what-circsim-can-tell-you.html'),
      isOnline: () => net.isOnline()
    })
  )

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
        'onsemi) or Micro-Cap/Intusoft model text is included. The discrete diode, ' +
        'LED and transistor cards are derived from datasheet operating points by ' +
        'the checked-in script scripts/fit-model-cards.mjs, and a CI fingerprint ' +
        'test rejects any card that reproduces a known third-party library card. ' +
        'The GPL-encumbered ngspice "table.cm" code model is excluded from every ' +
        'platform bundle.'
    }
  })

  /**
   * Return the bundled model library (tier-3 resolution + deck-gen inputs).
   *
   *  - `entries`: the parsed `resources/models/index.json` entries (the
   *    LibraryEntry list the renderer feeds to `setLibrary` for tier-3 matching).
   *  - `texts`:   filename → file contents for every `.lib`/`.json` referenced by
   *    an entry's `model.file`. The deck generator inlines the matching
   *    `.subckt`/`.model` block (subckts/model-cards) and expands the
   *    xspice-digital templates from these texts (ngspice loads decks from memory,
   *    so definitions are inlined — never `.include`d by path).
   *
   * Resources are resolved the SAME way as the other handlers (resourcePath):
   * packaged → process.resourcesPath; dev/Playwright → <repoRoot>/resources.
   * Every read is best-effort; a missing file is omitted rather than rejecting,
   * so the renderer always gets at least the entries it can match on.
   */
  ipcMain.handle('circsim:getModelLibrary', async () => {
    const tryRead = async (p: string): Promise<string | null> => {
      try {
        return (await readFile(p)).toString('utf8')
      } catch {
        return null
      }
    }

    const indexText = await tryRead(resourcePath('models', 'index.json'))
    if (!indexText) return { entries: [], texts: {} }

    let parsed: ModelIndex
    try {
      parsed = JSON.parse(indexText) as ModelIndex
    } catch {
      return { entries: [], texts: {} }
    }

    const entries = Array.isArray(parsed.entries) ? parsed.entries : []

    // Collect the unique set of files referenced by entry.model.file and read
    // each once (a single .lib/.json backs many entries).
    const fileNames = new Set<string>()
    for (const e of entries) {
      const f = e.model?.file
      if (typeof f === 'string' && f.length > 0) fileNames.add(f)
    }

    const texts: Record<string, string> = {}
    await Promise.all(
      [...fileNames].map(async (name) => {
        const content = await tryRead(resourcePath('models', name))
        if (content !== null) texts[name] = content
      })
    )

    return { entries, texts }
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
