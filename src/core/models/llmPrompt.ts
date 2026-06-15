/**
 * core/models/llmPrompt.ts — Task 25
 *
 * buildLlmPrompt(part, padList) → string
 *
 * Generates a clipboard-ready plain-text prompt for the user to paste into
 * their own LLM (Claude, ChatGPT, etc.) to obtain an ngspice-compatible
 * .subckt model for a part that circsim couldn't auto-resolve.
 *
 * Design rules (Spec §8.7):
 *   - Pure function: no I/O, no side effects, deterministic output.
 *   - Includes MPN (from Part.properties.MPN, else falls back to value).
 *   - Includes the footprint / package string.
 *   - Lists every pad number with its pin name when known.
 *   - States the required .subckt header with exact node count.
 *   - States ngspice-dialect constraints:
 *       · self-contained (no .lib / .include lines)
 *       · end with .ends
 *       · plain decimal/scientific values (never letter suffixes — avoids the
 *         SPICE M-means-milli trap; spicegen emits plain numbers)
 *       · compatible with ngspice 46
 *   - Instructs to cite datasheet values for parameters.
 *
 * No imports from electron, react, or three. Spec §8.
 */

import type { Part } from '../netlist/extract'

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface PadInfo {
  number: string
  /** Schematic pin name, if available from the .kicad_sch. */
  name?: string
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Build a clipboard-ready LLM prompt for generating an ngspice .subckt model.
 *
 * @param part     The unresolved Part from the circuit.
 * @param padList  The pad numbers (+ optional schematic pin names) for this part.
 * @returns        A plain-text string ready to copy to the clipboard.
 */
export function buildLlmPrompt(part: Part, padList: PadInfo[]): string {
  const mpn = resolveMpn(part)
  const footprint = part.libId  // e.g. "Package_DIP:DIP-8_W7.62"
  const nodeCount = padList.length

  // Build the pad table for the prompt.
  const padLines = padList
    .map(p => {
      const name = p.name ? ` (${p.name})` : ''
      return `  Pad ${p.number}${name}`
    })
    .join('\n')

  // Build the required subckt header showing all node names.
  const nodeNames = padList.map(p => (p.name ?? `node${p.number}`).replace(/\s/g, '_'))
  const subcktHeader = `.subckt ${mpn.replace(/\s+/g, '_')} ${nodeNames.join(' ')}`

  const lines: string[] = [
    `Please write an ngspice-compatible SPICE subcircuit model for the following part.`,
    ``,
    `Part number (MPN): ${mpn}`,
    `Reference: ${part.ref}`,
    `Package / footprint: ${footprint}`,
    ``,
    `This part has ${nodeCount} terminal${nodeCount !== 1 ? 's' : ''} (${nodeCount} node${nodeCount !== 1 ? 's' : ''} required in the .subckt header):`,
    padLines,
    ``,
    `Required .subckt header (use exactly these ${nodeCount} node${nodeCount !== 1 ? 's' : ''} in this order):`,
    subcktHeader,
    `  ... model body ...`,
    `.ends ${mpn.replace(/\s+/g, '_')}`,
    ``,
    `IMPORTANT ngspice-dialect constraints — please follow these exactly:`,
    ``,
    `1. Self-contained: do NOT include any .lib, .include, or .model references`,
    `   to external files. The subckt must work as a standalone paste.`,
    ``,
    `2. End the subckt with ".ends" (required by ngspice).`,
    ``,
    `3. Plain decimal/scientific values only — never letter suffixes like 1k, 1M,`,
    `   1n, etc. Use 1000, 1e6, 1e-9 instead. This avoids the SPICE M-means-milli`,
    `   trap (in SPICE netlists, M = milli, not mega).`,
    ``,
    `4. Compatible with ngspice 46 syntax. Use standard SPICE2/3 elements (R, C, L,`,
    `   V, E, G, F, H, D, Q, M) and XSPICE primitives when needed (adc_bridge,`,
    `   dac_bridge, d_inverter, etc.).`,
    ``,
    `5. Cite datasheet parameter values in comments so the model can be verified.`,
    `   Example: "* Vf = 0.7 V typical (datasheet Fig.3)"`,
    ``,
    `Please return ONLY the .subckt block (starting with .subckt, ending with .ends).`,
    `No explanation text before or after — just the raw SPICE text.`,
  ]

  return lines.join('\n')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine the best MPN/identifier for this part:
 *   1. Part.properties.MPN (from BOM or board properties)
 *   2. Part.properties['Part Number']
 *   3. Part.value (the KiCad value field)
 *   4. Part.ref as last resort
 */
function resolveMpn(part: Part): string {
  const mpnFromProps =
    part.properties['MPN'] ??
    part.properties['Part Number'] ??
    part.properties['mpn']
  return mpnFromProps ?? (part.value || part.ref)
}
