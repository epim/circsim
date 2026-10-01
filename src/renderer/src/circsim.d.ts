/**
 * renderer/circsim.d.ts
 *
 * Ambient declaration for the contextBridge API the preload exposes as
 * `window.circsim` (see src/preload/index.ts). The shapes are declared inline
 * (rather than imported from the preload) so the web tsconfig does not need to
 * pull electron types into its program.
 */


interface CircsimOpenDialogOptions {
  title?: string
  filters?: { name: string; extensions: string[] }[]
  properties?: ('openFile' | 'openDirectory' | 'multiSelections')[]
}

interface CircsimOpenDialogResult {
  cancelled: boolean
  filePaths: string[]
}

interface CircsimPlatformPaths {
  platform: string
  resourcesPath: string
  appPath: string
  userData: string
}

interface CircsimCrashedPayload {
  willRespawn: boolean
  /** The SimHost child's exit code; null when Electron did not report one. */
  exitCode: number | null
  /** 'watchdog' for exit code 86 (a stuck solve), 'crashed' for anything else. */
  reason: 'watchdog' | 'crashed'
}

interface CircsimDiagnosticsBundleRequest {
  suggestedName: string
  files: { name: string; text: string }[]
}

interface CircsimDiagnosticsBundleResult {
  saved: boolean
  path?: string
  error?: string
}

type CircsimOpenDocsResult =
  | { ok: true; target: 'web' | 'local' }
  | { ok: false; error: string }

interface CircsimLicenseTexts {
  appVersion: string
  appLicense: string
  ngspiceCopying: string
  licensingDoc: string
  modelProvenance: string
}

interface CircsimModelLibrary {
  /** Parsed resources/models/index.json entries (LibraryEntry[] for tier-3). */
  entries: import('../../core/models/types').LibraryEntry[]
  /** filename → file contents for every referenced .lib / .json model file. */
  texts: Record<string, string>
}

interface CircsimSidecarReadResult {
  exists: boolean
  text?: string
  /** The file exists but could not be read. */
  error?: string
}

declare global {
  /**
   * Compile-time constant injected by electron.vite.config.ts (renderer
   * `define`) from package.json — the ONE version string shown in UI chrome.
   */
  const __APP_VERSION__: string

  interface Window {
    circsim: {
      openFileDialog(opts?: CircsimOpenDialogOptions): Promise<CircsimOpenDialogResult>
      /**
       * Read a UTF-8 file by absolute path. Main serves only files the user opened
       * this session (dialog, drop, recent list, bundled sample) and the
       * board-adjacent .kicad_sch / .csv / .lib files beside them; anything else
       * rejects.
       */
      readFile(path: string): Promise<string>
      /**
       * True when the path exists and is a regular file (stat-based, never
       * throws). Probe optional sidecars (sibling .kicad_sch, BOM) with this
       * BEFORE readFile so a missing sidecar never logs an ENOENT stack in main.
       */
      fileExists(path: string): Promise<boolean>
      /**
       * Absolute on-disk path of a dropped File ('' when it has none). Backed by
       * Electron's webUtils.getPathForFile (File.path was removed in Electron 32).
       */
      getPathForFile(file: File): string
      getSimPort(): Promise<MessagePort>
      onSimhostCrashed(cb: (payload: CircsimCrashedPayload) => void): () => void
      platformPaths(): Promise<CircsimPlatformPaths>
      /**
       * Save the diagnostics bundle (issue #26) as a zip via a native save
       * dialog. main adds the environment, SimHost output and crash history.
       */
      saveDiagnosticsBundle(
        req: CircsimDiagnosticsBundleRequest,
      ): Promise<CircsimDiagnosticsBundleResult>
      getSampleProjectPath(): Promise<string>
      /**
       * Absolute path to the bundled "First Light" demo .kicad_pcb (minimal DC
       * LED dimmer). Used by the "Open First Light demo" button.
       */
      getFirstLightDemoPath(): Promise<string>
      /**
       * Open the "what circsim can tell you" fidelity doc (published page in the
       * system browser when online, else the bundled Markdown). Resolves with the
       * outcome so a failure can be shown (issue #62). Wired from the fidelity
       * banner and About panel (Task 28, Spec §12, §16 risk 7).
       */
      openDocs(): Promise<CircsimOpenDocsResult>
      /**
       * Open one page of the public docs site in the system browser by slug
       * (e.g. 'guides/energize'). Resolves true when the OS accepted the open.
       * Optional so tests and non-Electron previews can omit it (issue #73).
       */
      openDocsPage?(slug: string): Promise<boolean>
      /**
       * Licensing texts for the About dialog (Task 27, Spec §14): app license,
       * verbatim ngspice COPYING, model-library provenance, docs/licensing.md.
       */
      getLicenseTexts(): Promise<CircsimLicenseTexts>
      /**
       * Bundled model library (tier-3 resolution + deck-gen definitions). The
       * store calls this at boot, feeds `entries` to setLibrary, and keeps
       * `texts` for the deck generator to inline .subckt/.model definitions.
       */
      getModelLibrary(): Promise<CircsimModelLibrary>
      /**
       * Read the per-board setup file (`<board>.circsim.json`) beside a board.
       * Never rejects. Issue #27.
       */
      readSidecar(boardPath: string): Promise<CircsimSidecarReadResult>
      /**
       * Write the setup file beside a board (atomic). `backupExisting` keeps the
       * previous file as `<file>.bak`. Rejects on failure.
       */
      writeSidecar(boardPath: string, text: string, opts?: { backupExisting?: boolean }): Promise<{ path: string }>
      /** Recently opened boards, most recent first. */
      getRecentBoards(): Promise<string[]>
      addRecentBoard(boardPath: string): Promise<string[]>
      removeRecentBoard(boardPath: string): Promise<string[]>
      clearRecentBoards(): Promise<string[]>
      /**
       * Save a report through the native save dialog. `pdf` content is the
       * standalone report HTML, printed to PDF by the main process.
       */
      exportReport(req: {
        format: 'md' | 'pdf'
        content: string
        suggestedName: string
      }): Promise<{ cancelled: boolean; filePath?: string }>
    }
  }
}

export {}
