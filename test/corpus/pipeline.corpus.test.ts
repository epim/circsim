/**
 * test/corpus/pipeline.corpus.test.ts
 *
 * The real-board regression corpus (issue #22). Every board in
 * scripts/corpus-manifest.json is a KiCad-written file fetched at test time with
 * a pinned sha256. Per board:
 *
 *   1. the file header carries the format version the manifest says it does
 *      (so the KiCad 6..10 coverage claim is checked, not asserted, #63);
 *   2. parseBoard -> extract -> resolveAll -> generateDeck completes without
 *      throwing;
 *   3. the generated deck contains no NaN / Infinity / undefined numeric fields;
 *   4. circsim's pad-to-net assignment equals KiCad's own, taken from
 *      `kicad-cli pcb export ipc2581` (live when kicad-cli is installed, else
 *      against the committed digest in test/corpus/oracle.json);
 *   5. per-board metrics are written to test-results/corpus/ and compared with
 *      test/corpus/baseline.json (drift is printed, see scripts/corpus-metrics.mjs).
 *
 * A board that circsim is known to reject carries `knownFailing` in the manifest:
 * the suite then REQUIRES the failure (stage and message), so a fix shows up as a
 * test failure telling you to delete the marker.
 *
 * Environment:
 *   CIRCSIM_KICAD_CLI                  path to kicad-cli (else PATH, else default installs)
 *   CIRCSIM_CORPUS_UPDATE_ORACLE=1     rewrite test/corpus/oracle.json from live kicad-cli
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  METRICS_DIR,
  ORACLE_FILE,
  boardFormatVersion,
  corpusBoards,
  readCorpusBoard,
  type CorpusEntry
} from './helpers/corpus'
import { NO_DIFF, circsimPadNets, diffConnectivity, oraclePadNets } from './helpers/connectivity'
import {
  oraclePadsCached,
  findKicadCli,
  partitionDigest,
} from './helpers/kicadOracle'
import { corpusFile } from '../../scripts/fetch-corpus.mjs'
import {
  findBadDeckLine,
  islandCount,
  resolutionStats,
  runPipeline,
  type PipelineResult
} from './helpers/pipeline'

const kicad = findKicadCli()
const updateOracle = process.env.CIRCSIM_CORPUS_UPDATE_ORACLE === '1'

interface OracleRecord {
  pads: number
  digest: string
  kicadCli: string
}
const committedOracle: Record<string, OracleRecord> = existsSync(ORACLE_FILE)
  ? JSON.parse(readFileSync(ORACLE_FILE, 'utf8'))
  : {}
const oracleUpdates: Record<string, OracleRecord> = {}

if (!kicad) {
  console.warn(
    '[corpus] kicad-cli not found: pad-to-net checks use the committed digests in test/corpus/oracle.json ' +
      '(set CIRCSIM_KICAD_CLI to run them live).'
  )
}

describe.each(corpusBoards())('corpus: $id', (entry: CorpusEntry) => {
  let text = ''
  let result: PipelineResult | undefined
  let failure: { stage: string; message: string } | undefined

  beforeAll(() => {
    text = readCorpusBoard(entry)
    try {
      result = runPipeline(text, { title: `${entry.id}.kicad_pcb` })
    } catch (err) {
      failure = { stage: 'parse-or-later', message: (err as Error).message }
    }
  })

  it(`header carries KiCad format version ${entry.formatVersion}`, () => {
    expect(boardFormatVersion(text)).toBe(entry.formatVersion)
  })

  if (entry.knownFailing) {
    const known = entry.knownFailing
    it(`fails as documented in ${known.issue} (remove knownFailing from the manifest once fixed)`, () => {
      expect(failure, `expected a ${known.stage} failure (${known.reason}) but the pipeline now succeeds`).toBeDefined()
      expect(failure!.message).toContain(known.match)
    })
    return
  }

  it('parses, extracts, resolves and generates a deck', () => {
    expect(failure?.message, 'pipeline threw').toBeUndefined()
    expect(result).toBeDefined()
    expect(result!.board.footprints.length).toBeGreaterThan(0)
    expect(result!.resolutions.length).toBe(result!.circuit.parts.length)
    // A board with a ground-like net must produce a deck. Boards without one
    // (an antenna, an all-unnamed-net demo) skip only the deck stage.
    if (result!.groundNetId !== undefined) {
      expect(result!.deck, 'deck').toBeDefined()
      expect(result!.deck!.length).toBeGreaterThan(2)
    }
  })

  it('emits no NaN, Infinity or undefined in the deck', () => {
    if (!result?.deck) return
    expect(findBadDeckLine(result.deck)).toBeUndefined()
  })

  it('pad-to-net connectivity equals KiCad (kicad-cli ipc2581 oracle)', () => {
    expect(result).toBeDefined()
    const board = result!.board
    const mine = circsimPadNets(board)
    const recorded = committedOracle[entry.id]

    if (kicad) {
      const oracle = oraclePadNets(board, oraclePadsCached(kicad, corpusFile(entry), entry.sha256))
      expect(diffConnectivity(mine, oracle), `pad-to-net mismatch vs ${kicad.version}`).toEqual(NO_DIFF)

      const digest = partitionDigest(oracle)
      if (updateOracle) oracleUpdates[entry.id] = { pads: oracle.size, digest, kicadCli: kicad.version }
      else if (recorded) {
        expect(digest, 'committed oracle digest is stale; rerun with CIRCSIM_CORPUS_UPDATE_ORACLE=1').toBe(recorded.digest)
      }
    } else {
      expect(recorded, `no committed oracle digest for ${entry.id}; run with kicad-cli and CIRCSIM_CORPUS_UPDATE_ORACLE=1`).toBeDefined()
      expect(partitionDigest(mine), 'circsim pad-to-net partition differs from the KiCad oracle digest').toBe(recorded.digest)
      expect(mine.size).toBe(recorded.pads)
    }
  })

  afterAll(() => {
    if (!result) return
    mkdirSync(join(METRICS_DIR, 'metrics'), { recursive: true })
    const { board, circuit, resolutions, deck, stages } = result
    const stats = resolutionStats(resolutions)
    const metrics = {
      id: entry.id,
      kicadMajor: entry.kicadMajor,
      formatVersion: entry.formatVersion,
      footprints: board.footprints.length,
      footprintsBackSide: board.footprints.filter((f) => f.layer === 'B').length,
      footprintsRotated: board.footprints.filter((f) => f.at.rotDeg % 360 !== 0).length,
      nets: circuit.nets.length,
      tracks: board.tracks.length,
      vias: board.vias.length,
      zones: board.zones.length,
      tiers: stats.byTier,
      stubbedPct: stats.stubPct,
      islands: deck ? islandCount(deck) : null,
      deckLines: deck ? deck.length : null,
      outlineWarnings: board.outline.warnings.length,
      ms: {
        parse: Math.round(stages.parseMs),
        extract: Math.round(stages.extractMs),
        resolve: Math.round(stages.resolveMs),
        deck: Math.round(stages.deckMs)
      }
    }
    writeFileSync(join(METRICS_DIR, 'metrics', `${entry.id}.json`), JSON.stringify(metrics, null, 2) + '\n')
  })
})

afterAll(() => {
  if (updateOracle && Object.keys(oracleUpdates).length > 0) {
    const merged = { ...committedOracle, ...oracleUpdates }
    const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(ORACLE_FILE, JSON.stringify(sorted, null, 2) + '\n')
    console.log(`[corpus] wrote ${Object.keys(oracleUpdates).length} oracle digests to test/corpus/oracle.json`)
  }
})
