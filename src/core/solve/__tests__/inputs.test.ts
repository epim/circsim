/**
 * buildSolveInputs + buildDeck: the single place deck inputs are assembled
 * (issue #53). Before the seam, the renderer store rebuilt GenerateOptions by
 * hand in powerOn, run and replayAfterCrash.
 *
 * The golden block below runs the shipped samples through the seam and compares
 * against the whole-deck goldens from #67, byte for byte. It only reads the
 * golden files; to accept an intentional deck change, regenerate them with the
 * procedure in src/core/spicegen/__tests__/wholeDeck.golden.test.ts.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseBoard } from '../../kicad/board'
import { parseSchematicSimData } from '../../kicad/schematic'
import { resolveAll } from '../../models/resolve'
import type { LibraryEntry } from '../../models/types'
import { extract, suggestGround } from '../../netlist/extract'
import { generateDeck } from '../../spicegen/generate'
import { UNWIRED, type Instrument } from '../../spicegen/instruments'
import { buildDeck, buildSolveInputs, mergeModelTexts, railOverridesByNetId } from '../inputs'
import { LOGIC4000, SWING_5V, VGATED_NET, switchedRailFixture } from './switchedRail.fixture'

const ROOT = process.cwd()
const SAMPLE_DIR = join(ROOT, 'resources', 'sample')
const MODELS_DIR = join(ROOT, 'resources', 'models')
const GOLDEN_DIR = join(ROOT, 'src', 'core', 'spicegen', '__tests__', 'golden')

describe('buildSolveInputs', () => {
  it('keeps only wired instruments', () => {
    const f = switchedRailFixture()
    const unwired: Instrument = { kind: 'dc-supply', id: 'shelf', netId: UNWIRED, volts: 9, seriesOhms: 0.1 }
    const inputs = buildSolveInputs(null, f.circuit, f.resolutions, [...f.instruments, unwired], f.groundNetId)
    expect(inputs.instruments).toEqual(f.instruments)
  })

  it('resolves kicadName rail overrides to net ids and drops unknown nets', () => {
    const f = switchedRailFixture()
    const byName = new Map([['/VGATED', 3.3], ['/NOWHERE', 9]])
    const inputs = buildSolveInputs(null, f.circuit, f.resolutions, f.instruments, f.groundNetId, {
      railOverrides: byName,
    })
    expect([...inputs.railOverrides]).toEqual([[VGATED_NET, 3.3]])
    expect(railOverridesByNetId(f.circuit, byName)).toEqual(inputs.railOverrides)
  })

  it('snapshots the cached measured rails', () => {
    const f = switchedRailFixture()
    const cache = new Map([[VGATED_NET, 5]])
    const inputs = buildSolveInputs(null, f.circuit, f.resolutions, f.instruments, f.groundNetId, {
      measuredRails: cache,
    })
    cache.set(VGATED_NET, 7)
    expect(inputs.measuredRails?.get(VGATED_NET)).toBe(5)
    expect(
      buildSolveInputs(null, f.circuit, f.resolutions, f.instruments, f.groundNetId, { measuredRails: null })
        .measuredRails,
    ).toBeUndefined()
  })

  it('carries the board for the copper-aware deck', () => {
    const f = switchedRailFixture()
    const board = parseBoard(readFileSync(join(SAMPLE_DIR, 'first-light.kicad_pcb'), 'utf8'))
    expect(buildSolveInputs(board, f.circuit, f.resolutions, f.instruments, f.groundNetId).board).toBe(board)
  })
})

describe('mergeModelTexts', () => {
  it('adds user models under the virtual path after the bundled texts; user wins on collision', () => {
    const merged = mergeModelTexts(
      { 'a.lib': 'A', '__user_model__:X1': 'bundled' },
      [{ mpn: 'X1', subcktText: 'user X1' }, { mpn: 'Y2', subcktText: 'user Y2' }],
    )
    expect(Object.keys(merged)).toEqual(['a.lib', '__user_model__:X1', '__user_model__:Y2'])
    expect(merged['__user_model__:X1']).toBe('user X1')
  })

  it('returns an empty map when nothing is supplied', () => {
    expect(mergeModelTexts(undefined, undefined)).toEqual({})
  })
})

describe('buildDeck', () => {
  it('seeds cached measured rails (tier 3) into the deck', () => {
    const f = switchedRailFixture()
    const inputs = buildSolveInputs(null, f.circuit, f.resolutions, f.instruments, f.groundNetId, {
      modelTexts: { 'logic4000.json': LOGIC4000 },
      measuredRails: new Map([[VGATED_NET, 5]]),
    })
    expect(buildDeck(inputs).join('\n')).toContain(SWING_5V)
  })

  it('is exactly generateDeck over the same inputs', () => {
    const f = switchedRailFixture()
    const modelTexts = { 'logic4000.json': LOGIC4000 }
    const inputs = buildSolveInputs(null, f.circuit, f.resolutions, f.instruments, f.groundNetId, {
      title: 't',
      modelTexts,
      railOverrides: new Map([['/VGATED', 3.3]]),
    })
    expect(buildDeck(inputs)).toEqual(
      generateDeck({
        circuit: f.circuit,
        resolutions: f.resolutions,
        instruments: f.instruments,
        groundNetId: f.groundNetId,
        title: 't',
        modelTexts,
        railOverrides: new Map([[VGATED_NET, 3.3]]),
      }),
    )
  })
})

// --- whole-deck goldens through the seam -------------------------------------

interface Sample {
  name: string
  board: string
  schematic?: string
  supplyNet: string
  volts: number
}

// Same samples and bench as wholeDeck.golden.test.ts.
const SAMPLES: Sample[] = [
  { name: 'blinker-555', board: 'blinker-555.kicad_pcb', schematic: 'blinker-555.kicad_sch', supplyNet: 'VCC', volts: 5 },
  { name: 'first-light', board: 'first-light.kicad_pcb', supplyNet: 'VIN', volts: 5 },
]

function bundledModelTexts(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(MODELS_DIR)) {
    if ((f.endsWith('.lib') || f.endsWith('.json')) && f !== 'characterization.json') {
      out[f] = readFileSync(join(MODELS_DIR, f), 'utf8')
    }
  }
  return out
}

describe('whole-deck goldens reproduced through the solve seam', () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}: buildDeck(buildSolveInputs(...)) matches the golden byte for byte`, () => {
      const board = parseBoard(readFileSync(join(SAMPLE_DIR, sample.board), 'utf8'))
      const schData = sample.schematic
        ? parseSchematicSimData(readFileSync(join(SAMPLE_DIR, sample.schematic), 'utf8'))
        : undefined
      const gnd = suggestGround(extract(board).nets)
      if (!gnd) throw new Error(`${sample.name}: no ground suggested`)
      const circuit = extract(board, { groundNetId: gnd.id })
      const library = (
        JSON.parse(readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }
      ).entries
      const resolutions = resolveAll(circuit, schData, undefined, library)
      const supply = circuit.nets.find(n => n.kicadName === sample.supplyNet)
      if (!supply) throw new Error(`${sample.name}: net ${sample.supplyNet} not found`)
      const instruments: Instrument[] = [
        { kind: 'ground-ref', netId: gnd.id },
        { kind: 'dc-supply', id: 'bench', netId: supply.id, volts: sample.volts, seriesOhms: 0.1 },
      ]

      // What the bench hands the seam: no overrides, no user models, no cached rails.
      const inputs = buildSolveInputs(board, circuit, resolutions, instruments, gnd.id, {
        title: sample.name,
        modelTexts: bundledModelTexts(),
        railOverrides: new Map(),
        userModels: [],
        measuredRails: null,
      })
      const text = buildDeck(inputs).join('\n') + '\n'

      const golden = readFileSync(join(GOLDEN_DIR, `deck-${sample.name}.txt`), 'utf8').replace(/\r\n/g, '\n')
      expect(text).toBe(golden)
    })
  }
})
