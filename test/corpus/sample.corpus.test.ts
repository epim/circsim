/**
 * test/corpus/sample.corpus.test.ts
 *
 * The third bundled sample board, resources/sample/sensor-node.kicad_pcb (issues
 * #22 and #48): a 94-part, routed, two-sided board written in KiCad 10 syntax by
 * scripts/gen-sample-board.mjs. It is the in-repo "board that looks like the
 * user's" the corpus lacked: an ESP32 module, a regulator, shift registers and 16
 * LEDs, op-amp and comparator sensors, switched loads, rotated parts (0 and 180
 * degrees), back-side parts, a B.Cu ground pour.
 *
 * It is only trustworthy as a fixture because KiCad itself vouches for it:
 *
 *   - the committed file is byte-identical to a regeneration (no hand edits);
 *   - kicad-cli loads it, plots every pad at the centre circsim computes and on
 *     the net circsim assigns (the pad-centre oracle, same as PR #84), and its
 *     own connectivity engine reports zero unconnected items and zero copper
 *     violations once the pour is refilled;
 *   - without kicad-cli (CI), the committed copy of what kicad-cli plotted
 *     (test/corpus/oracle/sensor-node.flashes.json) stands in, and the routed
 *     copper itself is checked against pad centres (checkPadsAgainstCopper).
 *
 * The same pipeline as the corpus boards runs on it: parseBoard, extract,
 * resolveAll, generateDeck, a real-ngspice operating point, and the Board Critic.
 * The whole-deck golden is in src/core/spicegen/__tests__/wholeDeck.golden.test.ts.
 *
 * CIRCSIM_CORPUS_UPDATE_ORACLE=1 rewrites the committed flashes from live kicad-cli.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { generateSampleBoard, SAMPLE_FILE } from '../../scripts/gen-sample-board.mjs'
import { padWorldPos } from '../../src/core/critic/geom'
import {
  checkPadsAgainstCopper,
  checkPadsAgainstFlashes,
  plotPadCentersWithKicadCli,
  type PadFlash
} from '../../src/core/critic/__tests__/padOracle'
import { runCritic } from '../../src/core/critic/run'
import { SimHost } from '../../src/simhost/index'
import { ngspiceResourcesAvailable } from '../../src/simhost/ngspiceFfi'
import { NO_DIFF, circsimPadNets, diffConnectivity, oraclePadNets } from './helpers/connectivity'
import { exportIpc2581, findKicadCli, parseIpc2581Pads } from './helpers/kicadOracle'
import { findBadDeckLine, resolutionStats, runPipeline } from './helpers/pipeline'

const BOARD_PATH = join(process.cwd(), SAMPLE_FILE)
const FLASHES_PATH = join(process.cwd(), 'test', 'corpus', 'oracle', 'sensor-node.flashes.json')
const boardText = readFileSync(BOARD_PATH, 'utf8')

const kicad = findKicadCli()
const updateOracle = process.env.CIRCSIM_CORPUS_UPDATE_ORACLE === '1'
if (!kicad) {
  console.warn('[corpus] kicad-cli not found: the sensor-node KiCad checks use the committed flashes only (set CIRCSIM_KICAD_CLI)')
}

const run = runPipeline(boardText, { title: 'sensor-node', groundName: 'GND', supplyName: '+5V', supplyVolts: 5 })
const board = run.board

function committedFlashes(): PadFlash[] {
  return (JSON.parse(readFileSync(FLASHES_PATH, 'utf8')) as { flashes: PadFlash[] }).flashes
}

describe('sensor-node sample board: the file', () => {
  it('is the generator output (no hand edits)', () => {
    // git may check the file out with CRLF on Windows; the content is what matters.
    expect(boardText.replace(/\r\n/g, '\n'), 'run: node scripts/gen-sample-board.mjs --write').toBe(generateSampleBoard())
  })

  it('is a realistic size and layout: 60 to 150 parts, both sides, right-angle rotations, pour, vias', () => {
    expect(board.footprints.length).toBeGreaterThanOrEqual(60)
    expect(board.footprints.length).toBeLessThanOrEqual(150)
    expect(board.footprints.some((f) => f.layer === 'B')).toBe(true)
    const rots = new Set(board.footprints.map((f) => (((f.at.rotDeg % 360) + 360) % 360)))
    expect(rots.has(90) && rots.has(180)).toBe(true)
    expect(board.zones.length).toBeGreaterThanOrEqual(1)
    expect(board.vias.length).toBeGreaterThan(50)
    expect(board.tracks.some((t) => t.layer === 'B.Cu')).toBe(true)
    expect(board.tracks.length).toBeGreaterThan(200)
  })
})

describe('sensor-node sample board: pipeline', () => {
  it('parses, extracts, resolves and generates a clean deck', () => {
    expect(run.deck, 'a deck is generated').toBeDefined()
    expect(findBadDeckLine(run.deck!)).toBeUndefined()
    const stats = resolutionStats(run.resolutions)
    // The ESP32 module is a supply-load stub; test points, buttons and the NTC have no model.
    // Everything else (regulator, diodes, LEDs, transistors, op-amp, comparator, shift
    // registers, passives, headers) resolves.
    expect(stats.stubbed).toBeLessThanOrEqual(12)
    expect(run.resolutions.find((r) => r.ref === 'U2')?.status).toBe('stubbed')
    for (const ref of ['U1', 'U3', 'U4', 'U5', 'U6', 'Q1', 'Q2', 'D1', 'D2', 'D3', 'D4']) {
      expect(run.resolutions.find((r) => r.ref === ref)?.tier, `${ref} resolved to a model`).not.toBe(6)
    }
  })

  it('runs the Board Critic without throwing and reports on the board', () => {
    const report = runCritic(board, run.circuit)
    expect(report.ranBy).toEqual(expect.arrayContaining(['floating', 'clearance', 'decoupling', 'loop-area']))
    expect(report.summary.error + report.summary.warn + report.summary.info).toBe(report.findings.length)
    for (const f of report.findings) {
      expect(f.title.length).toBeGreaterThan(0)
      if (f.location) {
        expect(Number.isFinite(f.location.x) && Number.isFinite(f.location.y)).toBe(true)
      }
    }
  })
})

describe('sensor-node sample board: pad-centre oracle', () => {
  it('every routed pad has same-net copper under its computed centre', () => {
    const { checked, mismatches } = checkPadsAgainstCopper(board, padWorldPos)
    expect(checked).toBeGreaterThan(200)
    expect(mismatches).toEqual([])
  })

  it('padWorldPos and the net of every pad match the pad centres kicad-cli plotted (committed)', () => {
    const flashes = committedFlashes()
    const { checked, mismatches } = checkPadsAgainstFlashes(board, padWorldPos, flashes)
    expect(checked).toBeGreaterThan(200)
    expect(mismatches).toEqual([])
    const nets = circsimPadNets(board)
    const wrongNet: string[] = []
    for (const f of flashes) {
      const mine = nets.get(`${f.ref}\t${f.pad}`)
      // KiCad plots a pad with no net as N/C, and leaves the net attribute off a pad whose
      // flash has none of its own (an empty string here): those are not compared.
      if (f.net === '') continue
      const want = f.net === 'N/C' ? undefined : f.net
      if (mine !== want) wrongNet.push(`${f.ref}.${f.pad}: circsim ${mine}, KiCad ${f.net}`)
    }
    expect(wrongNet).toEqual([])
  })

  it.skipIf(!kicad)('kicad-cli, run live, still plots the committed pad centres (rewrite with CIRCSIM_CORPUS_UPDATE_ORACLE=1)', () => {
    const live = plotPadCentersWithKicadCli(kicad!.path, BOARD_PATH)
    const sorted = [...live].sort((a, b) => (a.ref + '\t' + a.pad).localeCompare(b.ref + '\t' + b.pad, undefined, { numeric: true }))
    if (updateOracle || !existsSync(FLASHES_PATH)) {
      writeFileSync(FLASHES_PATH, JSON.stringify({ source: kicad!.version, unit: 'mm', flashes: sorted }, null, 1) + '\n')
    }
    const { checked, mismatches } = checkPadsAgainstFlashes(board, padWorldPos, live)
    expect(checked).toBeGreaterThan(200)
    expect(mismatches).toEqual([])
    expect(committedFlashes()).toEqual(sorted)
  }, 120_000)
})

describe.skipIf(!kicad)('sensor-node sample board: KiCad agrees', () => {
  it("kicad-cli's connectivity (IPC-2581) equals circsim's, pad for pad", () => {
    const oracle = oraclePadNets(board, parseIpc2581Pads(exportIpc2581(kicad!.path, BOARD_PATH)))
    expect(oracle.size).toBeGreaterThan(200)
    expect(diffConnectivity(circsimPadNets(board), oracle)).toEqual(NO_DIFF)
  }, 120_000)

  it('is fully routed in KiCad (zero unconnected) and clean once the pour is refilled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'circsim-sample-drc-'))
    try {
      const copy = join(dir, 'board.kicad_pcb')
      const out = join(dir, 'drc.json')
      copyFileSync(BOARD_PATH, copy)
      try {
        // --refill-zones: the committed pour is the uncut outline, so its stored fill overlaps other nets.
        execFileSync(kicad!.path, ['pcb', 'drc', '--refill-zones', '--format', 'json', '--severity-all', '-o', out, copy], {
          stdio: 'pipe',
          timeout: 180_000
        })
      } catch {
        // a non-zero exit still leaves the report
      }
      const report = JSON.parse(readFileSync(out, 'utf8')) as {
        violations: { type: string }[]
        unconnected_items: unknown[]
      }
      expect(report.unconnected_items.length, 'unconnected items').toBe(0)
      // Library, silkscreen and mask findings come from generated footprints and are not copper.
      const copper = new Set([
        'clearance', 'hole_clearance', 'shorting_items', 'copper_edge_clearance', 'track_width', 'via_diameter',
        'annular_width', 'drill_out_of_range', 'hole_to_hole', 'track_dangling', 'via_dangling', 'isolated_copper'
      ])
      const bad = report.violations.filter((v) => copper.has(v.type)).map((v) => v.type)
      expect(bad, 'copper violations').toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})

const haveNgspice = ngspiceResourcesAvailable()
if (!haveNgspice) {
  console.warn('[corpus] resources/ngspice/<platform> missing: the sensor-node operating point is SKIPPED (run npm run fetch:ngspice)')
}

describe.skipIf(!haveNgspice)('sensor-node sample board: operating point (real ngspice)', () => {
  it('solves with finite values, the +5 V bench rail up and the regulator output near 3.3 V', async () => {
    const host = new SimHost({ emit: () => {}, disableWatchdog: true })
    try {
      await host.start()
      host.handleCommand({ type: 'loadCircuit', deckLines: run.deck! })
      await host.whenIdle()
      const values = await host.runOp()
      const entries = Object.entries(values)
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.filter(([, v]) => !Number.isFinite(v)).map(([k]) => k)).toEqual([])
      const node = (name: string): number => {
        const n = run.circuit.nets.find((x) => x.kicadName === name)
        expect(n, `net ${name}`).toBeDefined()
        return values[n!.spiceNode]
      }
      const v5 = node('+5V')
      expect(v5).toBeGreaterThan(4.5)
      expect(v5).toBeLessThanOrEqual(5 + 1e-6)
      const v33 = node('+3V3')
      expect(v33).toBeGreaterThan(3.0)
      expect(v33).toBeLessThan(3.4)
    } finally {
      await host.dispose()
    }
  }, 90_000)
})
