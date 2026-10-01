/**
 * core/models/resolve.ts
 *
 * Model resolution pipeline: Part → Resolution via tier cascade.
 *
 * Tier cascade (first hit wins):
 *   1 — Schematic Sim.* fields (R/C/L/V/I primitives + SUBCKT)
 *   2 — Built-in primitive inference (R/C/L from refdes prefix + parseValue)
 *   3 - Library match: the bundled library, and the user's own models, which
 *       the store injects ahead of the bundled entries as tier-3 entries
 *       (tier 4 .lib import and tier 5 LLM paste both bind a model that way,
 *       by MPN, so there is no separate resolver for them)
 *   6 - Stub: automatic supply-load or interactive-pins stubs for controllers
 *       and similar parts (stubRules.ts), the connector open stub, and the
 *       user's Model Doctor stub overrides (open/short/interactive-pins)
 *   Parts that reach the end unclaimed are `unresolved` (tier 6, no model).
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
import {
  matchLibraryEntry,
  selectPinMap,
  pinMapFromSchematicPins,
  SCHEMATIC_PINMAP_NOTE,
  POLARITY_UNVERIFIED_PREFIX,
  type SchematicPin,
} from './libraryMatch'
import type { PartDescriptor } from './libraryMatch'
import { classifyStubPart, resolveStubPart } from './stubRules'

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
 * Parse a KiCad Sim.Params string into a key=value map.
 *
 * KiCad writes lowercase keys and quotes values that are empty or hold spaces:
 *   r=10k   c=""   dc="5"   type="C" model="100n" lib=""   r='TIME > 350m ? 8 : 89'
 * Keys are lowercased (lookup is case-insensitive, so the older "R=10k" form
 * still works); a quoted value keeps its spaces and loses its quotes; a bare
 * token with no "=" is ignored. An empty value is kept as "" so callers can
 * tell "key present but empty" (KiCad's `c=""`, meaning "use the Value field")
 * from "key absent".
 */
function parseSimParams(params: string): Record<string, string> {
  const result: Record<string, string> = {}
  const n = params.length
  let i = 0
  while (i < n) {
    while (i < n && /\s/.test(params[i])) i++
    if (i >= n) break

    let j = i
    while (j < n && params[j] !== '=' && !/\s/.test(params[j])) j++
    if (j >= n || params[j] !== '=') {
      i = j // bare token
      continue
    }
    const key = params.slice(i, j).toLowerCase()
    i = j + 1

    let val = ''
    if (i < n && (params[i] === '"' || params[i] === "'")) {
      const quote = params[i]
      i++
      while (i < n && params[i] !== quote) {
        if (params[i] === '\\' && i + 1 < n) {
          val += params[i + 1]
          i += 2
          continue
        }
        val += params[i]
        i++
      }
      i++ // closing quote
    } else {
      while (i < n && !/\s/.test(params[i])) {
        val += params[i]
        i++
      }
    }
    if (key !== '') result[key] = val.trim()
  }
  return result
}

/** A Sim.Params value as a number, or undefined when empty, an expression, or not a plain value. */
function simNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return parseValue(raw, 'R')
}

/** First non-empty Sim.Params value among the given keys. */
function pickParam(params: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = params[k]
    if (v !== undefined && v !== '') return v
  }
  return undefined
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

const POSITIVE_TERMINALS = new Set(['+', 'p', 'pos', 'a'])
const NEGATIVE_TERMINALS = new Set(['-', 'n', 'neg', 'k', 'm'])

/**
 * Node list for a two-terminal primitive, honouring Sim.Pins ("1=+ 2=-",
 * "1=- 2=+"): the positive terminal is written first, as SPICE expects. Sim.Pins
 * that do not describe exactly this part's two pads with one positive and one
 * negative terminal are ignored (pad order), never trusted.
 */
function buildTwoTerminalNodes(part: Part, circuit: Circuit, simPins: string | undefined): string[] {
  const padOrder = buildNodeList(part, circuit)
  if (!simPins) return padOrder
  const pins = parseSimPins(simPins)
  const padNodeMap = buildPadNodeMap(part, circuit)
  const pads = [...padNodeMap.keys()]
  if (pads.length !== 2 || !pads.every(p => p in pins)) return padOrder
  const ranks = pads.map(p => {
    const name = pins[p].toLowerCase()
    return POSITIVE_TERMINALS.has(name) ? 0 : NEGATIVE_TERMINALS.has(name) ? 1 : -1
  })
  if (!(ranks.includes(0) && ranks.includes(1))) return padOrder
  const positivePad = pads[ranks.indexOf(0)]
  const negativePad = pads[ranks.indexOf(1)]
  return [padNodeMap.get(positivePad)!, padNodeMap.get(negativePad)!]
}

// ─── Element name builder ─────────────────────────────────────────────────────

/** Build the SPICE element name: "r_r1", "c_c1", "x_u1", etc. */
function elementName(deviceLetter: string, ref: string): string {
  return `${deviceLetter.toLowerCase()}_${ref.toLowerCase()}`
}

// ─── Tier 1: Schematic Sim.* resolution ──────────────────────────────────────

/**
 * Attempt tier-1 resolution from schematic Sim.* fields.
 *
 * Returns a Resolution, or null when the schematic data does not give a
 * COMPLETE, usable model for this part. null means "keep going down the tiers"
 * (Value field, MPN, bundled library); it is never an error. Sim.Device is
 * advisory unless the card it would produce is complete (issues #6, #7):
 *   - R/C/L need a value (Sim.Params, else the Value field);
 *   - V/I need a dc value;
 *   - D/Q/M/J need a model, which a bare Sim.Device cannot supply;
 *   - any Sim.Device outside the table (SPICE, NMOS, NPN, KIBIS, ...) is skipped.
 * Why a tier-1 attempt was skipped is appended to `notes` so a part that ends up
 * unresolved can say so.
 */
function tryTier1(
  part: Part,
  circuit: Circuit,
  simInfo: { sim: Partial<Record<'Device' | 'Type' | 'Params' | 'Pins' | 'Library' | 'Name', string>> } | undefined,
  notes: string[],
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
    // Device type tier 1 cannot use (SPICE, NMOS, NPN, KIBIS, PSPICE, ...). Do
    // not block the Value field and the library: the schematic author never
    // chose this device for circsim.
    notes.push(`Sim.Device="${sim.Device}" is not supported (out-of-scope device type)`)
    return null
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
    const params = sim.Params ? parseSimParams(sim.Params) : {}

    let valueStr: string | undefined
    let nodes: string[]

    if (device === 'R' || device === 'C' || device === 'L') {
      // KiCad writes `c=""` when the value lives in the Value field, and an
      // empty Sim.Params for plain passives: both mean "use the Value field".
      const keys = device === 'R' ? ['r', 'resistance', 'value']
        : device === 'C' ? ['c', 'capacitance', 'value']
          : ['l', 'inductance', 'value']
      const fromParams = simNumber(pickParam(params, keys))
      const parsed = fromParams ?? parseValue(part.value, device)
      if (parsed === undefined) {
        notes.push(
          `Sim.Device="${sim.Device}" gives no usable value (Sim.Params "${sim.Params ?? ''}", Value "${part.value}")`,
        )
        return null
      }
      valueStr = formatSpiceValue(parsed)
      nodes = buildTwoTerminalNodes(part, circuit, sim.Pins)
    } else if (device === 'V' || device === 'I') {
      // A source with no dc value is "DC 0 assumed" in ngspice: a voltage
      // source becomes a hard short. Never emit one.
      const parsed = simNumber(pickParam(params, ['dc', 'value', device.toLowerCase()]))
      if (parsed === undefined) {
        notes.push(
          `Sim.Device="${sim.Device}" has no value (Sim.Params "${sim.Params ?? ''}"); a source with no value is not modeled`,
        )
        return null
      }
      valueStr = formatSpiceValue(parsed)
      nodes = buildTwoTerminalNodes(part, circuit, sim.Pins)
    } else if (device === 'D' || device === 'Q' || device === 'M' || device === 'J') {
      // These cards need a .model name that a bare Sim.Device cannot supply
      // (KiCad's own Simulation_SPICE:D carries only rs/cjo). Fall through to
      // the Value field and the library.
      notes.push(
        `Sim.Device="${sim.Device}" has no model name, so no ${deviceLetter}_ card can be written from the schematic alone`,
      )
      return null
    } else {
      // Controlled sources (E/F/G/H/K): only with explicit params.
      const entries = Object.entries(params)
      if (entries.length === 0) {
        notes.push(`Sim.Device="${sim.Device}" has no Sim.Params`)
        return null
      }
      if (entries.length === 1) {
        const parsed = simNumber(entries[0][1])
        valueStr = parsed !== undefined ? formatSpiceValue(parsed) : entries[0][1]
      } else {
        valueStr = sim.Params
      }
      nodes = buildNodeList(part, circuit)
    }

    if (valueStr === undefined || valueStr.trim() === '' || valueStr.trim() === '""') {
      notes.push(`Sim.Device="${sim.Device}" produced an empty value`)
      return null
    }

    const card = `${elName} ${nodes.join(' ')} ${valueStr}`.trimEnd()

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

// ─── Connector auto-resolution ────────────────────────────────────────────────

/** Refdes prefixes that name connectors (J1, P2 …). */
const CONNECTOR_PREFIXES = new Set(['J', 'P'])

/**
 * Returns true if the part is clearly a connector: refdes prefix J or P AND a
 * connector-ish libId/footprint (Connector, JST, PinHeader, Conn — case-insensitive).
 */
function isConnector(part: Part): boolean {
  if (!CONNECTOR_PREFIXES.has(refdesPrefix(part.ref))) return false
  return /JST|PinHeader|Conn/i.test(part.libId ?? '')
}

/**
 * Resolve a connector as an explicit open-circuit stub with status 'ok'.
 * A bare-board connector is electrically open; power arrives via bench
 * instruments on nets, not connector models — so this is a real resolution,
 * not a fallback stub.
 */
function makeConnectorResolution(part: Part): Resolution {
  return {
    ref: part.ref,
    status: 'ok',
    model: { kind: 'stub', mode: 'open' },
    tier: 6,
    warnings: [
      `${part.ref} is a connector — modeled as open circuit (bench instruments drive its nets)`,
    ],
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

/** Key/value equality for pin maps (2-entry objects — order-insensitive). */
function pinMapsEqual(a: PinMap, b: PinMap): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k])
}

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
 *
 * `yieldFallbackToStub`: the part is a recognized controller, LED or bridge that
 * the stub rules handle. Its refdes + footprint fallback match (tier 'fallback',
 * matched or ambiguous) says nothing about the device, only about the package, so
 * it must not claim the part ahead of the stub rules: an ATtiny84 on SOIC-14 is
 * not an LM324. A named match (MPN or value) still wins.
 */
function tryTier3(
  part: Part,
  library: LibraryEntry[],
  schematicPins?: SchematicPin[],
  yieldFallbackToStub = false,
): Resolution | null {
  // Build a PartDescriptor for the matcher. The MPN is explicit when it comes
  // from a BOM row (merged into properties by applyBomRow) or a board
  // property; the key is matched case-insensitively.
  const mpnKey = Object.keys(part.properties).find(k => k.toLowerCase() === 'mpn')
  const mpnProp: string | undefined =
    mpnKey !== undefined && part.properties[mpnKey].trim() !== '' ? part.properties[mpnKey] : undefined

  // Value-as-MPN fallback: real boards often carry the MPN in the VALUE field
  // ("1N4148W", "MMBT3904", "AO3401") with no mpn property at all. When there
  // is no explicit MPN, pass the value as the MPN candidate and mark it as a
  // guess: matchLibraryEntry refuses it on a refdes that is never a library
  // device (issue #51), so "3V0" on a battery holder is never a zener.
  const mpnIsValue = mpnProp === undefined
  const mpn = mpnProp ?? (part.value.trim() !== '' ? part.value : undefined)

  const descriptor: PartDescriptor = {
    mpn,
    mpnIsValue,
    libId: part.libId,
    value: part.value,
    ref: part.ref,
  }

  const matchResult = matchLibraryEntry(descriptor, library)

  if (matchResult.kind === 'none') return null
  if (yieldFallbackToStub && matchResult.tier === 'fallback') return null

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

  // Documented open: known part, intentionally not modeled. Resolves to the
  // SAME open-stub shape deck-gen already handles for unresolved parts (no
  // elements emitted), but with a distinct status + the library's required
  // note so the UI can say WHY instead of showing red "unresolved".
  if (entry.model.type === 'documented-open') {
    return {
      ref: part.ref,
      status: 'documented-open',
      model: { kind: 'stub', mode: 'open' },
      note: entry.note,
      tier: 3,
      warnings: [],
    }
  }

  const warnings: string[] = []

  // A fallback-tier match knows only "an LED_ footprint on a D/LED part": say so,
  // so a stand-in model (the generic LED is red) is never mistaken for a
  // confirmed one.
  if (matchResult.tier === 'fallback') {
    warnings.push(
      `library-fallback: ${part.ref} matched "${entry.id}" from its refdes and footprint only ` +
      `(value "${part.value}" was not recognized); set the MPN or value if this is not the right model`,
    )
  }

  // Select pin map. Footprint-name regexes encode BELIEFS about pad-numbering
  // conventions; attached-schematic pin names (A/K) are the design files' own
  // statement of pad semantics and win when unambiguous (spec 2026-07-15).
  // The user's Model Doctor override still beats both — the store applies it
  // post-resolution.
  const regexResult = selectPinMap(entry, part.libId)
  const schematicMap = pinMapFromSchematicPins(
    entry,
    schematicPins,
    new Set(part.padNet.keys()),
  )

  let pinMap: PinMap
  if (schematicMap) {
    pinMap = schematicMap
    const regexConfident = regexResult.warnings.length === 0
    if (regexConfident && !pinMapsEqual(schematicMap, regexResult.pinMap)) {
      // A "D7": the regex matched confidently but had the polarity reversed.
      warnings.push(SCHEMATIC_PINMAP_NOTE)
    }
    // Regex fallback warnings (pinmap-unverified) intentionally dropped:
    // the schematic just verified the map.
  } else {
    pinMap = regexResult.pinMap
    warnings.push(...regexResult.warnings)
  }

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
 * @param bom             Optional: BOM rows. A row's MPN and value win over the board's
 *                        (the documented precedence): they replace the part's value and
 *                        MPN property before tiers 1 to 3 run. The BOM footprint is not
 *                        used; the placed footprint decides pin maps.
 * @param library         Optional: bundled library entries (tier 3)
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

  // BOM refs are matched case-insensitively ("r1" names R1).
  let bomByRef: BomData | undefined
  if (bom && bom.size > 0) {
    bomByRef = new Map()
    for (const [ref, row] of bom) bomByRef.set(ref.toUpperCase(), row)
  }

  for (const part of circuit.parts) {
    const res = resolvePart(
      part, circuit, schematicSimData, bomByRef?.get(part.ref.toUpperCase()), library, userOverrides,
    )
    resolutions.push(res)
  }

  return resolutions
}

// ─── BOM application ──────────────────────────────────────────────────────────

/**
 * The value a BOM row gives an R/C/L part, in a form tier 2 can read. A JLCPCB
 * "Comment" carries the rating after the value ("100nF 50V X7R",
 * "4.7kOhm +-1% 1/10W"): when the whole string does not parse but its leading
 * token does, that token is the value. Anything else is returned unchanged.
 */
function bomPrimitiveValue(ref: string, value: string): string {
  const prefix = refdesPrefix(ref)
  if (!TIER2_PRIMITIVE_PREFIXES.has(prefix)) return value
  const kind = prefix as 'R' | 'C' | 'L'
  if (parseValue(value, kind) !== undefined) return value
  const lead = value.split(/\s+/)[0]
  return lead !== value && parseValue(lead, kind) !== undefined ? lead : value
}

/**
 * The part as the BOM describes it: the row's value replaces the board value,
 * and the row's MPN replaces any board MPN property (whatever its case).
 */
function applyBomRow(part: Part, row: BomRow | undefined): Part {
  if (!row) return part
  const value = row.value?.trim()
  const mpn = row.mpn?.trim()
  if (!value && !mpn) return part

  let properties = part.properties
  if (mpn) {
    properties = {}
    for (const [k, v] of Object.entries(part.properties)) {
      if (k.toLowerCase() !== 'mpn') properties[k] = v
    }
    properties.mpn = mpn
  }
  return { ...part, value: value ? bomPrimitiveValue(part.ref, value) : part.value, properties }
}

/**
 * True when the value the BOM gives a part is the board's value: the same text,
 * or, for R/C/L, the same number in another notation ("4.7kOhm" and "4k7").
 * `bomValue` is the value as applied (bomPrimitiveValue), not the raw Comment.
 */
function sameValue(ref: string, bomValue: string, boardValue: string): boolean {
  if (bomValue.trim() === boardValue.trim()) return true
  const prefix = refdesPrefix(ref)
  if (!TIER2_PRIMITIVE_PREFIXES.has(prefix)) return false
  const kind = prefix as 'R' | 'C' | 'L'
  const a = parseValue(bomValue, kind)
  const b = parseValue(boardValue, kind)
  return a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b))
}

/** Machine prefix of a note saying what a BOM row did to a part (issue #4). */
export const BOM_NOTE_PREFIX = 'bom:'

/**
 * Tell the user what the BOM did to a part: a value that replaced the board's,
 * and an MPN that chose (or failed to choose) a library model. A BOM value that
 * names the board's own value (a JLCPCB Comment with its rating) changed
 * nothing and gets no note. The notes reach the user through the Model Doctor
 * card for a part that needs attention and through the sim log
 * (resolutionNoteLines) for every part.
 */
function noteBomEffect(
  part: Part,
  row: BomRow | undefined,
  res: Resolution,
  boardValueUsed: boolean,
): Resolution {
  if (!row) return res
  const extra: string[] = []
  const bomValue = row.value?.trim()
  if (bomValue && !sameValue(part.ref, bomPrimitiveValue(part.ref, bomValue), part.value)) {
    if (boardValueUsed) {
      // The BOM value found no model, the board's did: say which one decided.
      extra.push(
        `bom: value "${bomValue}" from the BOM found no model, so the board value "${part.value}" was used`,
      )
    } else if (res.model || res.status === 'unresolved') {
      // An unresolved part names the BOM too: its value may be why nothing matched.
      extra.push(`bom: value "${bomValue}" from the BOM replaces the board value "${part.value}"`)
    }
  }
  const bomMpn = row.mpn?.trim()
  if (bomMpn) {
    const mpnKey = Object.keys(part.properties).find(k => k.toLowerCase() === 'mpn')
    const boardMpn = mpnKey !== undefined ? part.properties[mpnKey].trim() : ''
    const disagrees = boardMpn !== '' && boardMpn !== bomMpn
    if (res.tier === 3 && (res.status === 'ok' || res.status === 'documented-open')) {
      extra.push(
        `bom: MPN "${bomMpn}" from the BOM selected this model` +
        (disagrees ? ` (the board's MPN property "${boardMpn}" was overridden)` : ''),
      )
    } else if (res.status === 'unresolved') {
      extra.push(`bom: MPN "${bomMpn}" from the BOM matched no library model`)
    }
  }
  return extra.length === 0 ? res : { ...res, warnings: [...res.warnings, ...extra] }
}

// ─── Resolution notes for the sim log ─────────────────────────────────────────

/**
 * Sim-log lines for the resolution notes that a status does not show. The Model
 * Doctor lists only parts whose status is not ok, so a part that resolved has no
 * card; the store logs these when a board or BOM is loaded.
 *
 * - `'bom'`: what a BOM row did to each part, resolved or not (issue #4), as
 *   `BOM: <ref>: <what changed>`.
 * - `'polarity'`: each diode or LED that resolved but whose polarity is a guess
 *   from a JLC/EasyEDA footprint name (issue #5), as `<ref>: <the warning>`.
 */
export function resolutionNoteLines(
  resolutions: readonly Resolution[],
  kind: 'bom' | 'polarity',
): string[] {
  const lines: string[] = []
  for (const r of resolutions) {
    for (const w of r.warnings) {
      if (kind === 'bom' && w.startsWith(BOM_NOTE_PREFIX)) {
        lines.push(`BOM: ${r.ref}: ${w.slice(BOM_NOTE_PREFIX.length).trim()}`)
      } else if (kind === 'polarity' && r.status === 'ok' && w.startsWith(POLARITY_UNVERIFIED_PREFIX)) {
        lines.push(`${r.ref}: ${w}`)
      }
    }
  }
  return lines
}

// ─── Per-part resolution ──────────────────────────────────────────────────────

function resolvePart(
  part: Part,
  circuit: Circuit,
  schematicSimData: SchematicSimData | undefined,
  bomRow: BomRow | undefined,
  library: LibraryEntry[] | undefined,
  userOverrides: Map<string, UserStubOverride> | undefined,
): Resolution {
  // ── User overrides always win (highest priority) ───────────────────────────
  if (userOverrides?.has(part.ref)) {
    const override = userOverrides.get(part.ref)!
    return makeTier6(part, override.mode)
  }

  const applied = applyBomRow(part, bomRow)
  let res = resolveFromTiers(applied, circuit, schematicSimData, library)

  // The BOM wins, but a BOM value the resolver cannot use (a free-text Comment)
  // must not cost a part the model its board value already earned: retry with the
  // board value, keeping the BOM's MPN, and say so.
  let boardValueUsed = false
  if (res.status === 'unresolved' && applied.value !== part.value) {
    const retry = resolveFromTiers({ ...applied, value: part.value }, circuit, schematicSimData, library)
    if (retry.status !== 'unresolved') {
      res = retry
      boardValueUsed = true
    }
  }
  return noteBomEffect(part, bomRow, res, boardValueUsed)
}

function resolveFromTiers(
  part: Part,
  circuit: Circuit,
  schematicSimData: SchematicSimData | undefined,
  library: LibraryEntry[] | undefined,
): Resolution {
  // ── Tier 1: Schematic Sim.* fields ────────────────────────────────────────
  // Why a part's Sim.* fields were not usable is kept so an unresolved part can say so.
  const tier1Notes: string[] = []
  const simInfo = schematicSimData?.get(part.ref)
  const tier1 = tryTier1(part, circuit, simInfo, tier1Notes)
  if (tier1) return tier1

  // ── Tier 2: R/C/L primitive inference ─────────────────────────────────────
  const tier2 = tryTier2(part, circuit)
  if (tier2) return tier2

  // ── Connector auto-resolution (J/P + connector-ish libId → open stub) ─────
  if (isConnector(part)) {
    return makeConnectorResolution(part)
  }

  // ── Tier 3: Bundled library match ─────────────────────────────────────────
  if (library && library.length > 0) {
    const stubClass = classifyStubPart(part)
    const tier3 = tryTier3(
      part,
      library,
      schematicSimData?.get(part.ref)?.pins,
      stubClass !== null && stubClass.kind !== 'crystal',
    )
    if (tier3) {
      return tier3.status === 'unresolved' && tier1Notes.length > 0
        ? { ...tier3, warnings: [...tier1Notes, ...tier3.warnings] }
        : tier3
    }
  }

  // ── Tiers 4 and 5: user .lib import and LLM paste ─────────────────────────
  // Both bind a model to an MPN, and the store feeds those bindings in as
  // library entries ahead of the bundled ones, so they are resolved in tier 3.

  // ── Tier 6: automatic stubs ───────────────────────────────────────────────
  // A controller, addressable LED or USB-serial bridge with no model becomes a
  // supply-load stub (or interactive pins), never an unexplained red part.
  const stub = resolveStubPart(part, circuit, library, simInfo?.pins)
  if (stub) return stub

  // ── Nothing claimed the part ──────────────────────────────────────────────
  return {
    ref: part.ref,
    status: 'unresolved',
    tier: 6,
    warnings: [...tier1Notes, `No model found for ${part.ref} (${part.value}, ${part.libId})`],
  }
}

// ─── ngspice log lines → per-part status ──────────────────────────────────────

/** A part ngspice refused or silently dropped, found in its log output. */
export interface DeckDiagnostic {
  ref: string
  message: string
}

/** SimHost prefixes ngspice output with its stream name ("stderr d_d1 a 0"). */
function cleanNgspiceLine(text: string): string {
  return text.replace(/^\s*(?:stderr|stdout)\s+/i, '').trim()
}

/** "c_c17" / "v_bt1" -> the ref it was written for ("C17" / "BT1"). */
function refForElement(element: string, refs: readonly string[]): string | undefined {
  const lower = element.toLowerCase()
  const stripped = /^[a-z]_(.+)$/.exec(lower)?.[1]
  for (const candidate of stripped !== undefined ? [stripped, lower] : [lower]) {
    const hit = refs.find(r => r.toLowerCase() === candidate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Turn one ngspice log line into a per-part diagnostic, or null.
 *
 * Recognized (ngspice 46):
 *   Warning: 'c_c1 a 0' is not a valid capacitor instance line, ignored!   (level warn: the part is silently gone)
 *   Note: v_bt1: has no value, DC 0 assumed                               (a source that is really a short)
 *   <card line> then "could not find a valid modelname"                   (the whole deck fails to parse)
 *
 * The modelname message does not name the element; ngspice prints the card on
 * the line before it, so the caller passes the previous log line. `refs` are the
 * board's part refs; an element that is not one of them gives null.
 */
export function ngspiceLogDiagnostic(
  line: string,
  prevLine: string | undefined,
  refs: readonly string[],
): DeckDiagnostic | null {
  const text = cleanNgspiceLine(line)

  const ignored = /^Warning:\s*'([^'\s]+)[^']*'\s+is not a valid (.+?) instance line, ignored/i.exec(text)
  if (ignored) {
    const ref = refForElement(ignored[1], refs)
    return ref === undefined ? null : {
      ref,
      message: `ngspice ignored this part (not a valid ${ignored[2]} instance line), so it is missing from the simulation`,
    }
  }

  const noValue = /^Note:\s*(\S+?):\s*has no value, DC 0 assumed/i.exec(text)
  if (noValue) {
    const ref = refForElement(noValue[1], refs)
    return ref === undefined ? null : {
      ref,
      message: 'ngspice found no value on this source and assumed DC 0 (a short for a voltage source)',
    }
  }

  if (/^could not find a valid modelname/i.test(text) && prevLine !== undefined) {
    const element = cleanNgspiceLine(prevLine).split(/\s+/)[0]
    const ref = element ? refForElement(element, refs) : undefined
    return ref === undefined ? null : {
      ref,
      message: 'ngspice could not find a valid modelname for this part, so it rejected the deck (could not find a valid modelname)',
    }
  }

  return null
}

/**
 * Apply ngspice's per-part complaints to the resolutions. A part that was
 * status ok but that ngspice refused or dropped is demoted to unresolved, loses
 * its model (so the next deck leaves it open instead of repeating the bad card),
 * and carries ngspice's message. Other parts keep their resolution object.
 * Returns the same array when nothing changes.
 */
export function applyDeckDiagnostics(
  resolutions: Resolution[],
  diagnostics: readonly DeckDiagnostic[],
): Resolution[] {
  if (diagnostics.length === 0) return resolutions
  const byRef = new Map<string, string[]>()
  for (const d of diagnostics) byRef.set(d.ref, [...(byRef.get(d.ref) ?? []), d.message])

  let changed = false
  const out = resolutions.map(r => {
    const messages = byRef.get(r.ref)
    if (!messages || r.status !== 'ok') return r
    changed = true
    const warnings = [...r.warnings]
    for (const m of messages) if (!warnings.includes(m)) warnings.push(m)
    const demoted: Resolution = { ...r, status: 'unresolved', warnings }
    delete demoted.model
    delete demoted.note
    return demoted
  })
  return changed ? out : resolutions
}
