// Build-time data for the gallery page. Reads the pinned real-board corpus
// manifest and the committed metrics baseline, so the table cannot drift from
// what `npm run test:corpus` actually measured. Nothing from the boards
// themselves is read or copied: only the manifest rows and the metrics.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const MANIFEST = resolve(here, '../../scripts/corpus-manifest.json')
const BASELINE = resolve(here, '../../test/corpus/baseline.json')

interface ManifestBoard {
  id: string
  url: string
  license: string
  kicadMajor: number
  source: string
  knownFailing?: { issue: string }
}

interface Metrics {
  footprints: number
  nets: number
  tracks: number
  vias: number
  zones: number
  stubbedPct: number
  islands: number | null
}

export interface GalleryRow {
  id: string
  source: string
  sourceUrl: string
  license: string
  kicadMajor: number
  /** null when circsim cannot open the file today (a known-failing board). */
  metrics: Metrics | null
  knownFailingIssue: string | null
}

/** raw.githubusercontent.com/<o>/<r>/<ref>/<path> becomes the github.com blob page for the same file. */
function blobUrl(raw: string): string {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(raw)
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/${m[4]}` : raw
}

declare const data: GalleryRow[]
export { data }

export default {
  watch: [MANIFEST, BASELINE],
  load(): GalleryRow[] {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { boards: ManifestBoard[] }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, Metrics>
    return manifest.boards.map((b) => ({
      id: b.id,
      source: b.source,
      sourceUrl: blobUrl(b.url),
      license: b.license,
      kicadMajor: b.kicadMajor,
      metrics: baseline[b.id] ?? null,
      knownFailingIssue: b.knownFailing ? b.knownFailing.issue : null,
    }))
  },
}
