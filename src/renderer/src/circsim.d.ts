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

declare global {
  interface Window {
    circsim: {
      openFileDialog(opts?: CircsimOpenDialogOptions): Promise<CircsimOpenDialogResult>
      readFile(path: string): Promise<string>
      getSimPort(): Promise<MessagePort>
      onSimhostCrashed(cb: (payload: CircsimCrashedPayload) => void): () => void
      platformPaths(): Promise<CircsimPlatformPaths>
    }
  }
}

export {}
