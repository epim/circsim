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
 *      throwing, inside a time budget;
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
import {
  ambiguousRefPredicate,
  exportIpc2581,
  findKicadCli,
  partitionDigest,
  parseIpc2581Pads
} from './helpers/kicadOracle'
import { corpusFile } from '../../scripts/fetch-corpus.mjs'
import {
  findBadDeckLine,
  islandCount,
  resolutionStats,
  runPipeline,
  type PipelineResult
} from './helpers/pipeline'

/** Wall-clock ceiling for the four pure stages on any corpus board. */
const PIPELINE_BUDGET_MS = 30_000

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

/** circsim's pad -> net-name map for one board, keyed "ref\tpin". */
function circsimPadNets(result: PipelineResult): Map<string, string> {
  const map = new Map<string, string>()
  const { board } = result
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (pad.netId === undefined) continue
      const net = board.netById.get(pad.netId)
      if (!net) continue
      map.set(`${fp.ref}\t${pad.number}`, net.name)
    }
  }
  return map
}

describe.each(corpusBoards())('corpus: $id', (entry: CorpusEntry) => {
  let text = ''
  let result: PipelineResult | undefined
  let failure: { stage: string; message: string } | undefined

  beforeAll(() => {
    text = readCorpusBoard(entry)
    const t0 = performance.now()
    try {
      result = runPipeline(text, { title: `${entry.id}.kicad_pcb` })
    } catch (err) {
      failure = { stage: 'parse-or-later', message: (err as Error).message }
    }
    if (result) {
      expect(performance.now() - t0, 'pipeline wall time').toBeLessThan(PIPELINE_BUDGET_MS)
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
    const mine = circsimPadNets(result!)
    const isAmbiguous = ambiguousRefPredicate(result!.board.footprints.map((f) => f.ref))
    const filteredMine = new Map([...mine].filter(([k]) => !isAmbiguous(k.split('\t')[0])))

    const recorded = committedOracle[entry.id]

    if (kicad) {
      const oraclePads = parseIpc2581Pads(exportIpc2581(kicad.path, corpusFile(entry)))
      const oracleNets = new Map<string, string>()
      for (const [k, p] of oraclePads) {
        if (!isAmbiguous(k.split('\t')[0])) oracleNets.set(k, p.net)
      }
      const missingInMine: string[] = []
      const extraInMine: string[] = []
      // Net NAMES may differ legitimately (IPC-2581 writes GND_2 when an inner
      // layer is named GND), so the check is a bijection between circsim nets
      // and KiCad nets over the shared pads: same net for two pads in one tool
      // means same net in the other.
      const mineToOracle = new Map<string, string>()
      const oracleToMine = new Map<string, string>()
      const split: string[] = []
      for (const [k, net] of oracleNets) {
        const m = filteredMine.get(k)
        if (m === undefined) {
          missingInMine.push(`${k.replace('	', ' pad ')} (KiCad: ${net})`)
          continue
        }
        const prevOracle = mineToOracle.get(m)
        const prevMine = oracleToMine.get(net)
        if ((prevOracle !== undefined && prevOracle !== net) || (prevMine !== undefined && prevMine !== m)) {
          split.push(`${k.replace('	', ' pad ')}: circsim ${m}, KiCad ${net}`)
        }
        if (prevOracle === undefined) mineToOracle.set(m, net)
        if (prevMine === undefined) oracleToMine.set(net, m)
      }
      for (const [k, net] of filteredMine) {
        if (!oracleNets.has(k)) extraInMine.push(`${k.replace('	', ' pad ')} (circsim: ${net})`)
      }
      expect(
        { missingInMine: missingInMine.slice(0, 10), extraInMine: extraInMine.slice(0, 10), split: split.slice(0, 10) },
        `pad-to-net mismatch vs ${kicad.version}`
      ).toEqual({ missingInMine: [], extraInMine: [], split: [] })

      const digest = partitionDigest(oracleNets)
      const record = { pads: oracleNets.size, digest, kicadCli: kicad.version }
      if (updateOracle) oracleUpdates[entry.id] = record
      else if (recorded) {
        expect(digest, 'committed oracle digest is stale; rerun with CIRCSIM_CORPUS_UPDATE_ORACLE=1').toBe(recorded.digest)
      }
    } else {
      expect(recorded, `no committed oracle digest for ${entry.id}; run with kicad-cli and CIRCSIM_CORPUS_UPDATE_ORACLE=1`).toBeDefined()
      expect(partitionDigest(filteredMine), 'circsim pad-to-net partition differs from the KiCad oracle digest').toBe(recorded.digest)
      expect(filteredMine.size).toBe(recorded.pads)
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
