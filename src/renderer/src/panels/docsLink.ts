/**
 * renderer/panels/docsLink.ts (issue #62)
 *
 * Shared click handler for the "What can circsim tell you?" links (fidelity
 * banner, About dialog). The main process now resolves `openDocs` with an
 * outcome; a failure becomes an inline message that names the published page,
 * so the click is never silent.
 */

/** Where to read the fidelity page by hand when the app could not open it. */
export const DOCS_FALLBACK_URL = 'https://epim.github.io/circsim/concepts/fidelity'

/** Plain-language failure line shown next to the link. */
export function docsFailureMessage(reason: string): string {
  return `Could not open the docs (${reason}). You can read the page at ${DOCS_FALLBACK_URL}`
}

interface DocsBridge {
  openDocs(): Promise<{ ok: true; target: 'web' | 'local' } | { ok: false; error: string }>
}

/**
 * Call the bridge and report the outcome through `onMessage` (null clears the
 * message). A missing bridge (browser preview, SSR test) is a quiet no-op.
 */
export async function openDocsAndReport(
  bridge: DocsBridge | undefined,
  onMessage: (message: string | null) => void,
): Promise<void> {
  if (!bridge?.openDocs) return
  try {
    const res = await bridge.openDocs()
    onMessage(res.ok ? null : docsFailureMessage(res.error))
  } catch (e) {
    onMessage(docsFailureMessage(e instanceof Error ? e.message : String(e)))
  }
}
