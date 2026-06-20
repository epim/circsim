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
}

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

declare global {
  interface Window {
    circsim: {
      openFileDialog(opts?: CircsimOpenDialogOptions): Promise<CircsimOpenDialogResult>
      readFile(path: string): Promise<string>
      getSimPort(): Promise<MessagePort>
      onSimhostCrashed(cb: (payload: CircsimCrashedPayload) => void): () => void
      platformPaths(): Promise<CircsimPlatformPaths>
      getSampleProjectPath(): Promise<string>
      /**
       * Absolute path to the bundled "First Light" demo .kicad_pcb (minimal DC
       * LED dimmer). Used by the "Open First Light demo" button.
       */
      getFirstLightDemoPath(): Promise<string>
      /**
       * Open the "what circsim can tell you" fidelity doc in the system viewer.
       * Wired from the fidelity banner and About panel (Task 28, Spec §12, §16 risk 7).
       */
      openDocs(): Promise<void>
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
    }
  }
}

export {}
