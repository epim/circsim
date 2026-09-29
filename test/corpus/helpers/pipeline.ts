/**
 * test/corpus/helpers/pipeline.ts - the pure-TypeScript board-to-deck pipeline
 * as the app runs it: parseBoard -> extract -> resolveAll -> generateDeck.
 *
 * Shared by the corpus, private-board and synthetic-board suites so every one of
 * them measures the same thing.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { parseBoard } from '../../../src/core/kicad/board'
import type { BoardModel } from '../../../src/core/kicad/types'
import { parseSchematicSimData } from '../../../src/core/kicad/schematic'
import { resolveAll } from '../../../src/core/models/resolve'
import type { LibraryEntry, Resolution } from '../../../src/core/models/types'
import { extract, suggestGround, suggestSupplies } from '../../../src/core/netlist/extract'
import type { Circuit } from '../../../src/core/netlist/extract'
import { generateDeck } from '../../../src/core/spicegen/generate'
import type { Instrument } from '../../../src/core/spicegen/instruments'

const MODELS_DIR = join(process.cwd(), 'resources', 'models')

export interface ModelLibrary {
  library: LibraryEntry[]
  modelTexts: Record<string, string>
}

let cachedLibrary: ModelLibrary | null = null

/** The bundled model library and every model file's text, as the app loads them. */
export function loadModelLibrary(): ModelLibrary {
  if (cachedLibrary) return cachedLibrary
  const library = (JSON.parse(readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')) as { entries: LibraryEntry[] })
    .entries
  const modelTexts: Record<string, string> = {}
  for (const f of readdirSync(MODELS_DIR)) {
    if (f === 'index.json') continue
    if (f.endsWith('.lib') || f.endsWith('.json')) modelTexts[f] = readFileSync(join(MODELS_DIR, f), 'utf8')
  }
  cachedLibrary = { library, modelTexts }
  return cachedLibrary
}

export interface PipelineOptions {
  /** Deck title (first comment line). */
  title: string
  /** Optional schematic text for tier-1 Sim.* fields. */
  schematicText?: string
  /** Force the ground net by KiCad name instead of the heuristic. */
  groundName?: string
  /** Force the bench supply net by KiCad name instead of the heuristic. */
  supplyName?: string
  supplyVolts?: number
}

export interface PipelineStages {
  parseMs: number
  extractMs: number
  resolveMs: number
  deckMs: number
}

export interface PipelineResult {
  board: BoardModel
  circuit: Circuit
  resolutions: Resolution[]
  /** Undefined when the board has no ground-like net (deck stage skipped). */
  deck?: string[]
  groundNetId?: number
  supplyNetId?: number
  instruments: Instrument[]
  stages: PipelineStages
}

function now(): number {
  return performance.now()
}

/** Run the whole pure pipeline on a board's text. Throws exactly where the app would. */
export function runPipeline(boardText: string, opts: PipelineOptions): PipelineResult {
  const t0 = now()
  const board = parseBoard(boardText)
  const t1 = now()

  const probe = extract(board)
  const gnd = opts.groundName
    ? probe.nets.find((n) => n.kicadName === opts.groundName)
    : suggestGround(probe.nets)
  const supply = opts.supplyName
    ? probe.nets.find((n) => n.kicadName === opts.supplyName)
    : suggestSupplies(probe.nets).find((s) => s.id !== gnd?.id)
  const circuit = extract(board, gnd ? { groundNetId: gnd.id } : {})
  const t2 = now()

  const { library, modelTexts } = loadModelLibrary()
  const schData = opts.schematicText ? parseSchematicSimData(opts.schematicText) : undefined
  const resolutions = resolveAll(circuit, schData, undefined, library)
  const t3 = now()

  const instruments: Instrument[] = []
  let deck: string[] | undefined
  if (gnd) {
    instruments.push({ kind: 'ground-ref', netId: gnd.id })
    if (supply) {
      instruments.push({
        kind: 'dc-supply',
        id: 'auto-supply',
        netId: supply.id,
        volts: opts.supplyVolts ?? 5,
        seriesOhms: 0.1
      })
    }
    deck = generateDeck({
      circuit,
      resolutions,
      instruments,
      groundNetId: gnd.id,
      title: opts.title,
      modelTexts
    })
  }
  const t4 = now()

  return {
    board,
    circuit,
    resolutions,
    deck,
    groundNetId: gnd?.id,
    supplyNetId: supply?.id,
    instruments,
    stages: { parseMs: t1 - t0, extractMs: t2 - t1, resolveMs: t3 - t2, deckMs: t4 - t3 }
  }
}

/** Tokens that must never appear in a generated deck. */
const BAD_DECK_TOKEN = /(?:^|[\s=,(])(?:NaN|-?Infinity|undefined|null)(?=$|[\s=,)])/m

/** Returns the first offending deck line (with 1-based line number), or undefined. */
export function findBadDeckLine(deck: string[]): string | undefined {
  for (let i = 0; i < deck.length; i++) {
    const line = deck[i]
    if (line.startsWith('*')) continue // comments carry board text, not numbers
    if (BAD_DECK_TOKEN.test(line)) return `line ${i + 1}: ${line.slice(0, 200)}`
  }
  return undefined
}

/** Resolved-part statistics for the metrics report. */
export function resolutionStats(resolutions: Resolution[]): {
  byTier: Record<string, number>
  stubbed: number
  stubPct: number
} {
  const byTier: Record<string, number> = {}
  let stubbed = 0
  for (const r of resolutions) {
    byTier[`tier${r.tier}`] = (byTier[`tier${r.tier}`] ?? 0) + 1
    if (r.tier === 6) stubbed++
  }
  const total = resolutions.length
  return { byTier, stubbed, stubPct: total === 0 ? 0 : Math.round((1000 * stubbed) / total) / 10 }
}

/** Number of floating-island bleed resistors in a deck. */
export function islandCount(deck: string[]): number {
  return deck.filter((l) => l.startsWith('r_float_')).length
}

export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}
