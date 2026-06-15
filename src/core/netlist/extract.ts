/**
 * core/netlist/extract.ts
 *
 * Connectivity extraction: BoardModel → Circuit.
 *
 * Produces:
 *   - CircuitNet[]  (net id, KiCad name, SPICE node name, padRefs)
 *   - Part[]        (ref, value, libId, layer, padNet map)
 *   - NetlistWarning[] (floating-pad, single-pad-net)
 *
 * spec §8.3 — interfaces are normative (copied verbatim).
 *
 * Rules:
 *   - Nets with 0 pads are omitted (they exist in the board header but are unused).
 *   - The designated ground net maps to SPICE node "0".
 *   - Pads with no netId emit a 'floating-pad' warning.
 *   - Nets with only one pad emit a 'single-pad-net' warning.
 *   - SPICE node name algorithm: see spiceNames.ts.
 *
 * No imports from electron, react, or three.
 */

import type { BoardModel } from '../kicad/types'
import { buildSpiceNames } from './spiceNames'

// ─── normative interfaces (spec §8.3) ────────────────────────────────────────

export interface Circuit {
  nets: CircuitNet[]
  parts: Part[]
  warnings: NetlistWarning[]
}

export interface CircuitNet {
  id: number
  kicadName: string
  spiceNode: string
  padRefs: { ref: string; pad: string }[]
}

export interface Part {
  ref: string
  value: string
  libId: string
  layer: 'F' | 'B'
  padNet: Map<string /* pad number */, number /* netId */>
  properties: Record<string, string>   // board fields merged with BOM (BOM wins)
}

export type NetlistWarning =
  | { kind: 'floating-pad'; ref: string; pad: string; netName: undefined }
  | { kind: 'single-pad-net'; netName: string; ref?: string; pad?: string }

// ─── extract options ──────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** The netId that should be mapped to SPICE node "0". */
  groundNetId?: number
}

// ─── main function ────────────────────────────────────────────────────────────

/**
 * Extract a Circuit from a parsed BoardModel.
 *
 * @param board   Parsed board model (from parseBoard)
 * @param opts    Optional: designate the ground net id
 */
export function extract(board: BoardModel, opts: ExtractOptions = {}): Circuit {
  const { groundNetId } = opts
  const warnings: NetlistWarning[] = []

  // Build the SPICE node name map for all nets in the board
  const spiceNodeMap = buildSpiceNames(board.netById, groundNetId)

  // Accumulate padRefs per netId
  // netId → array of { ref, pad }
  const padRefsByNet = new Map<number, { ref: string; pad: string }[]>()

  // Initialize with all known nets (from board header)
  for (const net of board.netById.values()) {
    padRefsByNet.set(net.id, [])
  }

  // Build Part objects and collect padRefs
  const parts: Part[] = []

  for (const footprint of board.footprints) {
    const part: Part = {
      ref: footprint.ref,
      value: footprint.value,
      libId: footprint.libId,
      layer: footprint.layer,
      padNet: new Map(),
      properties: { ...footprint.properties },
    }

    for (const pad of footprint.pads) {
      if (pad.netId === undefined) {
        // Floating pad — no net connection
        warnings.push({
          kind: 'floating-pad',
          ref: footprint.ref,
          pad: pad.number,
          netName: undefined,
        })
      } else {
        part.padNet.set(pad.number, pad.netId)

        // Add to padRefs for this net
        let refs = padRefsByNet.get(pad.netId)
        if (!refs) {
          refs = []
          padRefsByNet.set(pad.netId, refs)
        }
        refs.push({ ref: footprint.ref, pad: pad.number })
      }
    }

    parts.push(part)
  }

  // Build CircuitNet array — only include nets that have ≥1 pad
  const nets: CircuitNet[] = []

  for (const net of board.netById.values()) {
    const padRefs = padRefsByNet.get(net.id) ?? []

    if (padRefs.length === 0) {
      // Net exists in header but has no pads — skip (not a real circuit net)
      continue
    }

    const spiceNode = spiceNodeMap.get(net.id) ?? net.name.toLowerCase()

    const circuitNet: CircuitNet = {
      id: net.id,
      kicadName: net.name,
      spiceNode,
      padRefs,
    }

    nets.push(circuitNet)

    // Single-pad-net warning
    if (padRefs.length === 1) {
      warnings.push({
        kind: 'single-pad-net',
        netName: net.name,
        ref: padRefs[0].ref,
        pad: padRefs[0].pad,
      })
    }
  }

  return { nets, parts, warnings }
}

// ─── ground / supply heuristics ──────────────────────────────────────────────

/**
 * Suggest which net is the ground reference.
 * Matches (case-insensitive): GND, AGND, DGND, VSS, 0V
 */
export function suggestGround(nets: CircuitNet[]): CircuitNet | undefined {
  const GROUND_NAMES = /^(gnd|agnd|dgnd|vss|0v)$/i
  return nets.find(n => GROUND_NAMES.test(n.kicadName))
}

/**
 * Suggest which nets are power supply rails.
 * Matches (case-insensitive): VCC, VDD, 3V3, 5V, +5V, +3.3V, 12V, and
 * general patterns like \+?\d+V\d* or \d+V\d*.
 */
export function suggestSupplies(nets: CircuitNet[]): CircuitNet[] {
  // Named keywords (case-insensitive)
  const SUPPLY_NAMES = /^(vcc|vdd|3v3|5v|12v)$/i
  // Voltage-like patterns: optional + then digits, V, optional more digits/decimal
  const SUPPLY_VOLTAGE = /^\+?\d+(\.\d+)?v\d*$/i

  return nets.filter(n => {
    const name = n.kicadName
    return SUPPLY_NAMES.test(name) || SUPPLY_VOLTAGE.test(name)
  })
}
