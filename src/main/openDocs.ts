/**
 * src/main/openDocs.ts
 *
 * The "What can circsim tell you?" link (fidelity banner + About dialog).
 *
 * Electron's `shell.openPath` never rejects: it resolves with an error string on
 * failure and '' on success, so the old handler (try/catch only) could never
 * report a failure. This module keeps the Electron surface behind a narrow
 * `DocsShell` interface so the decision logic runs in plain Node tests, and
 * returns a structured result the renderer can show (issue #62).
 *
 * Route order:
 *  1. Online: hand the published fidelity page to the system browser
 *     (`shell.openExternal`), so the user gets the rendered page the docs
 *     promise instead of a raw file. circsim itself makes no
 *     network request; the browser does.
 *  2. Offline, or the browser hand-off throws: open the bundled HTML copy via
 *     `shell.openPath` and report the error string it resolves with.
 */

/** The published fidelity page (VitePress base is /circsim/). */
export const FIDELITY_DOCS_URL = 'https://epim.github.io/circsim/concepts/fidelity'

/** The slice of Electron's `shell` this module needs. */
export interface DocsShell {
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
}

/** What the renderer receives over the bridge. */
export type OpenDocsResult =
  | { ok: true; target: 'web' | 'local' }
  | { ok: false; error: string }

export interface OpenDocsDeps {
  shell: DocsShell
  /** Absolute path of the bundled what-circsim-can-tell-you.html. */
  localPath: string
  /** OS connectivity flag (Electron `net.isOnline`); not a network request. */
  isOnline: () => boolean
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

/** Open the fidelity doc. Never throws; failures come back as `{ ok: false }`. */
export async function openFidelityDocs(deps: OpenDocsDeps): Promise<OpenDocsResult> {
  const { shell, localPath, isOnline } = deps

  if (isOnline()) {
    try {
      await shell.openExternal(FIDELITY_DOCS_URL)
      return { ok: true, target: 'web' }
    } catch {
      // Fall through to the bundled copy.
    }
  }

  try {
    const err = await shell.openPath(localPath)
    if (err) return { ok: false, error: err }
    return { ok: true, target: 'local' }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}
