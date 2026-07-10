/**
 * renderer/store/convergenceCulprit.ts — F2
 *
 * When a transient aborts, ngspice's error text names the deck element (or
 * node) it was struggling with, e.g.
 *
 *   "doAnalyses: TRAN:  Timestep too small; … trouble with mpmos_gen-instance m_q7"
 *   "doAnalyses: TRAN:  Timestep too small; … trouble with node vdrain"
 *
 * Deck element names come from generateDeck as `<letter(s)>_<lowercased ref>`
 * (m_q7 → Q7, x_u2 → U2, d_d3 → D3, vsense_d1 → D1, a_u3_0 → U3), and
 * subckt-internal devices are dotted (m.x_u2.m1 → U2). This module maps the
 * raw abort text back to the human refdes / KiCad net name so the red error
 * banner can say "trouble converging around Q7 (NCE4012S)" instead of leaving
 * the user to decode SPICE jargon from the raw log.
 *
 * Pure string + Circuit lookup logic — unit-tested directly.
 */

import type { Circuit, Part } from '../../../core/netlist/extract'

export interface ConvergenceCulprit {
  kind: 'part' | 'net'
  /** Human refdes ("Q7") or KiCad net name ("VDRAIN"). */
  label: string
  /** Extra context for a part — its value/MPN (e.g. "NCE4012S"), when known. */
  detail?: string
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Find the board part whose refdes is embedded in a deck instance name.
 * Instance names carry `<prefix>_<lowercased ref>` at a segment boundary:
 * "m_q7", "x_u2", "vsense_d1", "a_u3_0" (xspice gate index suffix),
 * subckt-internal "m.x_u2.m1", and multi-segment prefixes like the stub
 * resistors "r_stub_q7_0" (generateDeck names unresolved-part stubs that way —
 * exactly the parts most likely to be the trouble on a real board). Longest
 * refdes wins so Q10 never loses to Q1.
 */
function findPartForInstance(token: string, parts: Part[]): Part | undefined {
  const t = token.toLowerCase()
  const byLengthDesc = [...parts].sort((a, b) => b.ref.length - a.ref.length)
  for (const part of byLengthDesc) {
    const refLc = escapeRe(part.ref.toLowerCase())
    // `<prefix>_<ref>` bounded by start/'.' before and end/'.'/'_' after. The
    // prefix may itself contain underscores ("r_stub_"), so the ref must sit
    // after an underscore with only prefix-ish segments before it.
    if (new RegExp(`(?:^|\\.)[a-z][a-z0-9_]*_${refLc}(?:$|[._])`).test(t)) {
      return part
    }
  }
  return undefined
}

/**
 * Parse ngspice abort/convergence text for the culprit part or net.
 * Returns null when the text names nothing mappable (never throws).
 */
export function parseConvergenceCulprit(
  rawDetail: string,
  circuit: Circuit | null | undefined,
): ConvergenceCulprit | null {
  if (!rawDetail || !circuit) return null

  // "trouble with node <n>" — <n> is the SPICE node name; map to the KiCad net.
  const nodeMatch = rawDetail.match(/trouble with\s+node\s+"?([\w./+-]+)"?/i)
  if (nodeMatch) {
    const token = nodeMatch[1].toLowerCase()
    const net = circuit.nets.find(n => n.spiceNode.toLowerCase() === token)
    // Even an unmapped node name is useful — show it verbatim.
    return { kind: 'net', label: net ? net.kicadName : nodeMatch[1] }
  }

  // "trouble with <model>-instance <name>" (also plain "trouble with instance <name>").
  const instMatch = rawDetail.match(/trouble with\s+(?:\S+-)?instance\s+"?([\w.$-]+)"?/i)
  if (instMatch) {
    const part = findPartForInstance(instMatch[1], circuit.parts)
    if (part) {
      return { kind: 'part', label: part.ref, detail: part.value || undefined }
    }
  }

  return null
}
