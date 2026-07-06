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
 * The "leaf" of a KiCad net name. Real boards label nets from global /
 * hierarchical labels with a sheet-path prefix — the root-sheet GND net is
 * named "/GND" and a sub-sheet rail "/Power/+5V". The heuristics below match on
 * the final path segment so "/GND" still reads as ground and "/Power/+5V" as a
 * supply. A bare name (no slash) is returned unchanged.
 */
function leafNetName(name: string): string {
  const parts = name.split('/').filter(p => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : name
}

/**
 * Ground-reference net names (case-insensitive): GND, AGND, DGND, VSS, 0V.
 * Shared by suggestGround (positive match) and suggestSupplies (exclusion — a
 * ground-named net must never be offered as a supply rail).
 */
const GROUND_NAMES = /^(gnd|agnd|dgnd|vss|0v)$/i

/**
 * Suggest which net is the ground reference.
 * Matches (case-insensitive): GND, AGND, DGND, VSS, 0V — including hierarchical
 * forms like "/GND" or "/Power/AGND".
 */
export function suggestGround(nets: CircuitNet[]): CircuitNet | undefined {
  return nets.find(n => GROUND_NAMES.test(leafNetName(n.kicadName)))
}

/**
 * Suggest which nets are power supply rails, best candidates first.
 *
 * Matching is on the leaf net name (case-insensitive). A net is a candidate if
 * any of:
 *   a. full-name match: VCC, VDD, 3V3, 5V, 12V, V+, VIN, VBUS, VBAT, or a
 *      voltage-like pattern (\+?\d+(\.\d+)?V\d* — "+5V", "+3.3V", "12V") —
 *      including hierarchical forms like "/VCC" or "/Power/+5V";
 *   b. contains a rail token as a substring: vcc, vdd, vbus, vbat, vsys, vpack
 *      ("/INTVCC", "/AVDD", "/VBUS_C");
 *   c. starts with vin, vout, or v+ ("/VIN_CHG", "/VOUT");
 *   d. ends with "+" AND the part before the "+" reads as a power label
 *      ("/PACK+", "BATT+", "B+", "VBAT+", "CELL+", "PWR+"). A bare "+" suffix
 *      is NOT evidence — it also marks USB/diff pairs (D+, USB_D+), opamp/ADC
 *      inputs (IN+, AIN+) and LED polarity labels (LED+), none of which are
 *      rails.
 *
 * Candidates whose leaf carries a sense/feedback signature (sns, sense, fb,
 * ref, div, mon, adc, det — substring) are EXCLUDED: "/VBUS_SNS", "/V_DIV",
 * "/VREF2V5", "/VFB_N", "/VPOT_REF" are measurement taps, not rails. Ground
 * names (GROUND_NAMES — a net named "0V" matches the voltage-like pattern) are
 * likewise EXCLUDED: attaching a supply there would drive SPICE node 0.
 *
 * Results are ranked by strength of name evidence first (a full-name match
 * like VCC or +5V is the strongest signal), then by pad-degree
 * (padRefs.length) descending — a real rail fans out to many pads. The list
 * is capped at 6 entries.
 */
export function suggestSupplies(nets: CircuitNet[]): CircuitNet[] {
  // Named keywords (case-insensitive). Includes common input rails (vin/vbus/
  // vbat) and the bare positive-rail label "v+" so a board's driving net is
  // recognised even when it isn't named vcc/vdd.
  const SUPPLY_NAMES = /^(vcc|vdd|vin|vbus|vbat|v\+|3v3|5v|12v)$/i
  // Voltage-like patterns: optional + then digits, V, optional more digits/decimal
  const SUPPLY_VOLTAGE = /^\+?\d+(\.\d+)?v\d*$/i
  // Rail tokens that mark a supply even inside a longer name ("/INTVCC", "/AVDD").
  const SUPPLY_TOKEN = /vcc|vdd|vbus|vbat|vsys|vpack/i
  // Input/output rail prefixes ("/VIN_CHG", "/VOUT", "V+RAIL").
  const SUPPLY_PREFIX = /^(vin|vout|v\+)/i
  // "+"-suffixed names count only when the part before the "+" looks like a
  // power label (PACK+, BATT+, B+, VBAT+, CELL+, PWR+) — NOT diff pairs (D+,
  // USB_D+), opamp/ADC inputs (IN+, AIN+) or LED polarity labels (LED+).
  const POWER_PLUS_SUFFIX = /^(v|b|bat+|batt|pack|pwr|cell)[a-z0-9_]*\+$/i
  // Sense / feedback / reference taps masquerading as rails ("/VBUS_SNS",
  // "/V_DIV", "/VREF2V5") — never suggest these as the driving supply.
  const SENSE_SIGNATURE = /sns|sense|fb|ref|div|mon|adc|det/i

  const MAX_SUGGESTIONS = 6

  const ranked: { net: CircuitNet; strength: number }[] = []
  for (const n of nets) {
    const name = leafNetName(n.kicadName)
    if (SENSE_SIGNATURE.test(name)) continue
    // Never offer a ground-named net as a supply ("0V" matches SUPPLY_VOLTAGE).
    if (GROUND_NAMES.test(name)) continue

    let strength: number
    if (SUPPLY_NAMES.test(name) || SUPPLY_VOLTAGE.test(name)) {
      strength = 2 // full-name evidence — strongest
    } else if (SUPPLY_TOKEN.test(name) || SUPPLY_PREFIX.test(name) || POWER_PLUS_SUFFIX.test(name)) {
      strength = 1 // partial-name evidence
    } else {
      continue
    }
    ranked.push({ net: n, strength })
  }

  // Sort by evidence strength, then pad-degree descending. Array.prototype.sort
  // is stable, so ties keep the board's net order (deterministic).
  ranked.sort(
    (a, b) => b.strength - a.strength || b.net.padRefs.length - a.net.padRefs.length,
  )

  return ranked.slice(0, MAX_SUGGESTIONS).map(r => r.net)
}
