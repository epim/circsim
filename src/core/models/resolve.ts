/**
 * core/models/resolve.ts
 *
 * Model resolution pipeline: Part → Resolution via tier cascade.
 *
 * Tier cascade (first hit wins):
 *   1 — Schematic Sim.* fields (R/C/L/V/I primitives + SUBCKT)
 *   2 — Built-in primitive inference (R/C/L from refdes prefix + parseValue)
 *   3 — Bundled library match [seam — library param, not yet implemented]
 *   4 — User .lib import [not yet implemented]
 *   5 — LLM-assist paste [not yet implemented]
 *   6 — Stub (open/short/interactive-pins) — fallback for everything else
 *
 * Task 12 implements tiers 1, 2, and 6.
 * Tiers 3 and 4 are clean seams: the library and userLib parameters exist
 * but are currently unused (returns unresolved for now).
 *
 * No imports from electron, react, or three. Model validation is injected
 * as a callback (validateModel) — the actual ngspice call is wired by the
 * test/caller, not imported into core.
 *
 * Spec §8.5
 */

import type { Circuit, Part } from '../netlist/extract'
import type { SchematicSimData } from '../kicad/schematic'
import type { LibraryEntry, PinMap, ResolvedModel, Resolution } from './types'
import { parseValue } from '../values/parseValue'
import { matchLibraryEntry, selectPinMap } from './libraryMatch'
import type { PartDescriptor } from './libraryMatch'

// ─── BOM type seam ───────────────────────────────────────────────────────────

/** Minimal BOM row shape (matches parseBom output). */
interface BomRow {
  value?: string
  mpn?: string
  footprint?: string
}
export type BomData = Map<string, BomRow>

// ─── User override type ───────────────────────────────────────────────────────

export type UserStubOverride = { kind: 'stub'; mode: 'open' | 'short' | 'interactive-pins' }

// ─── SPICE primitive device types ────────────────────────────────────────────

/** Device letter → card prefix mapping for top-level SPICE primitives. */
const PRIMITIVE_DEVICE_LETTERS: Record<string, string> = {
  R: 'r',
  C: 'c',
  L: 'l',
  V: 'v',
  I: 'i',
  D: 'd',
  Q: 'q',
  M: 'm',
  J: 'j',
  E: 'e',
  F: 'f',
  G: 'g',
  H: 'h',
  K: 'k',
}

// ─── Refdes prefix → SPICE device letter ─────────────────────────────────────

/**
 * R1 → 'R', C12 → 'C', L3 → 'L', U1 → null (not a simple primitive).
 * The prefix is the leading non-digit part of the ref.
 */
function refdesPrefix(ref: string): string {
  const m = ref.match(/^([A-Za-z]+)/)
  return m ? m[1].toUpperCase() : ''
}

/** Parts whose refdes prefix we infer as R/C/L primitives in tier 2. */
const TIER2_PRIMITIVE_PREFIXES = new Set(['R', 'C', 'L'])

// ─── Value emission (plain decimal/exponent, no letter suffixes) ──────────────

/**
 * Format a numeric value (in SI base units) as plain decimal or exponent.
 * Avoids letter suffixes entirely (spec §8.8 rule: never letter suffixes in decks).
 *
 * Strategy:
 *   - Values in [0.01, 1e9): use plain decimal where possible
 *   - Very small values (< 0.01): use exponential notation
 *   - Very large values (≥ 1e9): use exponential notation
 *
 * Examples:
 *   10000       → "10000"
 *   4.7e-6      → "4.7e-6"
 *   1e-7        → "1e-7"
 *   0.22        → "0.22"
 *   470         → "470"
 */
function formatSpiceValue(v: number): string {
  if (v === 0) return '0'

  const abs = Math.abs(v)

  // Threshold below which we switch to exponential notation
  // 0.01 = 10mΩ, 10pF etc — anything smaller gets exponent form
  const EXP_THRESHOLD = 0.01

  if (abs < EXP_THRESHOLD || abs >= 1e9) {
    // Exponential notation, clean mantissa
    const exp = Math.floor(Math.log10(abs))
    const mantissa = v / Math.pow(10, exp)
    // Round to 10 significant figures to avoid floating-point noise
    const mantissaRounded = parseFloat(mantissa.toPrecision(10))
    return `${mantissaRounded}e${exp}`
  }

  // Plain decimal range [0.01, 1e9)
  // JS toString() will naturally produce the right form for integers and simple decimals
  // (e.g. 0.22, 4700, 10000, 0.022)
  // but may produce scientific notation for values like 1e-7 if they end up here;
  // the threshold ensures they don't.
  const str = v.toString()
  // If JS chose exponential anyway (shouldn't happen in this range, but guard it)
  if (str.includes('e')) {
    // Fall back to toPrecision to force decimal
    return parseFloat(v.toPrecision(10)).toString()
  }
  return str
}

// ─── Electrolytic polarity detection ─────────────────────────────────────────

/**
 * Returns true if the part's libId suggests an electrolytic (polarized) capacitor.
 * Matches footprint names containing CP_ or Elec (case-insensitive).
 */
function isElectrolytic(part: Part): boolean {
  const libId = part.libId ?? ''
  return /CP_/i.test(libId) || /Elec/i.test(libId) || /Radial/i.test(libId)
}

// ─── Sim.Params parser ────────────────────────────────────────────────────────

/**
 * Parse KiCad Sim.Params string into a key=value map.
 * Format: "R=10k C=100n" or "DC=5"
 */
function parseSimParams(params: string): Record<string, string> {
  const result: Record<string, string> = {}
  // Split on whitespace, then on '='
  const tokens = params.trim().split(/\s+/)
  for (const token of tokens) {
    const eqIdx = token.indexOf('=')
    if (eqIdx > 0) {
      const key = token.slice(0, eqIdx).trim()
      const val = token.slice(eqIdx + 1).trim()
      result[key] = val
    }
  }
  return result
}

/**
 * Parse KiCad Sim.Pins string into a PinMap.
 * Format: "1=GND 2=TRIG 3=OUT 4=RESET 5=CTRL 6=THRES 7=DISCH 8=VCC"
 * Returns Record<padNumber, terminalName>.
 */
function parseSimPins(pinsStr: string): PinMap {
  const result: PinMap = {}
  const tokens = pinsStr.trim().split(/\s+/)
  for (const token of tokens) {
    const eqIdx = token.indexOf('=')
    if (eqIdx > 0) {
      const padNum = token.slice(0, eqIdx).trim()
      const terminal = token.slice(eqIdx + 1).trim()
      result[padNum] = terminal
    }
  }
  return result
}

// ─── Node name resolution ─────────────────────────────────────────────────────

/**
 * Build a padNumber → spiceNode map for a part by joining padNet + circuit nets.
 */
function buildPadNodeMap(part: Part, circuit: Circuit): Map<string, string> {
  const netIdToSpiceNode = new Map<number, string>()
  for (const net of circuit.nets) {
    netIdToSpiceNode.set(net.id, net.spiceNode)
  }

  const result = new Map<string, string>()
  for (const [padNum, netId] of part.padNet) {
    const node = netIdToSpiceNode.get(netId)
    if (node !== undefined) {
      result.set(padNum, node)
    }
  }
  return result
}

/**
 * Build a SPICE node list from padNet in ascending pad-number order.
 * For a 2-pad R/C/L: pads "1" and "2" → ["vin", "out"].
 */
function buildNodeList(part: Part, circuit: Circuit): string[] {
  const padNodeMap = buildPadNodeMap(part, circuit)
  // Sort pad numbers numerically where possible, then alphabetically
  const padNums = Array.from(padNodeMap.keys()).sort((a, b) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return a.localeCompare(b)
  })
  return padNums.map(p => padNodeMap.get(p)!).filter(n => n !== undefined)
}

// ─── Element name builder ─────────────────────────────────────────────────────

/** Build the SPICE element name: "r_r1", "c_c1", "x_u1", etc. */
function elementName(deviceLetter: string, ref: string): string {
  return `${deviceLetter.toLowerCase()}_${ref.toLowerCase()}`
}

// ─── Tier 1: Schematic Sim.* resolution ──────────────────────────────────────

/**
 * Attempt tier-1 resolution from schematic Sim.* fields.
 * Returns a Resolution or null if the schematic data doesn't cover this part.
 */
function tryTier1(
  part: Part,
  circuit: Circuit,
  simInfo: { sim: Partial<Record<'Device' | 'Type' | 'Params' | 'Pins' | 'Library' | 'Name', string>> } | undefined,
): Resolution | null {
  if (!simInfo) return null
  const { sim } = simInfo

  const warnings: string[] = []

  // If no Sim fields at all, skip
  if (Object.keys(sim).length === 0) return null

  // Check for out-of-scope device types first
  const device = sim.Device?.toUpperCase()
  const type = sim.Type?.toUpperCase()

  // In KiCad 6/7, the SUBCKT convention uses Sim.Device="SUBCKT" without Sim.Type.
  // In some schematics, Sim.Type="SUBCKT" is also used. Handle both forms.
  const isSubckt = device === 'SUBCKT' || type === 'SUBCKT'

  if (device && !PRIMITIVE_DEVICE_LETTERS[device] && !isSubckt) {
    // Out-of-scope device (e.g. KIBIS, PSPICE, etc.)
    return {
      ref: part.ref,
      status: 'unresolved',
      tier: 1,
      warnings: [`Sim.Device="${sim.Device}" is not supported (out-of-scope device type)`],
    }
  }

  // SUBCKT type: resolve as subckt (handles both Sim.Device=SUBCKT and Sim.Type=SUBCKT)
  if (isSubckt) {
    const libFile = sim.Library ?? ''
    const subcktName = sim.Name ?? ''

    if (!subcktName) {
      return {
        ref: part.ref,
        status: 'unresolved',
        tier: 1,
        warnings: ['Sim.Type=SUBCKT but Sim.Name is missing'],
      }
    }

    // Parse pin map from Sim.Pins
    const pinMap: PinMap = sim.Pins ? parseSimPins(sim.Pins) : {}

    const model: ResolvedModel = {
      kind: 'subckt',
      libFile,
      subcktName,
      pinMap,
    }

    return {
      ref: part.ref,
      status: 'ok',
      model,
      tier: 1,
      warnings,
    }
  }

  // Primitive device (R/C/L/V/I etc.)
  if (device && PRIMITIVE_DEVICE_LETTERS[device]) {
    const deviceLetter = PRIMITIVE_DEVICE_LETTERS[device]
    const elName = elementName(deviceLetter, part.ref)
    const nodes = buildNodeList(part, circuit)
    const nodesStr = nodes.join(' ')

    // Parse params to get the value
    const params = sim.Params ? parseSimParams(sim.Params) : {}

    let valueStr = ''

    // Common param keys by device type
    const valueKey = device === 'R' ? 'R' :
                     device === 'C' ? 'C' :
                     device === 'L' ? 'L' :
                     device === 'V' ? 'DC' :
                     device === 'I' ? 'DC' : undefined

    if (valueKey && params[valueKey]) {
      // Parse and reformat to avoid letter suffixes
      const parsed = parseValue(params[valueKey], device as 'R' | 'C' | 'L')
      if (parsed !== undefined) {
        valueStr = formatSpiceValue(parsed)
      } else {
        // Keep raw if parseValue can't handle it (e.g. complex expressions)
        valueStr = params[valueKey]
      }
    } else if (sim.Params) {
      // Fallback: use raw params (may be an expression like "DC=5")
      // Try to extract a plain numeric value
      const paramEntries = Object.entries(params)
      if (paramEntries.length === 1) {
        const [, rawVal] = paramEntries[0]
        // Try parsing
        const parsed = parseValue(rawVal, 'R') // use 'R' as fallback kind
        if (parsed !== undefined) {
          valueStr = formatSpiceValue(parsed)
        } else {
          valueStr = rawVal
        }
      } else {
        // Multiple params: emit as-is (e.g. for PULSE or SIN sources)
        valueStr = sim.Params
      }
    }

    const card = `${elName} ${nodesStr} ${valueStr}`.trimEnd()

    return {
      ref: part.ref,
      status: 'ok',
      model: { kind: 'primitive', card },
      tier: 1,
      warnings,
    }
  }

  return null
}

// ─── Tier 2: Primitive inference (R/C/L) ────────────────────────────────────

/**
 * Attempt tier-2 resolution for R/C/L parts by refdes prefix + parseValue.
 */
function tryTier2(part: Part, circuit: Circuit): Resolution | null {
  const prefix = refdesPrefix(part.ref)

  if (!TIER2_PRIMITIVE_PREFIXES.has(prefix)) return null

  const kind = prefix as 'R' | 'C' | 'L'

  // Check for DNP / unparseable value
  const parsed = parseValue(part.value, kind)

  if (parsed === undefined) {
    // DNP or unparseable value
    const isDnp = /^(DNP|N\/A|NA|TBD|--+|none)$/i.test(part.value.trim())
    if (isDnp) {
      return {
        ref: part.ref,
        status: 'stubbed',
        model: { kind: 'stub', mode: 'open' },
        tier: 6,
        warnings: [`Part ${part.ref} has DNP/placeholder value "${part.value}" — stubbed open`],
      }
    }
    // Unparseable: return null → fall through to tier 3+
    return null
  }

  const warnings: string[] = []

  // Electrolytic polarity warning for C parts
  if (kind === 'C' && isElectrolytic(part)) {
    warnings.push(
      `C${part.ref.slice(1)} appears to be a polarized (electrolytic) capacitor — verify polarity in schematic`
    )
  }

  const deviceLetter = kind.toLowerCase()
  const elName = elementName(deviceLetter, part.ref)
  const nodes = buildNodeList(part, circuit)
  const nodesStr = nodes.join(' ')
  const valueStr = formatSpiceValue(parsed)

  const card = `${elName} ${nodesStr} ${valueStr}`

  return {
    ref: part.ref,
    status: 'ok',
    model: { kind: 'primitive', card },
    tier: 2,
    warnings,
  }
}

// ─── Tier 6: Stub (fallback) ──────────────────────────────────────────────────

function makeTier6(
  part: Part,
  mode: 'open' | 'short' | 'interactive-pins' = 'open',
  warnings: string[] = [],
): Resolution {
  return {
    ref: part.ref,
    status: 'stubbed',
    model: { kind: 'stub', mode },
    tier: 6,
    warnings,
  }
}

// ─── Tier 3: Bundled library match ───────────────────────────────────────────

/**
 * Attempt tier-3 resolution by matching the part against the bundled library.
 *
 * Matching order (see libraryMatch.ts):
 *   1. Normalized MPN (from part.properties['mpn'] or 'MPN')
 *   2. Value regex
 *   3. refdesPrefix + footprintRegex fallback
 *
 * Returns a Resolution or null if no match / ambiguous.
 * Ambiguous → unresolved with candidate list in warnings.
 */
function tryTier3(
  part: Part,
  library: LibraryEntry[],
): Resolution | null {
  // Build a PartDescriptor for the matcher
  // MPN can come from part.properties['mpn'] or 'MPN' (case variants)
  const mpn: string | undefined =
    part.properties['mpn'] ??
    part.properties['MPN'] ??
    part.properties['Mpn'] ??
    undefined

  const descriptor: PartDescriptor = {
    mpn,
    libId: part.libId,
    value: part.value,
    ref: part.ref,
  }

  const matchResult = matchLibraryEntry(descriptor, library)

  if (matchResult.kind === 'none') return null

  if (matchResult.kind === 'ambiguous') {
    return {
      ref: part.ref,
      status: 'unresolved',
      tier: 3,
      warnings: [
        `Ambiguous library match for ${part.ref} (${part.value}): multiple entries match — ${matchResult.candidates.join(', ')}; fix by setting MPN property`
      ],
    }
  }

  // Single match
  const entry = matchResult.entry
  const warnings: string[] = []

  // Select pin map
  const { pinMap, warnings: pinWarnings } = selectPinMap(entry, part.libId)
  warnings.push(...pinWarnings)

  // Build the resolved model
  let model: ResolvedModel

  if (entry.model.type === 'xspice-digital') {
    model = {
      kind: 'xspice-digital',
      templateId: entry.model.name,
      pinMap,
    }
  } else {
    // 'subckt' or 'model-card' both resolve as subckt-kind in ResolvedModel
    // (model-card is still a .model card in a file — treated as subckt reference
    // so the deck generator can .include the file and use the model)
    model = {
      kind: 'subckt',
      libFile: entry.model.file ?? '',
      subcktName: entry.model.name,
      pinMap,
    }
  }

  return {
    ref: part.ref,
    status: 'ok',
    model,
    tier: 3,
    warnings,
  }
}

// ─── Main resolveAll function ─────────────────────────────────────────────────

/**
 * Resolve all parts in a circuit through the tier cascade.
 *
 * @param circuit         Extracted circuit (from core/netlist/extract.ts)
 * @param schematicSimData  Optional: schematic Sim.* fields per ref
 * @param bom             Optional: BOM rows (seam for tier 3 enrichment — unused in v1 tiers 1/2)
 * @param library         Optional: bundled library entries (seam for tier 3 — unused in Task 12)
 * @param userOverrides   Optional: per-ref stub overrides from Model Doctor
 *
 * Returns one Resolution per Part, in the same order as circuit.parts.
 */
export function resolveAll(
  circuit: Circuit,
  schematicSimData?: SchematicSimData,
  bom?: BomData,
  library?: LibraryEntry[],
  userOverrides?: Map<string, UserStubOverride>,
): Resolution[] {
  const resolutions: Resolution[] = []

  for (const part of circuit.parts) {
    const res = resolvePart(part, circuit, schematicSimData, bom, library, userOverrides)
    resolutions.push(res)
  }

  return resolutions
}

// ─── Per-part resolution ──────────────────────────────────────────────────────

function resolvePart(
  part: Part,
  circuit: Circuit,
  schematicSimData: SchematicSimData | undefined,
  _bom: BomData | undefined,
  _library: LibraryEntry[] | undefined,
  userOverrides: Map<string, UserStubOverride> | undefined,
): Resolution {
  // ── User overrides always win (highest priority) ───────────────────────────
  if (userOverrides?.has(part.ref)) {
    const override = userOverrides.get(part.ref)!
    return makeTier6(part, override.mode)
  }

  // ── Tier 1: Schematic Sim.* fields ────────────────────────────────────────
  const simInfo = schematicSimData?.get(part.ref)
  const tier1 = tryTier1(part, circuit, simInfo)
  if (tier1) return tier1

  // ── Tier 2: R/C/L primitive inference ─────────────────────────────────────
  const tier2 = tryTier2(part, circuit)
  if (tier2) return tier2

  // ── Tier 3: Bundled library match ─────────────────────────────────────────
  if (_library && _library.length > 0) {
    const tier3 = tryTier3(part, _library)
    if (tier3) return tier3
  }

  // ── Tier 4: User .lib [seam] ──────────────────────────────────────────────
  // Not yet implemented (Task 15 seam: user bindings lookup will go here).

  // ── Tier 5: LLM-assist paste [seam] ──────────────────────────────────────
  // Not yet implemented.

  // ── Tier 6: Stub (fallback for everything unresolvable) ───────────────────
  return {
    ref: part.ref,
    status: 'unresolved',
    tier: 6,
    warnings: [`No model found for ${part.ref} (${part.value}, ${part.libId})`],
  }
}
