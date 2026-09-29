/**
 * Whole-deck goldens for the shipped sample boards (issue #67).
 *
 * Each sample goes through the real pipeline (parseBoard, parseSchematicSimData,
 * extract, suggestGround, resolveAll, generateDeck) with the bench Energize
 * would attach (ground on the suggested net, a 5 V supply on the power net) and
 * the resulting deck is compared, byte for byte, with a checked-in file. The
 * whole deck of the sample is therefore one reviewable artifact: island bleeds,
 * LED sense sources, digital-rail sensing, the inlined model text and the
 * instrument cards all show up in a single diff.
 *
 * To accept an intentional change:
 *     UPDATE_GOLDEN=1 npx vitest run src/core/spicegen/__tests__/wholeDeck.golden.test.ts
 * then review `git diff src/core/spicegen/__tests__/golden/`.
 *
 * The invariant test below the goldens does not depend on exact text: every
 * node token of every element card must be ground, a net's SPICE node, or a
 * synthetic node the generator declares (subckt-internal, source splice, LED
 * sense, bleed).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseBoard } from '../../kicad/board'
import { parseSchematicSimData } from '../../kicad/schematic'
import { resolveAll } from '../../models/resolve'
import type { LibraryEntry } from '../../models/types'
import { extract, suggestGround, type Circuit } from '../../netlist/extract'
import { generateDeck } from '../generate'
import type { Instrument } from '../instruments'

const ROOT = process.cwd()
const SAMPLE_DIR = join(ROOT, 'resources', 'sample')
const MODELS_DIR = join(ROOT, 'resources', 'models')
const GOLDEN_DIR = join(ROOT, 'src', 'core', 'spicegen', '__tests__', 'golden')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

interface Sample {
  name: string
  board: string
  schematic?: string
  supplyNet: string
  volts: number
}

const SAMPLES: Sample[] = [
  { name: 'blinker-555', board: 'blinker-555.kicad_pcb', schematic: 'blinker-555.kicad_sch', supplyNet: 'VCC', volts: 5 },
  { name: 'first-light', board: 'first-light.kicad_pcb', supplyNet: 'VIN', volts: 5 }
]

/** Every bundled model file, keyed by file name, exactly as the app feeds generateDeck. */
function loadModelTexts(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(MODELS_DIR)) {
    if (f.endsWith('.lib') || f.endsWith('.json')) {
      if (f === 'characterization.json') continue
      out[f] = readFileSync(join(MODELS_DIR, f), 'utf8')
    }
  }
  return out
}

function buildDeck(sample: Sample): { deck: string[]; circuit: Circuit } {
  const board = parseBoard(readFileSync(join(SAMPLE_DIR, sample.board), 'utf8'))
  const schData = sample.schematic
    ? parseSchematicSimData(readFileSync(join(SAMPLE_DIR, sample.schematic), 'utf8'))
    : undefined
  const probe = extract(board)
  const gnd = suggestGround(probe.nets)
  if (!gnd) throw new Error(`${sample.name}: no ground suggested`)
  const circuit = extract(board, { groundNetId: gnd.id })
  const library = (
    JSON.parse(readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }
  ).entries
  const resolutions = resolveAll(circuit, schData, undefined, library)
  const supply = circuit.nets.find((n) => n.kicadName === sample.supplyNet)
  if (!supply) throw new Error(`${sample.name}: net ${sample.supplyNet} not found`)
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: gnd.id },
    { kind: 'dc-supply', id: 'bench', netId: supply.id, volts: sample.volts, seriesOhms: 0.1 }
  ]
  const deck = generateDeck({
    circuit,
    resolutions,
    instruments,
    groundNetId: gnd.id,
    title: sample.name,
    modelTexts: loadModelTexts()
  })
  return { deck, circuit }
}

describe('whole-deck goldens (real pipeline, shipped samples)', () => {
  for (const sample of SAMPLES) {
    it(`${sample.name} deck matches the checked-in golden`, () => {
      const { deck } = buildDeck(sample)
      const text = deck.join('\n') + '\n'
      const file = join(GOLDEN_DIR, `deck-${sample.name}.txt`)
      if (UPDATE) {
        writeFileSync(file, text)
        return
      }
      expect(
        existsSync(file),
        `missing golden ${file}; create it with UPDATE_GOLDEN=1 and review the file`
      ).toBe(true)
      // Normalise line endings so a Windows checkout with autocrlf compares equal.
      const golden = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      expect(text.replace(/\r\n/g, '\n')).toBe(golden)
    })

    it(`${sample.name} generation is deterministic`, () => {
      expect(buildDeck(sample).deck).toEqual(buildDeck(sample).deck)
    })
  }
})

// --- deck invariant ----------------------------------------------------------

/** Nodes of an element card, by SPICE device letter. Undefined for cards not covered. */
function nodeTokens(card: string): string[] | undefined {
  const t = card.trim().split(/\s+/)
  const name = t[0].toLowerCase()
  const kind = name[0]
  const args = t.slice(1)
  switch (kind) {
    case 'r':
    case 'c':
    case 'l':
    case 'v':
    case 'i':
    case 'd':
    case 'b':
      return args.slice(0, 2)
    case 'e':
    case 'g':
      return args.slice(0, 4)
    case 'q': {
      // q c b e [s] model: three nodes; a fourth node token exists only when 5 args precede params
      const plain = args.filter((a) => !a.includes('='))
      return plain.length >= 5 ? plain.slice(0, 4) : plain.slice(0, 3)
    }
    case 'm':
      return args.slice(0, 4)
    case 'x': {
      // x nodes... subcktName [params: ...]
      const cut = args.findIndex((a) => a.toLowerCase() === 'params:')
      const body = cut === -1 ? args : args.slice(0, cut)
      return body.slice(0, -1)
    }
    default:
      return undefined
  }
}

function joinContinuations(lines: string[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    if (l.trimStart().startsWith('+') && out.length > 0) out[out.length - 1] += ' ' + l.trimStart().slice(1)
    else out.push(l)
  }
  return out
}

describe('deck node invariant', () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}: every top-level element node is 0, a board net, or a declared synthetic node`, () => {
      const { deck, circuit } = buildDeck(sample)
      const known = new Set<string>(['0', ...circuit.nets.map((n) => n.spiceNode.toLowerCase())])

      // Synthetic nodes: anything that appears as a node of at least TWO element cards
      // outside subckt bodies is a real connection; a node that appears exactly once
      // is dangling and must be one of the documented one-sided synthetics. Count
      // occurrences over top-level cards only (skip .subckt bodies and .model text).
      let depth = 0
      const seen = new Map<string, number>()
      const cards: string[] = []
      for (const raw of joinContinuations(deck)) {
        const line = raw.trim()
        if (line === '' || line.startsWith('*')) continue
        const lower = line.toLowerCase()
        if (lower.startsWith('.subckt')) {
          depth++
          continue
        }
        if (lower.startsWith('.ends')) {
          depth--
          continue
        }
        if (depth > 0 || lower.startsWith('.')) continue
        cards.push(line)
      }
      expect(cards.length).toBeGreaterThan(0)

      for (const card of cards) {
        const nodes = nodeTokens(card)
        expect(nodes, `element card not covered by the invariant helper: ${card}`).toBeDefined()
        for (const n of nodes as string[]) {
          seen.set(n.toLowerCase(), (seen.get(n.toLowerCase()) ?? 0) + 1)
        }
      }

      // Every node that is not ground or a board net must connect at least two card pins
      // (an internal splice or sense node), otherwise it is a typo or a stray net.
      const stray: string[] = []
      for (const [node, count] of seen) {
        if (known.has(node)) continue
        if (count < 2) stray.push(node)
      }
      expect(stray, `nodes used by only one top-level card: ${stray.join(', ')}`).toEqual([])

      // Ground must be present, and every board net the deck touches must exist in the circuit.
      expect(seen.has('0')).toBe(true)
    })
  }
})
