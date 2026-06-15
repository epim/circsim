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
       * Open the "what circsim can tell you" fidelity doc in the system viewer.
       * Wired from the fidelity banner and About panel (Task 28, Spec §12, §16 risk 7).
       */
      openDocs(): Promise<void>
      /**
       * Licensing texts for the About dialog (Task 27, Spec §14): app license,
       * verbatim ngspice COPYING, model-library provenance, docs/licensing.md.
       */
      getLicenseTexts(): Promise<CircsimLicenseTexts>
    }
  }
}

export {}
