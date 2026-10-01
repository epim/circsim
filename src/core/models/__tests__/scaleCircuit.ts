/**
 * Synthetic scale circuit for the resolve and deck growth tests (issue #76).
 * Not a test file: vitest only collects *.test.ts.
 *
 * Built from scripts/gen-synthetic-board.mjs through the real parseBoard and
 * extract, so the circuit has the shape the app feeds resolveAll: nets grow with
 * parts (about one net per part), a mix of passives that resolve at tier 2,
 * library parts that resolve at tier 3 (by MPN, by value regex and by footprint
 * fallback), controllers and addressable LEDs that the stub rules turn into
 * supply-load stubs (their pads sit on the named +3V3 and GND nets), and parts
 * nothing resolves.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateBoard, type SyntheticFootprint, type SyntheticPad } from '../../../../scripts/gen-synthetic-board.mjs'
import { parseBoard } from '../../kicad/board'
import { extract, suggestGround, type Circuit } from '../../netlist/extract'
import type { LibraryEntry } from '../types'

/** The bundled index, exactly as the app ships it. */
export function bundledLibrary(): LibraryEntry[] {
  const text = readFileSync(join(process.cwd(), 'resources', 'models', 'index.json'), 'utf8')
  return (JSON.parse(text) as { entries: LibraryEntry[] }).entries
}

/**
 * `base` followed by filler entries, `factor` times as many entries in all.
 * Each filler entry carries every match field (MPNs, a value regex, refdes
 * prefixes and a footprint regex) so a matcher that scans the library per part
 * does real work on it, yet none of them matches a part of scaleCircuit: the
 * grown library resolves a scale circuit exactly as `base` does. The growth
 * tests grow the library with the board, so a parts x library loop shows up
 * as SCALE squared where a linear one stays near SCALE.
 */
export function grownLibrary(base: readonly LibraryEntry[], factor: number): LibraryEntry[] {
  const prefixes = [['D'], ['Q', 'M'], ['U', 'IC']]
  const filler: LibraryEntry[] = []
  for (let i = 0; i < base.length * (factor - 1); i++) {
    filler.push({
      id: `filler-${i}`,
      match: {
        mpn: [`ZFILL${i}`, `ZFILL${i}-TR`],
        valueRegex: `(?i)^zfill${i}$`,
        refdesPrefix: prefixes[i % prefixes.length],
        footprintRegex: `^Filler:ZF-${i}$`,
      },
      model: { type: 'model-card', file: `filler-${i}.lib`, name: `ZFILL${i}` },
      pinMaps: {},
      provenance: 'test filler',
    })
  }
  return [...base, ...filler]
}

interface Kind {
  prefix: string
  value: string
  lib: string
  pads: number
  /** A stub-rule part: pad 1 is on +3V3 and pad 2 on GND, as a stubbed controller's supply pads are. */
  supply?: boolean
}

/** Cycle of part kinds; roughly the mix of a small mixed-signal board. */
const KINDS: Kind[] = [
  { prefix: 'R', value: '10k', lib: 'Resistor_SMD:R_0805_2012Metric', pads: 2 },
  { prefix: 'C', value: '100nF', lib: 'Capacitor_SMD:C_0805_2012Metric', pads: 2 },
  { prefix: 'R', value: '4.7k', lib: 'Resistor_SMD:R_0603_1608Metric', pads: 2 },
  { prefix: 'D', value: '1N4148W', lib: 'Diode_SMD:D_SOD-123', pads: 2 },
  { prefix: 'D', value: 'LED', lib: 'LED_SMD:LED_0805_2012Metric', pads: 2 },
  { prefix: 'Q', value: '2N3904', lib: 'Package_TO_SOT_SMD:SOT-23', pads: 3 },
  { prefix: 'U', value: 'LM358', lib: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', pads: 8 },
  { prefix: 'D', value: 'MysteryDiode', lib: 'Diode_SMD:D_SOD-123', pads: 2 },
  { prefix: 'U', value: 'NoSuchChip', lib: 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm', pads: 4 },
  { prefix: 'C', value: '10uF', lib: 'Capacitor_SMD:C_1206_3216Metric', pads: 2 },
  { prefix: 'U', value: 'ESP32-WROOM-32', lib: 'RF_Module:ESP32-WROOM-32', pads: 4, supply: true },
  { prefix: 'D', value: 'WS2812B', lib: 'LED_SMD:LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm', pads: 4, supply: true },
]

/**
 * A circuit of `parts` parts and about `parts` nets (plus GND and +3V3), ground set to
 * the net named GND. Deterministic: the same size gives the same circuit.
 */
export function scaleCircuit(parts: number): Circuit {
  const netCount = parts
  const nets = ['GND', '+3V3', ...Array.from({ length: netCount }, (_, i) => `N${i}`)]
  const footprints: SyntheticFootprint[] = []
  for (let i = 0; i < parts; i++) {
    const kind = KINDS[i % KINDS.length]
    const pads: SyntheticPad[] = []
    for (let p = 0; p < kind.pads; p++) {
      pads.push({
        num: String(p + 1),
        x: p * 1.5,
        y: 0,
        w: 1,
        h: 1.3,
        net: kind.supply && p < 2
          ? (p === 0 ? '+3V3' : 'GND')
          : p === 0 && i % 7 === 0 ? 'GND' : nets[2 + ((i + p * 31) % netCount)],
      })
    }
    footprints.push({
      ref: `${kind.prefix}${i + 1}`,
      value: kind.value,
      lib: kind.lib,
      at: { x: (i % 60) * 4, y: Math.floor(i / 60) * 4, rot: 0 },
      side: 'F',
      pads,
    })
  }
  const side = Math.max(60, Math.ceil(parts / 60) * 4 + 10)
  const board = parseBoard(
    generateBoard({
      kicad: 10,
      nets,
      outline: { x0: -5, y0: -5, x1: 250, y1: side },
      footprints,
    }),
  )
  const probe = extract(board)
  const ground = probe.nets.find((n) => n.kicadName === 'GND') ?? suggestGround(probe.nets)
  if (!ground) throw new Error('scale circuit has no ground net')
  return extract(board, { groundNetId: ground.id })
}
