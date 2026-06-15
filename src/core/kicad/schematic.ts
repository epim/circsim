/**
 * core/kicad/schematic.ts
 *
 * Minimal KiCad schematic (.kicad_sch) parser that extracts simulation data.
 *
 * Produces SchematicSimData = Map<ref, SymbolSimInfo>, where each entry
 * contains the six Sim.* property fields, pin list, and no-connect markers.
 *
 * v1 NOTE: This implementation flat-scans all (symbol ...) instances at the
 * top level. Hierarchical-sheet files contain (sheet ...) elements that
 * recursively reference child schematics — resolving those hierarchy paths
 * and merging child symbol instances is intentionally deferred to v2.
 * A v1 user loading a flat single-sheet design (the common case for Quilter
 * outputs) will see complete data; hierarchical designs will silently see only
 * the symbols visible in the root sheet.
 *
 * Spec §2, §8.2
 */

import { parseSexpr, find, atom, SExpr } from '../sexpr/parse'

// ─── public types ─────────────────────────────────────────────────────────────

/**
 * Per-symbol simulation info extracted from a .kicad_sch file.
 *
 * Matches spec §8.2 / plan Task 5 exactly — do not rename fields.
 */
export interface SymbolSimInfo {
  /** The Value property of the symbol instance (e.g. "NE555", "10k"). */
  value?: string
  /**
   * The six Sim.* property fields, keyed WITHOUT the "Sim." prefix.
   * Only keys that are present in the schematic appear here.
   */
  sim: Partial<Record<'Device' | 'Type' | 'Params' | 'Pins' | 'Library' | 'Name', string>>
  /**
   * Pin list resolved from lib_symbols. Each entry has the pin number,
   * name, and electrical type (passive, input, output, power_in, etc.).
   */
  pins: { number: string; name: string; type: string }[]
  /**
   * Pin numbers of no-connect markers on this symbol instance.
   * A no-connect inside a (symbol ...) block carries a (pin "N" ...) child.
   */
  noConnects: string[]
}

/**
 * Map from reference designator (e.g. "U1", "R1") to its simulation info.
 */
export type SchematicSimData = Map<string, SymbolSimInfo>

// ─── SExpr helpers ────────────────────────────────────────────────────────────

function strAtom(node: SExpr, index: number): string {
  const v = atom(node, index)
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return ''
}

// ─── lib_symbols parsing ──────────────────────────────────────────────────────

interface LibSymbolPin {
  number: string
  name: string
  type: string // electrical type: passive, input, output, power_in, open_collector, etc.
}

interface LibSymbolInfo {
  pins: LibSymbolPin[]
}

/**
 * Parse the (lib_symbols ...) block to build a map of symbolId → pin list.
 * symbolId is the "Name:Variant" key used in (lib_id "...") references.
 *
 * KiCad lib_symbols structure:
 *   (lib_symbols
 *     (symbol "Timer:NE555" ...
 *       (symbol "NE555_0_0"
 *         (pin <type> <shape> (at ...) (name "PINNAME" ...) (number "NN" ...))
 *         ...
 *       )
 *     )
 *   )
 */
function parseLibSymbols(root: SExpr): Map<string, LibSymbolInfo> {
  const libMap = new Map<string, LibSymbolInfo>()
  if (!Array.isArray(root)) return libMap

  const libSymbolsNode = find(root, 'lib_symbols')
  if (!libSymbolsNode || !Array.isArray(libSymbolsNode)) return libMap

  for (const symbolDef of libSymbolsNode) {
    if (!Array.isArray(symbolDef) || symbolDef[0] !== 'symbol') continue

    const symbolId = strAtom(symbolDef, 1)
    const pins: LibSymbolPin[] = []

    // Recursively find all (pin ...) nodes inside this symbol definition
    // They may be nested inside sub-symbol blocks like (symbol "NE555_0_0" ...)
    collectPins(symbolDef, pins)

    libMap.set(symbolId, { pins })
  }

  return libMap
}

/**
 * Recursively collect all (pin ...) nodes from a symbol definition tree.
 * KiCad symbols can nest sub-unit symbols: (symbol "Name_0_0" (pin ...) ...)
 */
function collectPins(node: SExpr, pins: LibSymbolPin[]): void {
  if (!Array.isArray(node)) return

  for (const child of node) {
    if (!Array.isArray(child)) continue

    if (child[0] === 'pin') {
      // (pin <type> <shape> (at ...) (length ...) (name "..." ...) (number "..." ...))
      const type = strAtom(child, 1)  // e.g. "passive", "input", "power_in"

      const nameNode = find(child, 'name')
      const pinName = nameNode && Array.isArray(nameNode) ? strAtom(nameNode, 1) : ''

      const numberNode = find(child, 'number')
      const pinNumber = numberNode && Array.isArray(numberNode) ? strAtom(numberNode, 1) : ''

      if (pinNumber !== '') {
        pins.push({ number: pinNumber, name: pinName, type })
      }
    } else if (child[0] === 'symbol') {
      // Recurse into sub-unit symbols
      collectPins(child, pins)
    }
  }
}

// ─── symbol instance parsing ──────────────────────────────────────────────────

/**
 * Parse a single top-level (symbol ...) instance.
 *
 * Returns { ref, info } or null if this is not a placed instance
 * (lib_symbols entries are also symbol nodes but are inside lib_symbols,
 * so they won't appear at root level and we won't encounter them here).
 */
function parseSymbolInstance(
  node: SExpr,
  libMap: Map<string, LibSymbolInfo>
): { ref: string; info: SymbolSimInfo } | null {
  if (!Array.isArray(node) || node[0] !== 'symbol') return null

  // Instance-level symbol has (lib_id "...") as a child — lib_symbols entries do not
  const libIdNode = find(node, 'lib_id')
  if (!libIdNode) return null

  // Extract reference designator from (property "Reference" "U1" ...)
  let ref = ''
  let value: string | undefined

  const sim: SymbolSimInfo['sim'] = {}
  const noConnects: string[] = []

  for (const child of node) {
    if (!Array.isArray(child)) continue

    if (child[0] === 'property') {
      const propName = strAtom(child, 1)
      const propValue = strAtom(child, 2)

      if (propName === 'Reference') {
        ref = propValue
      } else if (propName === 'Value') {
        value = propValue
      } else if (propName.startsWith('Sim.')) {
        const key = propName.slice(4) as keyof typeof sim
        if (key === 'Device' || key === 'Type' || key === 'Params' ||
            key === 'Pins' || key === 'Library' || key === 'Name') {
          sim[key] = propValue
        }
      }
    }

    // No-connect markers: (no_connect (at ...) (pin "5") (uuid ...))
    if (child[0] === 'no_connect') {
      const pinNode = find(child, 'pin')
      if (pinNode && Array.isArray(pinNode)) {
        // (pin "5" (uuid ...)) — pin number is at index 1
        const pinNum = strAtom(pinNode, 1)
        if (pinNum !== '') {
          noConnects.push(pinNum)
        }
      }
    }
  }

  if (ref === '') return null

  // Resolve pin list from lib_symbols
  const libId = strAtom(libIdNode, 1)
  const libInfo = libMap.get(libId)
  const pins: LibSymbolPin[] = libInfo ? libInfo.pins : []

  return {
    ref,
    info: {
      value,
      sim,
      pins,
      noConnects,
    },
  }
}

// ─── main export ──────────────────────────────────────────────────────────────

/**
 * Parse a .kicad_sch file and extract simulation-relevant data for each symbol.
 *
 * Returns a Map<ref, SymbolSimInfo> where:
 * - ref is the reference designator (e.g. "U1", "R1")
 * - info contains value, Sim.* properties, pin list (from lib_symbols), and
 *   any no-connect markers
 *
 * Tolerant of unknown tokens — never throws on unrecognized atoms.
 * Throws SexprError only if the file is structurally malformed.
 */
export function parseSchematicSimData(text: string): SchematicSimData {
  const root = parseSexpr(text)
  if (!Array.isArray(root) || root[0] !== 'kicad_sch') {
    throw new Error('Not a valid .kicad_sch file: root node must be kicad_sch')
  }

  // Parse lib_symbols first to resolve pin lists
  const libMap = parseLibSymbols(root)

  // Flat-scan all top-level (symbol ...) instances
  // NOTE: v1 ignores hierarchical sheet references — see module docblock.
  const result: SchematicSimData = new Map()

  for (const child of root) {
    if (!Array.isArray(child) || child[0] !== 'symbol') continue
    const parsed = parseSymbolInstance(child, libMap)
    if (parsed) {
      result.set(parsed.ref, parsed.info)
    }
  }

  return result
}
