/**
 * Shared builders for the P2 resolution tests (issues #4, #5, #6, #7, #51).
 * Not a test file: vitest only collects *.test.ts.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Circuit, Part } from '../../netlist/extract'
import type { SymbolSimInfo } from '../../kicad/schematic'
import type { LibraryEntry } from '../types'

/** The bundled index, exactly as the app ships it. */
export function bundledLibrary(): LibraryEntry[] {
  const text = readFileSync(join(process.cwd(), 'resources', 'models', 'index.json'), 'utf8')
  return (JSON.parse(text) as { entries: LibraryEntry[] }).entries
}

export function makePart(
  ref: string,
  value: string,
  libId: string,
  properties: Record<string, string> = {},
  padNet: Array<[string, number]> = [['1', 1], ['2', 2]],
): Part {
  return { ref, value, libId, layer: 'F', padNet: new Map(padNet), properties }
}

export function makeCircuit(parts: Part[]): Circuit {
  return {
    nets: [
      { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
      { id: 2, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
    ],
    parts,
    warnings: [],
  }
}

export function simInfo(
  sim: Partial<SymbolSimInfo['sim']>,
  pins: SymbolSimInfo['pins'] = [],
  value?: string,
): SymbolSimInfo {
  return { value, sim, pins, noConnects: [] }
}
