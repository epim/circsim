/**
 * core/kicad/schematic.ts
 *
 * Minimal KiCad schematic (.kicad_sch) parser that extracts simulation data.
 *
 * Produces SchematicSimData = Map<ref, SymbolSimInfo>, where each entry
 * contains the six Sim.* property fields, pin list, and the pins that carry a
 * no-connect marker.
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
   * Pin numbers of this symbol instance that carry a no-connect marker.
   *
   * KiCad writes a no-connect as a sheet-level `(no_connect (at x y) (uuid ...))`
   * with coordinates only (never nested in a symbol, never naming a pin). A pin
   * is reported here when a marker sits on the pin's connection point in sheet
   * coordinates, after the instance's position, rotation, mirror and unit are
   * applied to the library pin position. Markers that touch no pin of the flat
   * root sheet (for example a marker on a hierarchical sheet pin) are ignored.
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

function numAtom(node: SExpr, index: number, fallback = 0): number {
  const v = atom(node, index)
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isNaN(n) ? fallback : n
  }
  return fallback
}

// ─── lib_symbols parsing ──────────────────────────────────────────────────────

interface LibSymbolPin {
  number: string
  name: string
  type: string // electrical type: passive, input, output, power_in, open_collector, etc.
}

/** A pin's connection point in symbol-library coordinates (mm, Y up). */
interface LibPlacedPin {
  number: string
  x: number
  y: number
  /** Unit this pin belongs to; 0 means common to every unit. */
  unit: number
  /** Body style (De Morgan) this pin belongs to; 0 means common to all styles. */
  style: number
}

interface LibSymbolInfo {
  pins: LibSymbolPin[]
  placed: LibPlacedPin[]
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
    const placed: LibPlacedPin[] = []

    // Recursively find all (pin ...) nodes inside this symbol definition
    // They may be nested inside sub-symbol blocks like (symbol "NE555_0_0" ...)
    collectPins(symbolDef, pins, placed, 0, 0)

    libMap.set(symbolId, { pins, placed })
  }

  return libMap
}

/**
 * Recursively collect all (pin ...) nodes from a symbol definition tree.
 * KiCad symbols can nest sub-unit symbols: (symbol "Name_0_0" (pin ...) ...)
 */
function collectPins(
  node: SExpr,
  pins: LibSymbolPin[],
  placed: LibPlacedPin[],
  unit: number,
  style: number,
): void {
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
        const atNode = find(child, 'at')
        if (atNode && Array.isArray(atNode)) {
          placed.push({
            number: pinNumber,
            x: numAtom(atNode, 1),
            y: numAtom(atNode, 2),
            unit,
            style,
          })
        }
      }
    } else if (child[0] === 'symbol') {
      // Recurse into sub-unit symbols. KiCad names them "<Name>_<unit>_<style>".
      const m = /_(\d+)_(\d+)$/.exec(strAtom(child, 1))
      collectPins(child, pins, placed, m ? Number(m[1]) : unit, m ? Number(m[2]) : style)
    }
  }
}

// ─── no-connect markers ───────────────────────────────────────────────────────

interface Vec {
  x: number
  y: number
}

/** Marker-to-pin match tolerance (mm). Pins and markers sit on a 1.27 mm grid or finer. */
const NC_TOLERANCE_MM = 0.02

/**
 * Collect the sheet-level no-connect markers: `(no_connect (at x y) (uuid ...))`.
 * This is the only shape KiCad writes.
 */
function parseNcMarkers(root: SExpr): Vec[] {
  const out: Vec[] = []
  if (!Array.isArray(root)) return out
  for (const child of root) {
    if (!Array.isArray(child) || child[0] !== 'no_connect') continue
    const at = find(child, 'at')
    if (at && Array.isArray(at)) out.push({ x: numAtom(at, 1), y: numAtom(at, 2) })
  }
  return out
}

/**
 * Sheet position of a library pin for a placed instance. Library coordinates
 * are Y up and the sheet is Y down. The counter-clockwise rotation applies
 * first, then the instance mirror (`(mirror x)` flips Y, `(mirror y)` flips X)
 * in the rotated frame, as KiCad does, then the translation to the instance
 * origin. The order matters for 90 and 270 degree rotations.
 */
function pinSheetPos(pin: LibPlacedPin, at: Vec, rotDeg: number, mirror: string): Vec {
  const rad = (rotDeg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  let rx = pin.x * c - pin.y * s
  let ry = pin.x * s + pin.y * c
  if (mirror === 'x') ry = -ry
  else if (mirror === 'y') rx = -rx
  return { x: at.x + rx, y: at.y - ry }
}

/** Pin numbers of a placed instance that have a no-connect marker on them. */
function markedPins(node: SExpr[], lib: LibSymbolInfo, markers: Vec[]): string[] {
  if (markers.length === 0) return []
  const atNode = find(node, 'at')
  if (!atNode || !Array.isArray(atNode)) return []
  const at = { x: numAtom(atNode, 1), y: numAtom(atNode, 2) }
  const rotDeg = numAtom(atNode, 3)
  const mirrorNode = find(node, 'mirror')
  const mirror = mirrorNode && Array.isArray(mirrorNode) ? strAtom(mirrorNode, 1) : ''
  const unitNode = find(node, 'unit')
  const unit = unitNode && Array.isArray(unitNode) ? numAtom(unitNode, 1, 1) : 1
  const styleNode = find(node, 'body_style') ?? find(node, 'convert')
  const style = styleNode && Array.isArray(styleNode) ? numAtom(styleNode, 1, 1) : 1

  const found: string[] = []
  for (const pin of lib.placed) {
    if (pin.unit !== 0 && pin.unit !== unit) continue
    if (pin.style !== 0 && pin.style !== style) continue
    const pos = pinSheetPos(pin, at, rotDeg, mirror)
    const hit = markers.some(
      (m) => Math.abs(m.x - pos.x) <= NC_TOLERANCE_MM && Math.abs(m.y - pos.y) <= NC_TOLERANCE_MM,
    )
    if (hit && !found.includes(pin.number)) found.push(pin.number)
  }
  return found
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
  libMap: Map<string, LibSymbolInfo>,
  ncMarkers: Vec[]
): { ref: string; info: SymbolSimInfo } | null {
  if (!Array.isArray(node) || node[0] !== 'symbol') return null

  // Instance-level symbol has (lib_id "...") as a child — lib_symbols entries do not
  const libIdNode = find(node, 'lib_id')
  if (!libIdNode) return null

  // Extract reference designator from (property "Reference" "U1" ...)
  let ref = ''
  let value: string | undefined

  const sim: SymbolSimInfo['sim'] = {}
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
  }

  if (ref === '') return null

  // Resolve pin list from lib_symbols
  const libId = strAtom(libIdNode, 1)
  const libInfo = libMap.get(libId)
  const pins: LibSymbolPin[] = libInfo ? libInfo.pins : []
  const noConnects = libInfo ? markedPins(node, libInfo, ncMarkers) : []

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
 *   the pins a sheet-level no-connect marker sits on
 *
 * Tolerant of unknown tokens — never throws on unrecognized atoms.
 * Throws SexprError only if the file is structurally malformed.
 */
export function parseSchematicSimData(text: string): SchematicSimData {
  const root = parseSexpr(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  if (!Array.isArray(root) || root[0] !== 'kicad_sch') {
    throw new Error('Not a valid .kicad_sch file: root node must be kicad_sch')
  }

  // Parse lib_symbols first to resolve pin lists
  const libMap = parseLibSymbols(root)

  // Flat-scan all top-level (symbol ...) instances
  // NOTE: v1 ignores hierarchical sheet references — see module docblock.
  const result: SchematicSimData = new Map()
  const ncMarkers = parseNcMarkers(root)

  for (const child of root) {
    if (!Array.isArray(child) || child[0] !== 'symbol') continue
    const parsed = parseSymbolInstance(child, libMap, ncMarkers)
    if (parsed) {
      // A multi-unit part is several placed instances sharing one reference;
      // keep the last instance's fields but accumulate every unit's no-connects.
      const prior = result.get(parsed.ref)
      if (prior) {
        for (const n of prior.noConnects) {
          if (!parsed.info.noConnects.includes(n)) parsed.info.noConnects.push(n)
        }
      }
      result.set(parsed.ref, parsed.info)
    }
  }

  return result
}
