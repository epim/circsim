/**
 * core/spicegen/generate.ts
 *
 * SPICE deck generator: pure function that converts a resolved circuit +
 * instruments into a SPICE deck (array of strings, one card per line).
 *
 * Spec §8.8 rules enforced here:
 *   - Element names lowercase (r_r1, x_u2 …)
 *   - All numeric values plain decimal/exponent, NEVER letter suffixes
 *   - Series-R splice on the SOURCE side (synthetic _int node) so the KiCad
 *     net keeps its name and the overlay reads the correct voltage
 *   - .save all for node voltages + targeted .save @dev[i] per active current probe
 *   - NO blanket .options savecurrents
 *   - Every deck ends .end
 *   - Provenance comments (tier per part) make saved decks self-describing
 *
 * alterPlan() maps an instrument-parameter change to either:
 *   { kind: 'alter', commands } — live, no reload needed
 *   { kind: 'reload' }          — deck must be regenerated
 *
 * No imports from electron, react, or three. Pure TS, Vitest-safe.
 */

import type { Circuit, CircuitNet } from '../netlist/extract'
import type { Resolution } from '../models/types'
import type { Instrument, AlterPlanResult } from './instruments'
import { clampPotOhms, potResistorNames } from './instruments'

// ─── Public API types ─────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Circuit (from core/netlist/extract) */
  circuit: Circuit
  /** Resolutions for every part (from core/models/resolve) */
  resolutions: Resolution[]
  /** Instruments attached by the user */
  instruments: Instrument[]
  /** Which net id maps to ground (SPICE node "0") */
  groundNetId: number
  /** Optional analysis defaults (unused in deck — SimHost issues the analysis command) */
  analysisDefaults?: {
    tstepSeconds?: number
    tstopSeconds?: number
  }
  /** Title for the deck's first comment line (e.g. circuit/board name) */
  title?: string
  /**
   * OPTIONAL model-library texts: filename → file contents for every referenced
   * .lib / .json model file (from the bundled library + user models).
   *
   * When provided, generateDeck inlines the matching `.subckt … .ends` block or
   * `.model …` card for every subckt / model-card part (deduplicated), and
   * expands xspice-digital templates from the matching logic74hc.json — ngspice
   * loads decks from memory, so definitions are inlined, NEVER `.include`d by
   * path. When OMITTED the generator emits primitives + subckt instantiations
   * only (the existing golden-deck behaviour is unchanged).
   *
   * The lookup key is the resolution's `model.libFile` (subckt/model-card) or
   * the digital template's source file (logic74hc.json).
   */
  modelTexts?: Record<string, string>
}

// ─── Model-definition parsing (inline from .lib texts) ───────────────────────

/**
 * Join SPICE continuation lines: any line whose first non-blank char is '+' is a
 * continuation of the previous logical line. Returns logical lines (no '+'),
 * carrying the original text spliced with a single space. Comments ('*') and
 * blanks are preserved as their own logical lines (a '+' never continues a
 * comment in our libs). CRLF is normalised away by the split caller.
 */
function joinContinuations(rawLines: string[]): string[] {
  const out: string[] = []
  for (const raw of rawLines) {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trimStart()
    if (trimmed.startsWith('+') && out.length > 0) {
      // Append the continuation (minus the leading '+') to the previous line.
      out[out.length - 1] = out[out.length - 1] + ' ' + trimmed.slice(1).trim()
    } else {
      out.push(line)
    }
  }
  return out
}

/**
 * A parsed .subckt definition: its declared terminal order plus the full text
 * (the `.subckt … .ends` block, continuations joined into single lines).
 */
interface SubcktDef {
  name: string
  /** Terminal node names in declared order (lowercased). */
  terminals: string[]
  /** The full definition text (one entry per logical line). */
  lines: string[]
}

/**
 * Index every `.subckt NAME t1 t2 … .ends` block in a lib text, keyed by the
 * lowercased subckt name. Subckt names can collide across files but we index per
 * file text; the caller picks the file via the resolution's libFile.
 */
function parseSubckts(text: string): Map<string, SubcktDef> {
  const map = new Map<string, SubcktDef>()
  const lines = joinContinuations(text.split('\n'))
  let current: SubcktDef | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    const startMatch = /^\.subckt\s+(\S+)\s*(.*)$/i.exec(trimmed)
    if (startMatch && !current) {
      const name = startMatch[1]
      // Terminals are the whitespace-separated tokens after the name, excluding
      // any `PARAMS:`/`params:` tail (none in our libs, but be defensive).
      const rest = startMatch[2]
      const paramIdx = rest.search(/\bparams:/i)
      const termPart = paramIdx >= 0 ? rest.slice(0, paramIdx) : rest
      const terminals = termPart.trim().length > 0 ? termPart.trim().split(/\s+/).map(t => t.toLowerCase()) : []
      current = { name: name.toLowerCase(), terminals, lines: [line] }
      continue
    }
    if (current) {
      current.lines.push(line)
      if (/^\.ends\b/i.test(trimmed)) {
        map.set(current.name, current)
        current = null
      }
    }
  }
  return map
}

/**
 * Index every `.model NAME …` card in a lib text, keyed by the lowercased model
 * name. Continuations are joined so a multi-line .model card is a single string.
 */
function parseModelCards(text: string): Map<string, string> {
  const map = new Map<string, string>()
  const lines = joinContinuations(text.split('\n'))
  for (const line of lines) {
    const m = /^\s*\.model\s+(\S+)\b/i.exec(line)
    if (m) map.set(m[1].toLowerCase(), line.trimEnd())
  }
  return map
}

/** Lazily-parsed per-file caches so repeated lookups don't re-scan the text. */
interface ModelTextIndex {
  subcktsByFile: Map<string, Map<string, SubcktDef>>
  modelsByFile: Map<string, Map<string, string>>
  texts: Record<string, string>
}

function makeModelTextIndex(texts: Record<string, string> | undefined): ModelTextIndex {
  return {
    subcktsByFile: new Map(),
    modelsByFile: new Map(),
    texts: texts ?? {},
  }
}

function getSubcktDef(idx: ModelTextIndex, file: string, name: string): SubcktDef | undefined {
  if (!idx.subcktsByFile.has(file)) {
    const text = idx.texts[file]
    idx.subcktsByFile.set(file, text ? parseSubckts(text) : new Map())
  }
  return idx.subcktsByFile.get(file)!.get(name.toLowerCase())
}

function getModelCard(idx: ModelTextIndex, file: string, name: string): string | undefined {
  if (!idx.modelsByFile.has(file)) {
    const text = idx.texts[file]
    idx.modelsByFile.set(file, text ? parseModelCards(text) : new Map())
  }
  return idx.modelsByFile.get(file)!.get(name.toLowerCase())
}

// ─── Numeric emission ─────────────────────────────────────────────────────────

/**
 * Format a number as a plain decimal/exponent string.
 * NEVER emits letter suffixes (k, u, n, p, m, M …).
 *
 * Thresholds:
 *   abs < 0.001  → exponential  (e.g. 4.7e-6)
 *   abs >= 1e9   → exponential  (e.g. 1e10)
 *   otherwise    → plain decimal  (e.g. 10000, 0.1)
 *
 * Tests assert: 4.7e-6 → "4.7e-06", 10000 → "10000", 0.22 → "0.22"
 */
export function formatSpiceValue(v: number): string {
  if (v === 0) return '0'

  const abs = Math.abs(v)

  if (abs < 0.001 || abs >= 1e9) {
    // Use exponential form. JS toPrecision / toExponential may vary, so we
    // use toExponential and normalise the exponent sign.
    let exp = v.toExponential()
    // Normalise: JS gives "4.7e-6", but SPICE/tests expect "4.7e-06"
    // (two-digit exponent with sign)
    exp = exp.replace(/e([+-])(\d)$/, 'e$1' + '0$2')
    return exp
  }

  // Plain decimal range — let JS toString() handle it; it won't produce
  // scientific notation for values in [0.001, 1e9).
  const s = v.toString()
  // Guard: if JS produced scientific notation anyway (should not happen),
  // fall back to toExponential form.
  if (s.includes('e')) {
    return formatSpiceValue(v)   // tail-call; only if above thresholds are right
  }
  return s
}

// ─── Element name ─────────────────────────────────────────────────────────────

// (Element name prefix is inferred inline per-resolution; no standalone helper needed.)

// ─── Node lookup ──────────────────────────────────────────────────────────────

/** Build a map from netId → spiceNode for the circuit. */
function buildNetIdToNode(circuit: Circuit): Map<number, string> {
  const m = new Map<number, string>()
  for (const net of circuit.nets) {
    m.set(net.id, net.spiceNode)
  }
  return m
}

/** Find a CircuitNet by netId. */
function netById(circuit: Circuit, netId: number): CircuitNet | undefined {
  return circuit.nets.find(n => n.id === netId)
}

// ─── Instrument SPICE name builders ──────────────────────────────────────────

/**
 * Stable SPICE element name for an instrument.
 * dc-supply#1  → vpsu_1
 * function-gen#2 → vfgen_2
 * logic-input#3  → vlogic_3
 * (The suffix after _ is the id field, lowercased.)
 */
export function instrumentSpiceName(inst: Extract<Instrument, { id: string }>): string {
  const suffix = inst.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  switch (inst.kind) {
    case 'dc-supply':     return `vpsu_${suffix}`
    case 'function-gen':  return `vfgen_${suffix}`
    case 'logic-input':   return `vlogic_${suffix}`
    default:              return `v_${suffix}`
  }
}

/** Synthetic intermediate node name (source-side splice). */
function intNode(baseName: string): string {
  return `${baseName}_int`
}

// ─── Refdes / device-letter helpers (model-card path) ─────────────────────────

/** Refdes prefix (leading letters): "D1" → "D", "Q12" → "Q", "U3" → "U". */
function refdesPrefix(ref: string): string {
  const m = ref.match(/^([A-Za-z]+)/)
  return m ? m[1].toUpperCase() : ''
}

/**
 * Refdes prefix → SPICE device letter for model-card parts (a .model reference
 * is a top-level primitive device, e.g. an LED is a diode `d_d1 a k LED_RED`).
 * Covers the prefixes the bundled model-card library actually targets: diodes
 * (D), BJTs (Q), MOSFETs (Q/M/T). Falls back to 'x' (handled by the caller).
 */
const PRIMITIVE_PREFIX_TO_LETTER: Record<string, string> = {
  D: 'd',
  Z: 'd',
  ZD: 'd',
  LED: 'd',
  Q: 'q',
  M: 'm',
  T: 'm',
}

// ─── LED classification + device-current naming ──────────────────────────────

/**
 * Classify a part as an LED for operating-point glow.
 *
 * An LED is a diode-family part (refdes prefix `D`) whose value, libId, or
 * resolved model name mentions "LED". A plain rectifier diode (e.g. 1N4148 in
 * `Diode_SMD:D_SOD-123`) is rejected because nothing names it an LED. Resistors
 * and other prefixes are rejected outright.
 *
 * Pure + side-effect free so the store/viewport can reuse the same predicate.
 */
export function isLedPart(args: {
  ref: string
  value?: string
  libId?: string
  /** Resolved model/subckt/model-card name, when known (e.g. "LED_RED"). */
  subcktName?: string
}): boolean {
  if (refdesPrefix(args.ref) !== 'D') return false
  const hay = `${args.value ?? ''} ${args.libId ?? ''} ${args.subcktName ?? ''}`.toUpperCase()
  return hay.includes('LED')
}

/**
 * The SPICE diode device name for an LED in the OP deck.
 *
 * LED model-card parts are emitted as a top-level diode primitive `d_<ref>`
 * (see the model-card path below). Returns the bare device name (`d_<ref>`).
 *
 * NOTE: on ngspice 46 a diode's `@d_<ref>[i]` vector carries NO data, so the glow
 * data source is NOT this device current — it is the 0 V series ammeter
 * `vsense_<ref>` spliced on the LED's anode (see ledSenseName). This helper is
 * retained for emitting the diode element name itself.
 */
export function ledSpiceName(ref: string): string {
  return `d_${ref.toLowerCase()}`
}

/**
 * The SPICE name of the 0 V series ammeter ("sense" source) spliced in series
 * with an LED's anode. A 0 V source is an ideal ammeter with no circuit effect;
 * its branch current reads back via the WORKING source-branch path in OP
 * (`i(vsense_<ref>)` / `vsense_<ref>#branch`) AND streams in transient — the
 * uniform, robust glow data source. Shared by the deck generator AND the store
 * (mapOpResultToCurrents) so the names can never drift.
 */
export function ledSenseName(ref: string): string {
  return `vsense_${ref.toLowerCase()}`
}

/**
 * Build a ref → LED-ammeter SPICE-name map for every LED part in the circuit.
 *
 * The store reverses this map to translate an op result's ammeter branch-current
 * vector (`i(vsense_<ref>)` / `vsense_<ref>#branch`) back to the part ref. Only
 * LED parts are included.
 */
export function buildLedSpiceNames(
  resolutions: Resolution[],
  circuit: Circuit,
): Map<string, string> {
  const out = new Map<string, string>()
  const partByRef = new Map(circuit.parts.map(p => [p.ref, p]))
  for (const res of resolutions) {
    const part = partByRef.get(res.ref)
    const subcktName =
      res.model && (res.model.kind === 'subckt') ? res.model.subcktName : undefined
    if (
      isLedPart({
        ref: res.ref,
        value: part?.value,
        libId: part?.libId,
        subcktName,
      })
    ) {
      out.set(res.ref, ledSenseName(res.ref))
    }
  }
  return out
}

// ─── Wave source card builders ────────────────────────────────────────────────

/**
 * Build the SPICE source value string for a function-gen instrument.
 *
 * Sine:     SIN(<offset> <amplitude> <freq>)
 * Square:   PULSE(0 <vhigh> 0 1n 1n <width> <period>)
 * Triangle: not a native SPICE source — use SIN as approximation (warn)
 * Pulse:    PULSE(<lo> <hi> 0 <rise> <fall> <width> <period>)
 */
function buildWaveSourceValue(inst: Extract<Instrument, { kind: 'function-gen' }>): string {
  const { wave, freqHz, amplitudeV, offsetV, dutyPct } = inst
  const period = formatSpiceValue(1 / freqHz)
  const amp    = formatSpiceValue(amplitudeV)
  const off    = formatSpiceValue(offsetV)
  const freq   = formatSpiceValue(freqHz)
  const hi     = formatSpiceValue(offsetV + amplitudeV)
  const lo     = formatSpiceValue(offsetV - amplitudeV)

  switch (wave) {
    case 'sine':
    case 'triangle':
      // Triangle uses SIN as an approximation (first harmonic)
      return `SIN(${off} ${amp} ${freq})`

    case 'square': {
      // PULSE: lo hi delay rise fall width period
      // duty = 0.5 by default
      const duty = (dutyPct ?? 50) / 100
      const width  = formatSpiceValue(duty / freqHz)
      return `PULSE(${lo} ${hi} 0 1e-09 1e-09 ${width} ${period})`
    }

    case 'pulse': {
      // PULSE with user-defined duty cycle
      const duty = (dutyPct ?? 50) / 100
      const width = formatSpiceValue(duty / freqHz)
      return `PULSE(${lo} ${hi} 0 1e-09 1e-09 ${width} ${period})`
    }
  }
}

// ─── Current-probe helpers ─────────────────────────────────────────────────────

/** Returns true if the resolution is a top-level primitive (R/C/L/D/Q…). */
function isPrimitive(res: Resolution): boolean {
  return res.model?.kind === 'primitive'
}

/** Returns true if the resolution is a subckt (needs ammeter splice). */
function isSubckt(res: Resolution): boolean {
  return res.model?.kind === 'subckt' || res.model?.kind === 'xspice-digital'
}

// ─── XSPICE digital template expansion ───────────────────────────────────────

/** Shape of a logic74hc.json template (only the fields the expander reads). */
interface Logic74Gate {
  prim: string
  in?: string[]
  out?: string
  data?: string
  clk?: string
  set?: string
  reset?: string
  q?: string
  qbar?: string
}
interface Logic74Template {
  schmitt?: boolean
  gates: Logic74Gate[]
  inputs: string[]
  outputs: string[]
  power: { vcc: string; gnd: string }
  delaysNs: number
}
interface Logic74File {
  family: {
    vHighDefault: number
    adc: { inLowFrac: number; inHighFrac: number }
    schmittAdc: { inLowFrac: number; inHighFrac: number }
  }
  templates: Record<string, Logic74Template>
}

/** Per-file cache of parsed logic74hc JSON so we parse each text once. */
const logic74Cache = new WeakMap<Record<string, string>, Map<string, Logic74File | null>>()

function parseLogic74(idx: ModelTextIndex, file: string): Logic74File | null {
  let cache = logic74Cache.get(idx.texts)
  if (!cache) {
    cache = new Map()
    logic74Cache.set(idx.texts, cache)
  }
  if (cache.has(file)) return cache.get(file)!
  const text = idx.texts[file]
  let parsed: Logic74File | null = null
  if (text) {
    try {
      parsed = JSON.parse(text) as Logic74File
    } catch {
      parsed = null
    }
  }
  cache.set(file, parsed)
  return parsed
}

/**
 * Expand an xspice-digital resolution into deck lines (Spec §8.8 pattern:
 * adc_bridge → ngspice digital primitive(s) → dac_bridge).
 *
 * The expansion mirrors the VERIFIED-against-ngspice-46 expander exercised by
 * src/simhost/__tests__/library-ic.integration.test.ts (d_inverter/d_buffer/
 * d_and/d_nand/d_or/d_nor/d_xor/d_xnor/d_dff — NOT d_inv/d_buf). Each chip
 * signal (1A, 1Y, …) becomes a per-instance analog node; the chip's package
 * pads are wired to those analog nodes via the pinMap so the surrounding deck
 * connects to the real board nets. adc/dac rails come from the family vHigh.
 *
 * When the template file text is not available (modelTexts omitted, e.g. the
 * existing golden tests), we fall back to the comment-only placeholder so those
 * primitives-only decks stay byte-for-byte unchanged.
 *
 * @param ref         part ref (e.g. 'U1')
 * @param model       xspice-digital resolved model (templateId + pinMap)
 * @param part        the circuit part (pad → netId)
 * @param netIdToNode netId → spiceNode
 * @param idx         parsed model-text index
 * @param templateFile the logic74hc.json filename (from the library entry)
 */
function expandXspiceDigital(
  ref: string,
  model: { kind: 'xspice-digital'; templateId: string; pinMap: Record<string, string> },
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  idx: ModelTextIndex,
  templateFile: string | undefined,
): string[] {
  const logic = templateFile ? parseLogic74(idx, templateFile) : null
  const tpl = logic?.templates?.[model.templateId]
  if (!logic || !tpl) {
    // No template text available — keep the historic placeholder (golden tests).
    return [
      `* xspice-digital template: ${ref} (${model.templateId})`,
      `* adc_bridge/gates/dac_bridge expansion — template text unavailable`,
    ]
  }

  const vHigh = logic.family.vHighDefault
  const refLc = ref.toLowerCase()

  // Map each chip SIGNAL name (e.g. "1A", "VCC") → the analog node it lives on.
  //  - signals wired to a package pad → that pad's board net spiceNode
  //  - unconnected signals → a per-instance internal node (won't disturb the board)
  // pinMap is pad → signal (uppercase signal names, per index.json).
  const signalToNode = new Map<string, string>()
  for (const [pad, sig] of Object.entries(model.pinMap)) {
    const netId = part.padNet.get(pad)
    if (netId === undefined) continue
    const node = netIdToNode.get(netId)
    if (node !== undefined) signalToNode.set(sig.toUpperCase(), node)
  }
  /** Analog node for a chip signal (internal per-instance node when unconnected). */
  const aNode = (sig: string): string =>
    signalToNode.get(sig.toUpperCase()) ?? `${refLc}_${sig.toLowerCase()}`
  /** Digital (event) node for a chip signal — always per-instance. */
  const dNode = (sig: string): string => `${refLc}_d_${sig.toLowerCase()}`

  const lines: string[] = []
  lines.push(`* xspice-digital ${ref} (${model.templateId})`)

  const adc = tpl.schmitt ? logic.family.schmittAdc : logic.family.adc
  const inLow = (adc.inLowFrac * vHigh).toFixed(4)
  const inHigh = (adc.inHighFrac * vHigh).toFixed(4)
  const rd = `${tpl.delaysNs}n`

  // Per-instance adc/dac model cards (names are ref-scoped to avoid collisions
  // when several digital chips share a deck).
  const adcModel = `adcm_${refLc}`
  const dacModel = `dacm_${refLc}`
  lines.push(`.model ${adcModel} adc_bridge(in_low=${inLow} in_high=${inHigh})`)
  lines.push(`.model ${dacModel} dac_bridge(out_low=0 out_high=${vHigh.toFixed(4)})`)

  // One adc_bridge per input signal: analog board node → digital event node.
  for (const sig of tpl.inputs) {
    lines.push(`abr_${refLc}_${sig.toLowerCase()} [${aNode(sig)}] [${dNode(sig)}] ${adcModel}`)
  }

  // Gates on digital event nodes.
  let gi = 0
  for (const g of tpl.gates) {
    gi++
    const inst = `a_${refLc}_${gi}`
    if (g.prim === 'd_dff') {
      // d_dff terminals: data clk set reset | q qbar. set/reset that are not real
      // chip inputs get tied off to a per-instance (floating-high) node.
      const set = g.set && tpl.inputs.includes(g.set) ? dNode(g.set) : `${inst}_nset`
      const reset = g.reset && tpl.inputs.includes(g.reset) ? dNode(g.reset) : `${inst}_nrst`
      lines.push(
        `.model ${inst}_m d_dff(clk_delay=${rd} set_delay=${rd} reset_delay=${rd} ` +
          `rise_delay=${rd} fall_delay=${rd})`,
      )
      lines.push(
        `${inst} ${dNode(g.data as string)} ${dNode(g.clk as string)} ${set} ${reset} ` +
          `${dNode(g.q as string)} ${dNode(g.qbar as string)} ${inst}_m`,
      )
    } else if (g.in && g.in.length === 1) {
      // unary (inverter / buffer)
      lines.push(`.model ${inst}_m ${g.prim}(rise_delay=${rd} fall_delay=${rd})`)
      lines.push(`${inst} ${dNode(g.in[0])} ${dNode(g.out as string)} ${inst}_m`)
    } else {
      // multi-input gate: bracket vector input form
      const ins = (g.in ?? []).map(dNode).join(' ')
      lines.push(`.model ${inst}_m ${g.prim}(rise_delay=${rd} fall_delay=${rd})`)
      lines.push(`${inst} [${ins}] ${dNode(g.out as string)} ${inst}_m`)
    }
  }

  // One dac_bridge per output signal: digital event node → analog board node.
  for (const sig of tpl.outputs) {
    lines.push(`abr_${refLc}_out_${sig.toLowerCase()} [${dNode(sig)}] [${aNode(sig)}] ${dacModel}`)
  }

  return lines
}

// ─── Main deck generator ──────────────────────────────────────────────────────

/**
 * Generate a SPICE deck from a resolved circuit + instruments.
 *
 * Returns an array of strings (one per line). The first element is the title
 * comment (SPICE requires the first line to be a comment/title).
 * The last element is always ".end".
 *
 * No .tran/.op card is included — the SimHost issues the analysis command.
 */
export function generateDeck(opts: GenerateOptions): string[] {
  const { circuit, resolutions, instruments, title, modelTexts } = opts
  // groundNetId is used by the caller to build the circuit (node "0" assignment);
  // the deck generator relies on circuit.nets[].spiceNode already being "0" for ground.
  // (opts.groundNetId is intentionally unused here — circuit.nets already have spiceNode="0")

  const lines: string[] = []
  const netIdToNode = buildNetIdToNode(circuit)

  // Model-definition inlining (only when lib texts are supplied). Definitions are
  // collected per-deck and deduplicated, then appended once before .save (ngspice
  // loads decks from memory, so we inline — never .include by path). `defKeys`
  // tracks which definitions are already queued so a part type used by several
  // refs contributes its .subckt/.model exactly once.
  const modelIndex = makeModelTextIndex(modelTexts)
  const haveModelTexts = !!modelTexts && Object.keys(modelTexts).length > 0
  const modelDefLines: string[] = []
  const emittedDefKeys = new Set<string>()
  /** Queue a definition block once, keyed by file:name. */
  const queueDef = (key: string, defLines: string[]): void => {
    if (emittedDefKeys.has(key)) return
    emittedDefKeys.add(key)
    modelDefLines.push(...defLines)
  }

  // ── Line 0: title (SPICE requires first line to be a title comment) ────────
  lines.push(`* circsim deck${title ? ` — ${title}` : ''}`)

  // ── Provenance comment: tier per part ─────────────────────────────────────
  {
    const tierComments: string[] = []
    for (const res of resolutions) {
      const tierLabel = tierLabelFor(res)
      tierComments.push(`${res.ref}: ${tierLabel}`)
    }
    if (tierComments.length > 0) {
      lines.push(`* ${tierComments.join(' | ')}`)
    }
  }

  // ── Gather current probes — determine which need ammeter splice ────────────
  const currentProbes = instruments.filter(
    (i): i is Extract<Instrument, { kind: 'current-probe' }> => i.kind === 'current-probe'
  )

  // Map ref → current-probe for quick lookup
  const currentProbeByRef = new Map<string, Extract<Instrument, { kind: 'current-probe' }>>()
  for (const cp of currentProbes) {
    currentProbeByRef.set(cp.ref, cp)
  }

  // Map ref → Resolution for lookup
  const resolutionByRef = new Map<string, Resolution>()
  for (const res of resolutions) {
    resolutionByRef.set(res.ref, res)
  }

  // ── Instrument elements ────────────────────────────────────────────────────
  for (const inst of instruments) {
    if (inst.kind === 'ground-ref') continue  // ground is implicit (node "0")
    if (inst.kind === 'voltage-probe') continue  // no element needed; node voltages are saved
    if (inst.kind === 'current-probe') continue  // handled separately below

    // ── potentiometer: emit 1 (rheostat) or 2 (divider) resistors ────────────
    // Pots carry their own nets (not inst.netId). Resistor names come from the
    // shared potResistorNames() helper; every leg is clamped so it never hits 0Ω
    // (an Rmin clamp keeps ngspice convergent).
    if (inst.kind === 'potentiometer') {
      const names = potResistorNames(inst)
      const nodeFor = (netId: number): string | undefined => {
        const n = netById(circuit, netId)
        return n?.spiceNode
      }
      if (inst.mode === 'rheostat' && 'single' in names) {
        const a = nodeFor(inst.netA)
        const w = nodeFor(inst.netW)
        if (a === undefined || w === undefined) continue
        const ohms = clampPotOhms(inst.totalOhms * inst.wiperPct, inst.totalOhms)
        lines.push(`${names.single} ${a} ${w} ${formatSpiceValue(ohms)}`)
      } else if (inst.mode === 'divider' && 'upper' in names) {
        const hi = nodeFor(inst.netHi)
        const w  = nodeFor(inst.netW)
        const lo = nodeFor(inst.netLo)
        if (hi === undefined || w === undefined || lo === undefined) continue
        // upper leg netHi–netW = totalOhms*(1-wiperPct); lower leg netW–netLo = totalOhms*wiperPct
        const upper = clampPotOhms(inst.totalOhms * (1 - inst.wiperPct), inst.totalOhms)
        const lower = clampPotOhms(inst.totalOhms * inst.wiperPct, inst.totalOhms)
        lines.push(`${names.upper} ${hi} ${w} ${formatSpiceValue(upper)}`)
        lines.push(`${names.lower} ${w} ${lo} ${formatSpiceValue(lower)}`)
      }
      continue
    }

    const net = netById(circuit, inst.netId)
    if (!net) continue  // skip if net not in circuit

    const spiceNet = net.spiceNode

    if (inst.kind === 'dc-supply') {
      const name    = instrumentSpiceName(inst)
      const rName   = name.replace(/^v/, 'r')  // vpsu_1 → rpsu_1
      const synthetic = intNode(name)           // vpsu_1_int
      const volts   = formatSpiceValue(inst.volts)
      const ohms    = formatSpiceValue(inst.seriesOhms)

      // Source-side splice: voltage source from synthetic node to 0,
      // series R from synthetic node to the KiCad net.
      // This way the KiCad net keeps its name (overlay reads from spiceNet).
      lines.push(`${name} ${synthetic} 0 DC ${volts}`)
      lines.push(`${rName} ${synthetic} ${spiceNet} ${ohms}`)
      continue
    }

    if (inst.kind === 'function-gen') {
      const name      = instrumentSpiceName(inst)
      const rName     = name.replace(/^v/, 'r')
      const synthetic = intNode(name)
      const waveVal   = buildWaveSourceValue(inst)
      const ohms      = formatSpiceValue(inst.outputOhms)

      lines.push(`${name} ${synthetic} 0 ${waveVal}`)
      lines.push(`${rName} ${synthetic} ${spiceNet} ${ohms}`)
      continue
    }

    if (inst.kind === 'logic-input') {
      const name      = instrumentSpiceName(inst)
      const rName     = name.replace(/^v/, 'r')
      const synthetic = intNode(name)
      const vHigh     = formatSpiceValue(inst.vHigh)
      const level     = inst.level === 1 ? vHigh : '0'
      // Logic input series resistance (50Ω default, same as function-gen)
      const ohms      = formatSpiceValue(50)

      lines.push(`${name} ${synthetic} 0 DC ${level}`)
      lines.push(`${rName} ${synthetic} ${spiceNet} ${ohms}`)
      continue
    }
  }

  // ── Part elements ──────────────────────────────────────────────────────────
  for (const res of resolutions) {
    const part = circuit.parts.find(p => p.ref === res.ref)
    if (!part) continue

    if (!res.model) {
      lines.push(`* ${res.ref}: unresolved — no model found`)
      continue
    }

    const model = res.model

    if (model.kind === 'stub') {
      if (model.mode === 'open') {
        lines.push(`* ${res.ref}: stubbed open (no connections)`)
      } else if (model.mode === 'short') {
        // Tie all pads together via 1 µΩ resistors
        const nodes: string[] = []
        for (const [, netId] of part.padNet) {
          const node = netIdToNode.get(netId)
          if (node && !nodes.includes(node)) nodes.push(node)
        }
        if (nodes.length >= 2) {
          for (let i = 1; i < nodes.length; i++) {
            const rName = `r_stub_${part.ref.toLowerCase()}_${i}`
            lines.push(`${rName} ${nodes[0]} ${nodes[i]} 1e-06`)
          }
        } else {
          lines.push(`* ${res.ref}: stubbed short (< 2 distinct nodes)`)
        }
      } else {
        // interactive-pins: no SPICE elements (pins are controlled via logic-input instruments)
        lines.push(`* ${res.ref}: stubbed interactive-pins`)
      }
      continue
    }

    if (model.kind === 'primitive') {
      // The card was pre-built during resolution (core/models/resolve.ts)
      // Check if there's an ammeter splice for a current probe on this primitive
      const cp = currentProbeByRef.get(res.ref)
      if (cp) {
        // Top-level primitive: no ammeter needed — the device current vector
        // @<dev>[i] is available natively. Card goes in as-is.
        lines.push(model.card)
        // .save @<dev>[i] is added in the .save section below
      } else {
        lines.push(model.card)
      }
      continue
    }

    if (model.kind === 'subckt') {
      // A tier-3 'subckt'-kind resolution is EITHER a true .subckt (NE555, op-amps,
      // regulators → instantiate with x_<ref>) OR a model-card (LED/diode/BJT/
      // MOSFET → a top-level primitive device referencing a .model). The
      // ResolvedModel doesn't carry that distinction, so when lib texts are
      // available we disambiguate by what the libFile actually defines: a matching
      // `.subckt NAME` → subckt instantiation; a matching `.model NAME` → device.
      const pinMap = model.pinMap
      const libFile = model.libFile
      const subcktDef = haveModelTexts ? getSubcktDef(modelIndex, libFile, model.subcktName) : undefined
      const modelCard =
        haveModelTexts && !subcktDef ? getModelCard(modelIndex, libFile, model.subcktName) : undefined

      // ── model-card path: emit a primitive device + inline its .model ─────────
      if (modelCard) {
        // Device letter from the refdes prefix (D→d, Q→q, M→m …); node order is
        // the pinMap value order (1-based terminal positions, per index.json).
        // model-card devices are top-level primitives → @<dev>[i] is native, so a
        // current probe needs no ammeter splice (the .save section handles it).
        const deviceLetter = PRIMITIVE_PREFIX_TO_LETTER[refdesPrefix(part.ref)] ?? 'x'
        const nodes = buildPositionalNodeList(part, netIdToNode, pinMap)
        const devName = `${deviceLetter}_${part.ref.toLowerCase()}`

        // LED glow data source: splice a 0 V series ammeter on the LED's anode
        // (node[0] of the diode card). A diode's own `@d_<ref>[i]` vector carries
        // NO data on ngspice 46, so the ammeter's branch current is the robust,
        // op+transient-uniform glow source (see ledSenseName). Non-LED diodes
        // (rectifiers) and other model-card devices are emitted unchanged.
        const isLed = isLedPart({
          ref: part.ref,
          value: part.value,
          libId: part.libId,
          subcktName: model.subcktName,
        })
        if (isLed && nodes.length >= 2) {
          const senseName = ledSenseName(part.ref)
          const origAnode = nodes[0]
          const internalAnode = `${origAnode}__ledsense_${part.ref.toLowerCase()}`
          // vsense_<ref> origAnode internalAnode DC 0  (ideal 0 V ammeter)
          lines.push(`${senseName} ${origAnode} ${internalAnode} DC 0`)
          // diode now drives from the internal node: d_<ref> internalAnode cathode model
          const spliced = [internalAnode, ...nodes.slice(1)]
          lines.push(`${devName} ${spliced.join(' ')} ${model.subcktName}`)
        } else {
          lines.push(`${devName} ${nodes.join(' ')} ${model.subcktName}`)
        }
        queueDef(`model:${libFile}:${model.subcktName.toLowerCase()}`, [modelCard])
        continue
      }

      // ── subckt path: x_<ref> <nodes-in-terminal-order> <subcktName> ──────────
      // Check for current probe on this subckt (needs ammeter splice)
      const cp = currentProbeByRef.get(res.ref)

      if (cp) {
        // Subckt current probe: insert vamm_<id> 0V ammeter at the designated pad.
        // The ammeter goes in series with the pad's net connection.
        const probeId = cp.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
        const ammName = `vamm_${probeId}`

        // Find which pad to splice
        const splicePad = cp.pad
        const netIdToSplice = splicePad ? part.padNet.get(splicePad) : undefined
        const spliceNode = netIdToSplice !== undefined ? netIdToNode.get(netIdToSplice) : undefined

        if (spliceNode) {
          // Create an internal node for the splice
          const spliceIntNode = `${ammName}_n`
          lines.push(`${ammName} ${spliceIntNode} ${spliceNode} DC 0`)

          // Build node list using the splice for the designated pad
          const nodeList = buildSubcktNodeList(part, netIdToNode, pinMap, splicePad, spliceIntNode, subcktDef)
          const xName = `x_${part.ref.toLowerCase()}`
          lines.push(`${xName} ${nodeList} ${model.subcktName}`)
        } else {
          // Can't identify splice pad — emit without ammeter
          lines.push(`* WARNING: current probe on ${res.ref} pad ${cp.pad ?? '?'} — node not found, ammeter not inserted`)
          const nodeList = buildSubcktNodeListPlain(part, netIdToNode, pinMap, subcktDef)
          const xName = `x_${part.ref.toLowerCase()}`
          lines.push(`${xName} ${nodeList} ${model.subcktName}`)
        }
      } else {
        const nodeList = buildSubcktNodeListPlain(part, netIdToNode, pinMap, subcktDef)
        const xName = `x_${part.ref.toLowerCase()}`
        lines.push(`${xName} ${nodeList} ${model.subcktName}`)
      }
      // Inline the .subckt definition once (if we have it).
      if (subcktDef) {
        queueDef(`subckt:${libFile}:${model.subcktName.toLowerCase()}`, subcktDef.lines)
      }
      continue
    }

    if (model.kind === 'xspice-digital') {
      // The digital template lives in a logic74hc-style JSON. Find its file from
      // the resolution if present; otherwise default to logic74hc.json (the only
      // digital template file in the bundled library).
      const templateFile = haveModelTexts
        ? (modelIndex.texts['logic74hc.json'] ? 'logic74hc.json' : findDigitalTemplateFile(modelIndex, model.templateId))
        : undefined
      const xspiceLines = expandXspiceDigital(res.ref, model, part, netIdToNode, modelIndex, templateFile)
      lines.push(...xspiceLines)
      continue
    }
  }

  // ── Inlined model definitions (subckts + model cards) ──────────────────────
  // Emitted after the element instances and before .save. Deduplicated above.
  if (modelDefLines.length > 0) {
    lines.push('* ── model definitions (inlined from the bundled library) ──')
    lines.push(...modelDefLines)
  }

  // ── .save section ─────────────────────────────────────────────────────────
  lines.push('.save all')

  // Targeted current-probe saves for top-level primitives
  for (const cp of currentProbes) {
    const res = resolutionByRef.get(cp.ref)
    if (res && isPrimitive(res)) {
      // The device name in the deck comes from the resolution card's first token
      const card = (res.model as { kind: 'primitive'; card: string }).card
      const devName = card.split(/\s+/)[0]
      lines.push(`.save @${devName}[i]`)
    }
    // Subckt current probes: save the vamm_ ammeter current
    if (res && isSubckt(res)) {
      const probeId = cp.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
      const ammName = `vamm_${probeId}`
      lines.push(`.save @${ammName}[i]`)
    }
  }

  // LED operating-point glow: save each LED's 0 V series-ammeter branch current
  // so the viewport can drive emissive intensity from the real LED current. The
  // diode's own `@d_<ref>[i]` vector carries NO data on ngspice 46 (saving it
  // would also kill the live transient stream), so the glow source is the
  // ammeter branch current. The OP path already captures source-branch currents,
  // so this `.save` is what guarantees the SAME source streams in transient too.
  // LED-only + deduplicated against anything already saved.
  const savedVecs = new Set(
    lines.filter(l => l.startsWith('.save ')).map(l => l.slice('.save '.length)),
  )
  for (const [, senseName] of buildLedSpiceNames(resolutions, circuit)) {
    const vec = `i(${senseName})`
    if (savedVecs.has(vec)) continue
    savedVecs.add(vec)
    lines.push(`.save ${vec}`)
  }

  lines.push('.end')

  return lines
}

// ─── Subckt node list builders ────────────────────────────────────────────────

/**
 * Build the positional node list for a part whose pinMap VALUES are 1-based
 * terminal positions (model-card primitives — diode/BJT/MOSFET; e.g. LED pinMap
 * {1:"2", 2:"1"} → cathode then anode is corrected by sorting on the position).
 * Sorted by the numeric pinMap value (terminal position), then alpha.
 */
function buildPositionalNodeList(
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  pinMap: Record<string, string>,
): string[] {
  const padEntries = Object.entries(pinMap)
  padEntries.sort(([, a], [, b]) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return a.localeCompare(b)
  })
  const nodes: string[] = []
  for (const [padNum] of padEntries) {
    const netId = part.padNet.get(padNum)
    if (netId !== undefined) nodes.push(netIdToNode.get(netId) ?? '0')
  }
  return nodes
}

/**
 * Build the node list for a subckt instantiation.
 *
 * When the subckt DEFINITION is known (parsed from the lib text), we wire nodes
 * in the subckt's DECLARED terminal order: for each terminal, find the pad whose
 * pinMap value names that terminal (by name, e.g. "gnd"/"trig"/…, OR by 1-based
 * position, e.g. "1"/"2"/… matching the terminal's index) and use that pad's net.
 * This is correct regardless of whether the pinMap values are terminal NAMES
 * (NE555 Sim.Pins) or positions, and fixes the prior bug where named terminals
 * were sorted alphabetically (wrong node order into the subckt).
 *
 * When the definition is NOT available (no modelTexts — the golden-deck tests),
 * fall back to the legacy behaviour: sort pad entries by pinMap value (numeric
 * then alpha). This keeps primitives-only / no-library decks byte-for-byte
 * unchanged.
 */
function buildSubcktNodeListPlain(
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  pinMap: Record<string, string>,
  subcktDef?: SubcktDef,
): string {
  if (subcktDef) {
    return orderNodesByTerminals(part, netIdToNode, pinMap, subcktDef.terminals, undefined, undefined).join(' ')
  }
  // Legacy fallback (no definition known).
  const padEntries = Object.entries(pinMap)
  padEntries.sort(([, a], [, b]) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return a.localeCompare(b)
  })
  const nodes: string[] = []
  for (const [padNum] of padEntries) {
    const netId = part.padNet.get(padNum)
    if (netId !== undefined) nodes.push(netIdToNode.get(netId) ?? '0')
  }
  return nodes.join(' ')
}

/**
 * Same as buildSubcktNodeListPlain but substitutes spliceIntNode for the
 * designated splicePad (ammeter insertion).
 */
function buildSubcktNodeList(
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  pinMap: Record<string, string>,
  splicePad: string | undefined,
  spliceIntNode: string,
  subcktDef?: SubcktDef,
): string {
  if (subcktDef) {
    return orderNodesByTerminals(part, netIdToNode, pinMap, subcktDef.terminals, splicePad, spliceIntNode).join(' ')
  }
  const padEntries = Object.entries(pinMap)
  padEntries.sort(([, a], [, b]) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return a.localeCompare(b)
  })
  const nodes: string[] = []
  for (const [padNum] of padEntries) {
    if (padNum === splicePad) {
      nodes.push(spliceIntNode)
    } else {
      const netId = part.padNet.get(padNum)
      if (netId !== undefined) nodes.push(netIdToNode.get(netId) ?? '0')
    }
  }
  return nodes.join(' ')
}

/**
 * Order the subckt's argument nodes to match its DECLARED terminal list.
 * For each terminal (in declared order) find the pad whose pinMap value names it
 * (by lowercased name, or by 1-based position index), then resolve that pad's
 * board net spiceNode. When `splicePad` matches the chosen pad, substitute
 * `spliceIntNode` (the ammeter splice). Terminals with no mapped pad fall back to
 * ground "0" (a defensive default — the resolution warnings already flag gaps).
 */
function orderNodesByTerminals(
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  pinMap: Record<string, string>,
  terminals: string[],
  splicePad: string | undefined,
  spliceIntNode: string | undefined,
): string[] {
  // Build terminal → pad lookups: by name (lowercased value) and by position.
  const padByTerminalName = new Map<string, string>()
  const padByTerminalPos = new Map<number, string>()
  for (const [pad, value] of Object.entries(pinMap)) {
    const v = value.trim()
    padByTerminalName.set(v.toLowerCase(), pad)
    const pos = parseInt(v, 10)
    if (!isNaN(pos)) padByTerminalPos.set(pos, pad)
  }

  const nodes: string[] = []
  for (let i = 0; i < terminals.length; i++) {
    const term = terminals[i]
    // Match by terminal NAME first, then by 1-based position.
    const pad = padByTerminalName.get(term) ?? padByTerminalPos.get(i + 1)
    if (pad !== undefined && pad === splicePad && spliceIntNode !== undefined) {
      nodes.push(spliceIntNode)
      continue
    }
    if (pad !== undefined) {
      const netId = part.padNet.get(pad)
      nodes.push(netId !== undefined ? (netIdToNode.get(netId) ?? '0') : '0')
    } else {
      nodes.push('0')
    }
  }
  return nodes
}

/**
 * Find the logic74hc-style template file that contains a given templateId. Used
 * when the digital template file is not the default logic74hc.json (defensive;
 * the bundled library only ships logic74hc.json today).
 */
function findDigitalTemplateFile(idx: ModelTextIndex, templateId: string): string | undefined {
  for (const [file, text] of Object.entries(idx.texts)) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(text) as { templates?: Record<string, unknown> }
      if (parsed.templates && templateId in parsed.templates) return file
    } catch {
      // not a template json
    }
  }
  return undefined
}

// ─── Tier label helper ────────────────────────────────────────────────────────

function tierLabelFor(res: Resolution): string {
  const tierNames: Record<number, string> = {
    1: 'tier 1 (schematic Sim.*)',
    2: 'tier 2 (primitive)',
    3: 'tier 3 (bundled library)',
    4: 'tier 4 (user .lib)',
    5: 'tier 5 (LLM-assist)',
    6: 'tier 6 (stub)',
  }
  return tierNames[res.tier] ?? `tier ${res.tier}`
}

// ─── alterPlan ────────────────────────────────────────────────────────────────

/**
 * Determine whether an instrument parameter change requires a live alter
 * or a full deck reload.
 *
 * Rules (spec §9):
 *   Alter-safe (no reload):
 *     - dc-supply.volts                  → alter @vpsu_<id>[dc] <v>  (but we use the direct form)
 *     - logic-input.level                → alter @vlogic_<id>[dc] <v>
 *     - function-gen freq/amp/offset     → alter @vfgen_<id>[sin] [ <vo> <va> <freq> ]
 *                                          (exact spacing, all params re-sent together)
 *
 *   Reload-required:
 *     - function-gen.wave type change    → reload
 *     - current-probe add/remove on subckt part → reload
 *
 * @param prevInstrument  The previous state of the instrument
 * @param nextInstrument  The new state of the instrument
 * @param resolutions     Current resolutions (to check primitive vs subckt)
 */
export function alterPlan(
  prevInstrument: Instrument,
  nextInstrument: Instrument,
  resolutions?: Resolution[],
): AlterPlanResult {
  // Instruments of different kind → reload
  if (prevInstrument.kind !== nextInstrument.kind) {
    return { kind: 'reload' }
  }

  const kind = prevInstrument.kind

  // ── dc-supply: volts change → alter ──────────────────────────────────────
  if (kind === 'dc-supply') {
    const prev = prevInstrument as Extract<Instrument, { kind: 'dc-supply' }>
    const next = nextInstrument as Extract<Instrument, { kind: 'dc-supply' }>
    const name = instrumentSpiceName(prev)
    const v = formatSpiceValue(next.volts)
    return {
      kind: 'alter',
      commands: [`alter @${name}[dc] ${v}`],
    }
  }

  // ── logic-input: level change → alter ─────────────────────────────────────
  if (kind === 'logic-input') {
    const prev = prevInstrument as Extract<Instrument, { kind: 'logic-input' }>
    const next = nextInstrument as Extract<Instrument, { kind: 'logic-input' }>
    const name = instrumentSpiceName(prev)
    const v = formatSpiceValue(next.level === 1 ? next.vHigh : 0)
    return {
      kind: 'alter',
      commands: [`alter @${name}[dc] ${v}`],
    }
  }

  // ── function-gen: wave type change → reload ────────────────────────────────
  if (kind === 'function-gen') {
    const prev = prevInstrument as Extract<Instrument, { kind: 'function-gen' }>
    const next = nextInstrument as Extract<Instrument, { kind: 'function-gen' }>

    if (prev.wave !== next.wave) {
      return { kind: 'reload' }
    }

    // freq / amp / offset change → alter via SIN/PULSE vector form
    const name = instrumentSpiceName(prev)
    const vo   = formatSpiceValue(next.offsetV)
    const va   = formatSpiceValue(next.amplitudeV)
    const freq = formatSpiceValue(next.freqHz)

    if (next.wave === 'sine' || next.wave === 'triangle') {
      // SIN vector form: exact spacing required by spec §9
      return {
        kind: 'alter',
        commands: [`alter @${name}[sin] [ ${vo} ${va} ${freq} ]`],
      }
    }

    // Pulse/square: PULSE vector form
    // PULSE params: [lo hi delay rise fall width period]
    const duty   = (next.dutyPct ?? 50) / 100
    const width  = formatSpiceValue(duty / next.freqHz)
    const period = formatSpiceValue(1 / next.freqHz)
    const lo     = formatSpiceValue(next.offsetV - next.amplitudeV)
    const hi     = formatSpiceValue(next.offsetV + next.amplitudeV)

    return {
      kind: 'alter',
      commands: [`alter @${name}[pulse] [ ${lo} ${hi} 0 1e-09 1e-09 ${width} ${period} ]`],
    }
  }

  // ── potentiometer: only wiperPct changed → live-alter the rpot resistor(s) ─
  // Any change to nets / mode / totalOhms changes the deck structure (resistor
  // names or topology) → reload. The emitted alter is the bare-value form
  //   `alter <rpot_name> <ohms>`
  // which parseAlterCommand/buildAlterCommand round-trip into the valid ngspice
  // line `alter <rpot_name> = <ohms>`. Resistor names come from the SAME shared
  // potResistorNames() helper used by generateDeck so they can never drift.
  if (kind === 'potentiometer') {
    const prev = prevInstrument as Extract<Instrument, { kind: 'potentiometer' }>
    const next = nextInstrument as Extract<Instrument, { kind: 'potentiometer' }>

    // mode change → reload (topology + resistor names differ).
    if (prev.mode !== next.mode) return { kind: 'reload' }
    // totalOhms change → reload (clamp ceiling changes; keep it simple & safe).
    if (prev.totalOhms !== next.totalOhms) return { kind: 'reload' }
    // net change → reload (resistor endpoints differ).
    if (prev.mode === 'rheostat' && next.mode === 'rheostat') {
      if (prev.netA !== next.netA || prev.netW !== next.netW) return { kind: 'reload' }
    } else if (prev.mode === 'divider' && next.mode === 'divider') {
      if (prev.netHi !== next.netHi || prev.netW !== next.netW || prev.netLo !== next.netLo) {
        return { kind: 'reload' }
      }
    }

    // Only wiperPct (or nothing) changed → alter the resistor value(s).
    const names = potResistorNames(next)
    if (next.mode === 'rheostat' && 'single' in names) {
      const ohms = clampPotOhms(next.totalOhms * next.wiperPct, next.totalOhms)
      return { kind: 'alter', commands: [`alter ${names.single} ${formatSpiceValue(ohms)}`] }
    }
    if (next.mode === 'divider' && 'upper' in names) {
      const upper = clampPotOhms(next.totalOhms * (1 - next.wiperPct), next.totalOhms)
      const lower = clampPotOhms(next.totalOhms * next.wiperPct, next.totalOhms)
      return {
        kind: 'alter',
        commands: [
          `alter ${names.upper} ${formatSpiceValue(upper)}`,
          `alter ${names.lower} ${formatSpiceValue(lower)}`,
        ],
      }
    }
    return { kind: 'reload' }
  }

  // ── current-probe: any change → check if it involves a subckt part ────────
  if (kind === 'current-probe') {
    const next = nextInstrument as Extract<Instrument, { kind: 'current-probe' }>
    if (resolutions) {
      const res = resolutions.find(r => r.ref === next.ref)
      if (res && isSubckt(res)) {
        return { kind: 'reload' }
      }
    }
    // Primitive current probe change: no reload needed (just .save update)
    return { kind: 'reload' }  // conservative: always reload when probes change
  }

  // ── voltage-probe: no deck change ─────────────────────────────────────────
  if (kind === 'voltage-probe') {
    return { kind: 'alter', commands: [] }
  }

  // Default: reload for anything unknown
  return { kind: 'reload' }
}
