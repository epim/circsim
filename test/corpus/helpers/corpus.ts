/**
 * test/corpus/helpers/corpus.ts - manifest access and shared expectations for the
 * corpus suites.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { corpusFile, corpusDir, readManifest } from '../../../scripts/fetch-corpus.mjs'

export interface KnownFailing {
  stage: 'parse' | 'extract' | 'resolve' | 'deck' | 'oracle' | 'op'
  issue: string
  /** Substring the failure message must contain. */
  match: string
  reason: string
}

export interface CorpusEntry {
  id: string
  url: string
  sha256: string
  bytes: number
  license: string
  kicadMajor: number
  formatVersion: number
  source: string
  /** Set false to skip the real-ngspice operating-point stage for this board. */
  op?: boolean
  knownFailing?: KnownFailing
}

export function corpusBoards(): CorpusEntry[] {
  return readManifest().boards as CorpusEntry[]
}

/** Read a board from the cache, failing with the fix when it has not been fetched. */
export function readCorpusBoard(entry: CorpusEntry): string {
  const file = corpusFile(entry) as string
  if (!existsSync(file)) {
    throw new Error(
      `corpus board ${entry.id} is not in ${corpusDir()}. Run: node scripts/fetch-corpus.mjs (npm run test:corpus does this first)`
    )
  }
  return readFileSync(file, 'utf8')
}

/** The `(version N)` stamp in a .kicad_pcb header, or undefined. */
export function boardFormatVersion(text: string): number | undefined {
  const m = /\(version\s+(\d+)\)/.exec(text.slice(0, 600))
  return m ? Number(m[1]) : undefined
}

export const ORACLE_FILE = join(process.cwd(), 'test', 'corpus', 'oracle.json')
export const BASELINE_FILE = join(process.cwd(), 'test', 'corpus', 'baseline.json')
export const METRICS_DIR = join(process.cwd(), 'test-results', 'corpus')
