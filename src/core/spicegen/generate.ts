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
   * expands xspice-digital templates from the matching family JSON
   * (logic74hc.json / logic4000.json) — ngspice loads decks from memory, so
   * definitions are inlined, NEVER `.include`d by path. When OMITTED the
   * generator emits primitives + subckt instantiations only (the existing
   * golden-deck behaviour is unchanged).
   *
   * The lookup key is the resolution's `model.libFile` (subckt/model-card) or
   * the digital family file that contains the template id.
   */
  modelTexts?: Record<string, string>
  /** OPTIONAL manual per-net rail voltage overrides (netId → volts). Tier 2. */
  railOverrides?: Map<number, number>
  /** OPTIONAL op-measured per-net rail voltages (netId → volts). Tier 3. */
  measuredRailVHigh?: Map<number, number>
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
  /** M12 cache: `${file}::${lowercased name}` → terminal-index groups (null = no definition). */
  terminalGroups: Map<string, number[][] | null>
  texts: Record<string, string>
}

function makeModelTextIndex(texts: Record<string, string> | undefined): ModelTextIndex {
  return {
    subcktsByFile: new Map(),
    modelsByFile: new Map(),
    terminalGroups: new Map(),
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

/**
 * Subckt names instantiated inside a subckt body. Every `x…` card names the
 * subckt it calls as the last token before an optional `params:` tail
 * (`xa inp inn out vcc vee opamp_core`, `xr vin gnd vout reg_lin params: …`).
 * Used to transitively inline a subckt's helper subckts (opamp_core inside the
 * op-amps/comparators, reg_lin inside the 78xx/AMS1117 regulators) — without
 * this, inlining only the top-level block leaves ngspice with "unknown subckt".
 */
function extractSubcktRefs(lines: string[]): string[] {
  const refs: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!/^x/i.test(t)) continue
    const toks = t.split(/\s+/)
    const pIdx = toks.findIndex((tok) => /^params:$/i.test(tok))
    const nameTok = pIdx > 0 ? toks[pIdx - 1] : toks[toks.length - 1]
    if (nameTok) refs.push(nameTok)
  }
  return refs
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

/**
 * SPICE element letter derived from a `.model NAME TYPE(...)` card's TYPE token.
 *
 * The model card authoritatively declares the device kind, so it is the primary
 * source for the element letter — the refdes prefix is only a fallback. This
 * matters when the refdes convention doesn't imply the type: a zener "DZ1" isn't
 * in the prefix map, and worse, a VDMOS on a "Q" refdes (a common MOSFET
 * convention) would otherwise emit a BJT `q` card for a VDMOS model. Returns
 * undefined for an unrecognized type (caller falls back to the refdes map).
 */
function modelCardDeviceLetter(card: string): string | undefined {
  const m = card.match(/\.model\s+\S+\s+([A-Za-z]+)/i)
  if (!m) return undefined
  switch (m[1].toUpperCase()) {
    case 'D':
      return 'd'
    case 'NPN':
    case 'PNP':
    case 'LPNP':
      return 'q'
    case 'VDMOS':
    case 'NMOS':
    case 'PMOS':
      return 'm'
    case 'NJF':
    case 'PJF':
      return 'j'
    default:
      return undefined
  }
}

/** True when the model card declares a VDMOS device (needs a 4th bulk terminal). */
function isVdmosCard(card: string): boolean {
  return /\.model\s+\S+\s+VDMOS\b/i.test(card)
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
  const hay = `${args.value ?? ''} ${args.libId ?? ''} ${args.subcktName ?? ''}`.toUpperCase()
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

// ─── Floating-island detection (M8) ──────────────────────────────────────────

/**
 * Union-find over the analog nodes of the FINAL emitted element cards.
 *
 * A connected component that never reaches node "0" is a floating island: it
 * contributes a structurally singular block to the MNA matrix (validated on the
 * real lantern board, where two dangling resistors stranded by open connector
 * stubs abort every fresh `tran … uic` on the first step). generateDeck links
 * each element card's analog nodes as it emits the card, then bleeds every
 * island net to ground with 1 GΩ — strictly additive, so fully grounded decks
 * are byte-identical to before.
 */
class NodeUnionFind {
  /** parent map; insertion order is first-seen order (drives deterministic output). */
  private readonly parent = new Map<string, string>()

  private find(n: string): string {
    let root = n
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // Path compression.
    let cur = n
    while (cur !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  /**
   * Root of a node IF it was ever registered, else undefined. Used by the M12
   * terminal-conductivity analysis to group a subckt's declared terminals by
   * internal connected component (an unregistered terminal is sense-only).
   */
  rootOf(n: string): string | undefined {
    return this.parent.has(n) ? this.find(n) : undefined
  }

  /** Register a card's analog nodes and union them into one component. */
  link(nodes: string[]): void {
    const clean = nodes.filter(n => n.length > 0)
    for (const n of clean) {
      if (!this.parent.has(n)) this.parent.set(n, n)
    }
    for (let i = 1; i < clean.length; i++) {
      const a = this.find(clean[0])
      const b = this.find(clean[i])
      if (a !== b) this.parent.set(b, a)
    }
  }

  /**
   * Every connected component with no path to node "0", as ordered node lists.
   * Component order and in-component node order follow first registration, so
   * the emitted bleed cards are deterministic.
   */
  floatingIslands(): string[][] {
    const byRoot = new Map<string, string[]>()
    for (const node of this.parent.keys()) {
      const root = this.find(node)
      const group = byRoot.get(root)
      if (group) group.push(node)
      else byRoot.set(root, [node])
    }
    const groundRoot = this.parent.has('0') ? this.find('0') : undefined
    const islands: string[][] = []
    for (const [root, nodes] of byRoot) {
      if (root !== groundRoot) islands.push(nodes)
    }
    return islands
  }
}

/**
 * Analog node GROUPS of a pre-built primitive card, keyed by the element
 * letter. Each group is unioned internally by the caller; separate groups stay
 * separate. resolve.ts emits primitive cards as
 * `<name> <one node per pad> <value…>` (buildNodeList — never a synthetic bulk
 * terminal, and the value/model tail may span several tokens, e.g.
 * `PULSE(0 5 …)` or `<model> l=…`), so the node counts are sized to the shapes
 * those cards actually carry — NOT to the SPICE maximum — or a trailing model
 * name would be swallowed as a phantom node:
 *
 *   r/c/l/v/i/d → 2 nodes; q/j/m → 3 nodes (discrete transistor footprints;
 *   the 4-terminal bulk-tied m cards come from generateDeck's model-card path,
 *   which registers its exact nodes at emission and never routes through here).
 *
 * Controlled sources: an E/G output pair (tokens 1-2) is tied by the source
 * branch and unions as one group; the sense pair (tokens 3-4) carries NO
 * conductance, so each sense node is its own SINGLETON group — registered (a
 * net attached only to a sense terminal genuinely floats and must be bled,
 * exactly like an adc_bridge input) but never unioned into a fake ground path.
 * F/H name a controlling SOURCE (not a node) in token 3. Unknown letters
 * contribute nothing (conservative: an unregistered node can only gain a
 * harmless extra bleed elsewhere, never lose one it needs).
 */
function primitiveCardNodeGroups(card: string): string[][] {
  const toks = card.trim().split(/\s+/)
  if (toks.length < 3) return []
  const letter = toks[0].charAt(0).toLowerCase()
  const take = (n: number): string[] => toks.slice(1, 1 + Math.min(n, toks.length - 2))
  switch (letter) {
    case 'r':
    case 'c':
    case 'l':
    case 'v':
    case 'i':
    case 'd':
      return [take(2)]
    case 'q':
    case 'j':
    case 'm':
      return [take(3)]
    case 'e':
    case 'g': {
      const nodes = take(4)
      const groups: string[][] = [nodes.slice(0, 2)]
      for (const sense of nodes.slice(2)) groups.push([sense])
      return groups
    }
    case 'f':
    case 'h':
      return [take(2)]
    default:
      return []
  }
}

// ─── M12: per-subckt terminal conductivity ────────────────────────────────────

/**
 * Analog node groups of an element card INSIDE a .subckt body. Extends
 * primitiveCardNodeGroups with the shapes that appear in lib bodies but never
 * in resolve.ts primitive cards:
 *
 *   b — behavioral source (`b<name> n+ n- v=…|i=…`): the two explicit branch
 *       nodes conduct, consistent with how v/i sources are treated. Node
 *       references inside the expression (`v(inp)`, `i(vsense)`) are SENSE
 *       only and are never tokenized as nodes — the fixed slice(1,3) stops
 *       before the expression text, so `v = v(x) - v(y)` contributes nothing.
 *       KNOWN APPROXIMATION: a constant-current b-card (`i = 2u`, e.g.
 *       regulators.lib biq/bref) is an ideal current source, not true
 *       conductance, yet its branch pair unions like every other b-card.
 *       Safe direction only (merging can at most suppress a bleed the pre-M12
 *       blanket union also suppressed); pinned by the regulators.lib tests.
 *
 *   unknown letters — conservative: treat the first two node tokens as a
 *       conductive pair. Merging too much can only suppress a bleed the same
 *       way the pre-M12 blanket union did; it never strands a real path.
 *
 * `x` cards are handled by the caller (child terminal-group substitution).
 */
function subcktBodyCardGroups(card: string): string[][] {
  const toks = card.trim().split(/\s+/)
  if (toks.length < 3) return []
  const letter = toks[0].charAt(0).toLowerCase()
  if (letter === 'b') return [toks.slice(1, 3)]
  if ('rclvidqjmegfh'.includes(letter)) return primitiveCardNodeGroups(card)
  // Unknown element letter inside a lib body: conservative two-node pair.
  return [toks.slice(1, 3)]
}

/**
 * Which DECLARED terminals of a subckt are conductively connected to EACH
 * OTHER through the subckt's internals. Returns groups of terminal indices
 * (every terminal appears in exactly one group; a sense-only terminal — e.g. a
 * comparator input that exists only inside a behavioral-source expression — is
 * a singleton, exactly like an E/G sense node). Undefined when the definition
 * is missing from the file (caller falls back to the pre-M12 blanket union).
 *
 * The body is walked with subcktBodyCardGroups; nested `x` instances are
 * processed bottom-up by substituting the CHILD subckt's already-computed
 * groups at the parent nodes passed in those terminal positions (cycle-safe
 * via `visiting`: a recursive reference degrades to a blanket union of that
 * one instance's nodes).
 *
 * Internal node "0" is treated as an ordinary internal node, NOT as global
 * ground: a terminal whose only internal path is to ground-referenced
 * behavioral sources (an op-amp output buffer) stays a singleton, which at
 * worst adds a harmless 1 GΩ bleed on an otherwise-driven net — never the
 * reverse. Bleeds therefore remain a SUPERSET of the pre-M12 set, minus
 * nothing (strictly additive refinement).
 */
function terminalGroupsFor(
  idx: ModelTextIndex,
  file: string,
  name: string,
  visiting: Set<string> = new Set(),
): number[][] | undefined {
  const key = `${file}::${name.toLowerCase()}`
  const cached = idx.terminalGroups.get(key)
  if (cached !== undefined) return cached ?? undefined
  if (visiting.has(key)) return undefined // cycle — no info for this instance
  const def = getSubcktDef(idx, file, name)
  if (!def) {
    idx.terminalGroups.set(key, null)
    return undefined
  }
  visiting.add(key)
  const uf = new NodeUnionFind()
  for (const raw of def.lines.slice(1)) {
    const t = raw.trim()
    if (t.length === 0 || t.startsWith('*') || t.startsWith('.')) continue
    if (t.charAt(0).toLowerCase() === 'x') {
      const toks = t.split(/\s+/)
      const pIdx = toks.findIndex((tok) => /^params:$/i.test(tok))
      const nameTok = pIdx > 0 ? toks[pIdx - 1] : toks[toks.length - 1]
      const childDef = nameTok ? getSubcktDef(idx, file, nameTok) : undefined
      if (childDef) {
        const nodeToks = toks.slice(1, 1 + childDef.terminals.length).map((n) => n.toLowerCase())
        const childGroups = terminalGroupsFor(idx, file, nameTok, visiting)
        if (childGroups) {
          // Substitute the child's terminal conductivity: union the parent
          // nodes sitting at internally-connected child-terminal positions;
          // a child sense-only terminal registers its parent node alone.
          for (const g of childGroups) {
            uf.link(g.map((i) => nodeToks[i]).filter((n): n is string => n !== undefined))
          }
        } else {
          uf.link(nodeToks) // cycle: conservative blanket for this instance
        }
      } else {
        // Child not defined in this file: blanket over the node tokens
        // (everything between the instance name and the subckt-name token).
        const end = pIdx > 0 ? pIdx - 1 : toks.length - 1
        uf.link(toks.slice(1, end).map((n) => n.toLowerCase()))
      }
      continue
    }
    for (const g of subcktBodyCardGroups(t)) uf.link(g.map((n) => n.toLowerCase()))
  }
  visiting.delete(key)
  // Group the declared terminals by their internal connected component.
  const groups: number[][] = []
  const groupByRoot = new Map<string, number[]>()
  def.terminals.forEach((term, i) => {
    const root = uf.rootOf(term)
    if (root === undefined) {
      groups.push([i]) // never touched by any card → sense-only singleton
      return
    }
    const existing = groupByRoot.get(root)
    if (existing) {
      existing.push(i)
      return
    }
    const g = [i]
    groupByRoot.set(root, g)
    groups.push(g)
  })
  idx.terminalGroups.set(key, groups)
  return groups
}

/**
 * M12, exported for tests: terminal-conductivity groups of a named .subckt in
 * a lib text, as lowercased terminal-NAME groups (group order = declared
 * position of each group's first terminal). Undefined when the subckt is not
 * defined in the text.
 */
export function subcktTerminalConductivity(libText: string, name: string): string[][] | undefined {
  const idx = makeModelTextIndex({ lib: libText })
  const groups = terminalGroupsFor(idx, 'lib', name)
  if (!groups) return undefined
  const def = getSubcktDef(idx, 'lib', name)
  if (!def) return undefined
  return groups.map((g) => g.map((i) => def.terminals[i]))
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
  /** Power-pin SIGNAL names (e.g. VCC/GND); the pinMap marks which pads carry them. */
  power?: { vcc: string; gnd: string }
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
 * M10: derive a digital part's vHigh from the DC bench supply DIRECTLY attached
 * to its VDD pad net, when unambiguously determinable. Returns undefined for
 * every other case (caller falls back to the family vHighDefault, keeping those
 * decks byte-identical to pre-M10 output).
 *
 * Determination rule (conservative, all conditions required):
 *   1. The template names its power signals (power.vcc/power.gnd) and the
 *      pinMap assigns the VDD signal to exactly ONE connected board net.
 *      DIRECT net attachment only — we never trace through components
 *      (a series switch/regulator between supply and VDD means the actual
 *      rail voltage is not the supply voltage).
 *   2. The VSS pad is wired to the ground net (node "0"). vHigh here is
 *      measured supply-minus-0; a lifted or unconnected VSS means the chip's
 *      local swing is NOT supply-to-ground, so we keep the family default.
 *   3. EXACTLY one dc-supply instrument is attached to the VDD net. With two
 *      or more supplies on one net the intended rail is ambiguous (and the
 *      deck's actual net voltage depends on their series resistances), so
 *      rather than picking one arbitrarily we keep the family default.
 *   4. The supply voltage is a positive finite number — a 0 V or negative
 *      rail would produce degenerate adc thresholds / dac swing.
 *
 * In the accepted case the derived vHigh is the supply SETPOINT (inst.volts),
 * NOT the loaded node voltage: with a large seriesOhms the real rail sags under
 * load while the dac_bridge still drives the full setpoint. Accepted as bench
 * semantics (the nominal rail) — strictly better than the family constant.
 */
/**
 * Resolve a digital chip's VDD board net and whether its VSS pad is grounded.
 * Steps 1–2 of the M10 supply rule, shared by deriveSupplyVHigh and
 * deriveMeasuredRailVHigh. Returns vddNetId=undefined if the VDD pads don't all
 * land on one net (or there's no VDD/VSS signal in the template power block).
 */
export function digitalVddNet(
  tpl: Logic74Template,
  pinMap: Record<string, string>,
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
): { vddNetId?: number; vssGrounded: boolean } {
  const vccSig = tpl.power?.vcc?.toUpperCase()
  const gndSig = tpl.power?.gnd?.toUpperCase()
  if (!vccSig || !gndSig) return { vddNetId: undefined, vssGrounded: false }

  let vddNetId: number | undefined
  for (const [pad, sig] of Object.entries(pinMap)) {
    if (sig.toUpperCase() !== vccSig) continue
    const netId = part.padNet.get(pad)
    if (netId === undefined) continue
    if (vddNetId !== undefined && vddNetId !== netId) return { vddNetId: undefined, vssGrounded: false }
    vddNetId = netId
  }

  let vssGrounded = false
  for (const [pad, sig] of Object.entries(pinMap)) {
    if (sig.toUpperCase() !== gndSig) continue
    const netId = part.padNet.get(pad)
    if (netId === undefined) continue
    if (netIdToNode.get(netId) === '0') vssGrounded = true
  }
  return { vddNetId, vssGrounded }
}

function deriveSupplyVHigh(
  tpl: Logic74Template,
  pinMap: Record<string, string>,
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  instruments: Instrument[],
): number | undefined {
  const { vddNetId, vssGrounded } = digitalVddNet(tpl, pinMap, part, netIdToNode)
  if (vddNetId === undefined || !vssGrounded) return undefined

  // (3) Exactly one dc-supply directly on the VDD net.
  const supplies = instruments.filter(
    (i): i is Extract<Instrument, { kind: 'dc-supply' }> =>
      i.kind === 'dc-supply' && i.netId === vddNetId,
  )
  if (supplies.length !== 1) return undefined

  // (4) Positive finite volts only.
  const volts = supplies[0].volts
  if (!Number.isFinite(volts) || volts <= 0) return undefined
  return volts
}

/** Op-measured rail floor: below this, VDD is treated as gated-off (no rail). */
export const RAIL_FLOOR_V = 2
/** Op-measured rail sanity cap: above this the measurement is discarded. */
export const RAIL_SANITY_MAX_V = 30

/**
 * A rail voltage counts as "present" for tier selection only if it is finite and
 * positive. SINGLE definition of "this tier owns the chip", shared by the deck
 * generator's tier chain and the op-sensing tier-1/tier-2 skip — so an invalid
 * override (0 / NaN / negative from a caller) can never make sensing skip a net
 * while the deck generator falls through to the family default.
 */
function saneRailVolts(v: number | undefined): number | undefined {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined
}

/**
 * Tier-3 rail sensing: from a first-pass operating-point solve, derive the DC
 * voltage on each digital chip's VDD net when NO direct bench supply and NO
 * manual override already own it (tiers 1/2). A rail measuring below
 * RAIL_FLOOR_V is reported as gated-off (kept out of `rails`, surfaced in
 * `gatedOff`); one above RAIL_SANITY_MAX_V is discarded silently.
 *
 * Reuses digitalVddNet + deriveSupplyVHigh (tier-1 skip) and the same
 * makeModelTextIndex/findDigitalTemplateFile/parseLogic74 path generateDeck
 * uses, so a chip's VDD resolution is identical to deck generation.
 */
export function deriveMeasuredRailVHigh(opts: {
  opValues: Record<string, number>
  circuit: Circuit
  resolutions: Resolution[]
  instruments: Instrument[]
  groundNetId: number
  railOverrides?: Map<number, number>
  modelTexts?: Record<string, string>
}): { rails: Map<number, number>; gatedOff: Array<{ ref: string; netId: number; kicadName: string }> } {
  const { opValues, circuit, resolutions, instruments, railOverrides, modelTexts } = opts
  const rails = new Map<number, number>()
  const gatedOff: Array<{ ref: string; netId: number; kicadName: string }> = []
  const haveModelTexts = modelTexts !== undefined && Object.keys(modelTexts).length > 0
  if (!haveModelTexts) return { rails, gatedOff }
  const idx = makeModelTextIndex(modelTexts) // same index builder generateDeck uses

  const netIdToNode = buildNetIdToNode(circuit)
  const netById = new Map(circuit.nets.map((n) => [n.id, n]))
  const partByRef = new Map(circuit.parts.map((p) => [p.ref, p]))

  for (const res of resolutions) {
    const model = res.model
    if (!model || model.kind !== 'xspice-digital') continue
    const part = partByRef.get(res.ref)
    if (!part) continue
    const templateFile = findDigitalTemplateFile(idx, model.templateId)
    const logic = templateFile ? parseLogic74(idx, templateFile) : null
    const tpl = logic?.templates?.[model.templateId]
    if (!logic || !tpl) continue

    const { vddNetId, vssGrounded } = digitalVddNet(tpl, model.pinMap, part, netIdToNode)
    if (vddNetId === undefined || !vssGrounded) continue
    // tier 1 / tier 2 own this chip → don't sense. Use the SAME saneRailVolts
    // gate the deck generator uses, so an invalid override never makes sensing
    // skip a net that the generator would then drop to the family default.
    if (deriveSupplyVHigh(tpl, model.pinMap, part, netIdToNode, instruments) !== undefined) continue
    if (saneRailVolts(railOverrides?.get(vddNetId)) !== undefined) continue

    const node = netIdToNode.get(vddNetId)
    const v = node !== undefined ? opValues[node] : undefined
    if (v === undefined || !Number.isFinite(v)) continue
    const kicadName = netById.get(vddNetId)?.kicadName ?? String(vddNetId)
    if (v < RAIL_FLOOR_V) { gatedOff.push({ ref: res.ref, netId: vddNetId, kicadName }); continue }
    if (v > RAIL_SANITY_MAX_V) continue
    rails.set(vddNetId, v)
  }
  return { rails, gatedOff }
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
 * connects to the real board nets. adc/dac rails come from the DC bench supply
 * directly attached to the part's VDD pad net when unambiguously determinable
 * (M10, see deriveSupplyVHigh), else from the family vHighDefault.
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
 * @param instruments bench instruments (for the M10 VDD-supply vHigh derivation)
 */
function expandXspiceDigital(
  ref: string,
  model: { kind: 'xspice-digital'; templateId: string; pinMap: Record<string, string> },
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  idx: ModelTextIndex,
  templateFile: string | undefined,
  instruments: Instrument[],
  railOverrides: Map<number, number> | undefined,
  measuredRailVHigh: Map<number, number> | undefined,
): { lines: string[]; expanded: boolean; analogNodes: string[] } {
  const logic = templateFile ? parseLogic74(idx, templateFile) : null
  const tpl = logic?.templates?.[model.templateId]
  if (!logic || !tpl) {
    // No template text available — keep the historic placeholder (golden tests).
    return {
      lines: [
        `* xspice-digital template: ${ref} (${model.templateId})`,
        `* adc_bridge/gates/dac_bridge expansion — template text unavailable`,
      ],
      expanded: false,
      analogNodes: [],
    }
  }

  // Rail precedence (4-tier): direct DC supply › manual override › op-measured
  // rail › family default. Tiers 1/2/4 are known at deck-gen; tier 3's measured
  // rail is supplied by the caller (op-informed second pass). A tier only wins
  // if its value is finite and > 0. Undetermined cases keep the family default —
  // byte-identical decks.
  const { vddNetId } = digitalVddNet(tpl, model.pinMap, part, netIdToNode)
  const directVHigh = deriveSupplyVHigh(tpl, model.pinMap, part, netIdToNode, instruments) // tier 1
  const overrideVHigh = vddNetId !== undefined ? railOverrides?.get(vddNetId) : undefined   // tier 2
  const measuredVHigh = vddNetId !== undefined ? measuredRailVHigh?.get(vddNetId) : undefined // tier 3
  const railSource =
    saneRailVolts(directVHigh) !== undefined ? 'dc-supply on VDD net'
    : saneRailVolts(overrideVHigh) !== undefined ? 'user rail override'
    : saneRailVolts(measuredVHigh) !== undefined ? 'op-measured rail'
    : null
  const vHigh =
    saneRailVolts(directVHigh) ?? saneRailVolts(overrideVHigh) ?? saneRailVolts(measuredVHigh) ?? logic.family.vHighDefault
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
  if (railSource) {
    // Provenance: saved decks say where a non-default rail came from.
    lines.push(
      `* ${ref} vhigh: ${formatSpiceValue(vHigh)} (${railSource}; ` +
        `family default ${formatSpiceValue(logic.family.vHighDefault)})`,
    )
  }

  const adc = tpl.schmitt ? logic.family.schmittAdc : logic.family.adc
  const inLow = (adc.inLowFrac * vHigh).toFixed(4)
  const inHigh = (adc.inHighFrac * vHigh).toFixed(4)

  // Schmitt-trigger inverters: expand each gate to a self-referential behavioral
  // B-source that encodes TRUE hysteresis (state retention) instead of the
  // adc_bridge → d_inverter → dac_bridge chain. The adc_bridge has no memory —
  // between its thresholds it emits UNKNOWN (mid-rail), so an RC Schmitt astable
  // would park at mid-rail instead of oscillating. Here the flip state lives in
  // the OUTPUT node voltage: while the output is HIGH (v(out) > mid), the input
  // must rise past V_T+ (inHigh) to flip the output LOW; while the output is LOW,
  // the input must fall past V_T- (inLow) to flip it HIGH. This is an inverting
  // Schmitt trigger with real hysteresis, so RC astables self-oscillate. Modeled
  // as zero-delay: the datasheet tpd is negligible against the RC period.
  if (tpl.schmitt) {
    const mid = (vHigh / 2).toFixed(4)
    const analogNodes: string[] = []
    let gi = 0
    for (const g of tpl.gates) {
      gi++
      const inN = aNode(g.in![0])
      const outN = aNode(g.out as string)
      lines.push(
        `b_${refLc}_${gi} ${outN} 0 V = ` +
          `(v(${inN}) > (v(${outN}) > ${mid} ? ${inHigh} : ${inLow})) ? 0 : ${vHigh.toFixed(4)}`,
      )
      // Both the input and output analog nodes are single-node island terminals
      // (matches the old adc-input + dac-output push exactly).
      analogNodes.push(inN, outN)
    }
    return { lines, expanded: true, analogNodes }
  }

  const rd = `${tpl.delaysNs}n`

  // Per-instance adc/dac model cards (names are ref-scoped to avoid collisions
  // when several digital chips share a deck).
  const adcModel = `adcm_${refLc}`
  const dacModel = `dacm_${refLc}`
  lines.push(`.model ${adcModel} adc_bridge(in_low=${inLow} in_high=${inHigh})`)
  lines.push(`.model ${dacModel} dac_bridge(out_low=0 out_high=${vHigh.toFixed(4)})`)

  // Analog terminals of the expansion, for floating-island detection. Each
  // adc/dac bridge card carries exactly ONE analog node (the other bracket is a
  // purely-event digital node, which must never receive a bleed resistor); the
  // bridges do NOT conduct across the chip, so the nodes are reported
  // individually, never unioned with each other.
  const analogNodes: string[] = []

  // One adc_bridge per input signal: analog board node → digital event node.
  for (const sig of tpl.inputs) {
    lines.push(`abr_${refLc}_${sig.toLowerCase()} [${aNode(sig)}] [${dNode(sig)}] ${adcModel}`)
    analogNodes.push(aNode(sig))
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
    analogNodes.push(aNode(sig))
  }

  return { lines, expanded: true, analogNodes }
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

  // Floating-island detection (M8): every emitted element card links its analog
  // nodes here; after all elements are out, any connected component that never
  // reaches node "0" gets a 1 GΩ bleed per net (see NodeUnionFind).
  const islandNodes = new NodeUnionFind()

  // Model-definition inlining (only when lib texts are supplied). Definitions are
  // collected per-deck and deduplicated, then appended once before .save (ngspice
  // loads decks from memory, so we inline — never .include by path). `defKeys`
  // tracks which definitions are already queued so a part type used by several
  // refs contributes its .subckt/.model exactly once.
  const modelIndex = makeModelTextIndex(modelTexts)
  const haveModelTexts = !!modelTexts && Object.keys(modelTexts).length > 0
  const modelDefLines: string[] = []
  const emittedDefKeys = new Set<string>()
  /** True once at least one xspice-digital part was actually expanded (not the placeholder). */
  let anyXspiceExpanded = false
  /** Queue a definition block once, keyed by file:name. */
  const queueDef = (key: string, defLines: string[]): void => {
    if (emittedDefKeys.has(key)) return
    emittedDefKeys.add(key)
    modelDefLines.push(...defLines)
  }

  /**
   * Inline a `.subckt` and every subckt it transitively instantiates, from the
   * same lib text. Cycle-safe: queueDef records the key before we recurse, so a
   * self- or mutually-referencing subckt is queued at most once.
   */
  const queueSubcktWithDeps = (file: string, name: string): void => {
    const def = getSubcktDef(modelIndex, file, name)
    if (!def) return
    const key = `subckt:${file}:${name.toLowerCase()}`
    if (emittedDefKeys.has(key)) return
    queueDef(key, def.lines)
    for (const dep of extractSubcktRefs(def.lines)) queueSubcktWithDeps(file, dep)
  }

  /**
   * M12: register an x-card's outer nodes with the island union-find using the
   * subckt's per-terminal conductivity instead of a blanket union. Sense-only
   * terminals (comparator/op-amp inputs, E/G-style control pins) register as
   * singletons, so a net wired ONLY to such a terminal is correctly detected
   * as a floating island and bled — the blanket union used to weld it to the
   * package's grounded terminals and the singular matrix survived to ngspice.
   * Falls back to the blanket union when the definition (and therefore the
   * analysis) is unavailable — the legacy no-modelTexts path is unchanged.
   */
  const linkSubcktCardNodes = (
    nodes: string[],
    libFile: string,
    subcktName: string,
    subcktDef: SubcktDef | undefined,
  ): void => {
    const groups = subcktDef ? terminalGroupsFor(modelIndex, libFile, subcktName) : undefined
    if (!groups || !subcktDef || nodes.length !== subcktDef.terminals.length) {
      islandNodes.link(nodes)
      return
    }
    for (const g of groups) islandNodes.link(g.map((i) => nodes[i]))
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
        islandNodes.link([a, w])
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
        islandNodes.link([hi, w])
        islandNodes.link([w, lo])
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
      islandNodes.link([synthetic, '0'])
      islandNodes.link([synthetic, spiceNet])
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
      islandNodes.link([synthetic, '0'])
      islandNodes.link([synthetic, spiceNet])
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
      islandNodes.link([synthetic, '0'])
      islandNodes.link([synthetic, spiceNet])
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
            islandNodes.link([nodes[0], nodes[i]])
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
      for (const group of primitiveCardNodeGroups(model.card)) islandNodes.link(group)
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
        // Device letter: the .model card's TYPE is authoritative (D→d, NPN/PNP→q,
        // VDMOS/NMOS/PMOS→m); the refdes prefix is only a fallback. Deriving from
        // the refdes alone mis-emits a VDMOS on a "Q" refdes as a BJT `q` card, and
        // a zener "DZ1" (prefix not in the map) as an invalid `x_` subckt call.
        const deviceLetter =
          modelCardDeviceLetter(modelCard) ?? PRIMITIVE_PREFIX_TO_LETTER[refdesPrefix(part.ref)] ?? 'x'
        const nodes = buildPositionalNodeList(part, netIdToNode, pinMap)
        // VDMOS device lines take 4 terminals (drain gate source bulk); the pinMap
        // supplies D/G/S, so tie bulk to source — the standard discrete-MOSFET
        // connection (matches the library integration harness's `m1 drn g 0 0`).
        if (isVdmosCard(modelCard) && nodes.length === 3) nodes.push(nodes[2])
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
          islandNodes.link([origAnode, internalAnode])
          // diode now drives from the internal node: d_<ref> internalAnode cathode model
          const spliced = [internalAnode, ...nodes.slice(1)]
          lines.push(`${devName} ${spliced.join(' ')} ${model.subcktName}`)
          islandNodes.link(spliced)
        } else {
          lines.push(`${devName} ${nodes.join(' ')} ${model.subcktName}`)
          // Island-detection scope: unioning ALL the device's terminals —
          // including a VDMOS gate, which has no DC conductance to D/S — is
          // deliberate. The bundled VDMOS cards carry gate capacitances
          // (cgdmax/cgs…), and a capacitor counts as a path of ANY kind here
          // (per-net bleeds make capacitively-linked islands DC-safe anyway).
          // A hypothetical zero-cap MOS whose gate net hangs off the rest of
          // its island ONLY through that gate stays out of scope.
          islandNodes.link(nodes)
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
          islandNodes.link([spliceIntNode, spliceNode])

          // Build node list using the splice for the designated pad
          const nodeList = buildSubcktNodeList(part, netIdToNode, pinMap, splicePad, spliceIntNode, subcktDef)
          const xName = `x_${part.ref.toLowerCase()}`
          lines.push(`${xName} ${nodeList} ${model.subcktName}`)
          linkSubcktCardNodes(nodeList.split(' '), libFile, model.subcktName, subcktDef)
        } else {
          // Can't identify splice pad — emit without ammeter
          lines.push(`* WARNING: current probe on ${res.ref} pad ${cp.pad ?? '?'} — node not found, ammeter not inserted`)
          const nodeList = buildSubcktNodeListPlain(part, netIdToNode, pinMap, subcktDef)
          const xName = `x_${part.ref.toLowerCase()}`
          lines.push(`${xName} ${nodeList} ${model.subcktName}`)
          linkSubcktCardNodes(nodeList.split(' '), libFile, model.subcktName, subcktDef)
        }
      } else {
        const nodeList = buildSubcktNodeListPlain(part, netIdToNode, pinMap, subcktDef)
        const xName = `x_${part.ref.toLowerCase()}`
        lines.push(`${xName} ${nodeList} ${model.subcktName}`)
        linkSubcktCardNodes(nodeList.split(' '), libFile, model.subcktName, subcktDef)
      }
      // Inline the .subckt definition once (if we have it), plus every subckt it
      // transitively instantiates (opamp_core inside the op-amps/comparators,
      // reg_lin inside the 78xx/AMS1117 regulators).
      if (subcktDef) {
        queueSubcktWithDeps(libFile, model.subcktName)
      }
      continue
    }

    if (model.kind === 'xspice-digital') {
      // The digital template lives in a logic74hc-style family JSON. The bundled
      // library ships one file per family (logic74hc.json at 5 V, logic4000.json
      // at 12 V) because vHigh is a per-file constant — so pick the file that
      // actually CONTAINS this templateId (never hard-prefer one family file).
      const templateFile = haveModelTexts
        ? findDigitalTemplateFile(modelIndex, model.templateId)
        : undefined
      const xspice = expandXspiceDigital(
        res.ref, model, part, netIdToNode, modelIndex, templateFile, instruments,
        opts.railOverrides, opts.measuredRailVHigh,
      )
      lines.push(...xspice.lines)
      if (xspice.expanded) anyXspiceExpanded = true
      // Register each analog bridge terminal on its own (single-node cards):
      // an adc input has no DC conductance, so a net touched ONLY by bridges is
      // itself a floating island and needs a bleed.
      for (const n of xspice.analogNodes) islandNodes.link([n])
      continue
    }
  }

  // ── Floating-island bleed resistors (M8) ──────────────────────────────────
  // Every connected component of the emitted element cards that has no path of
  // ANY kind to node "0" is a structurally singular block (fresh `tran … uic`
  // aborts on the first step — validated on the real lantern board, where open
  // connector stubs strand two dangling resistors). Bleed EVERY net of each
  // island to ground through 1 GΩ: per-net (not per-island) so capacitively
  // linked islands are also non-singular at DC, and the overlay reads a defined
  // 0 V. Names are index-based (r_float_1 …) NEVER node-derived — the
  // convergence-culprit parser maps `<prefix>_<ref>`-shaped instance names back
  // to parts, and a spice node embedded in the name (r_float__gauge_c3) would
  // false-positive onto a refdes-like net segment (C3).
  {
    const islands = islandNodes.floatingIslands()
    if (islands.length > 0) {
      lines.push('* floating-island bleed resistors (no DC path to ground)')
      let bleedIdx = 0
      for (const island of islands) {
        for (const node of island) {
          bleedIdx++
          lines.push(`r_float_${bleedIdx} ${node} 0 1e9`)
        }
      }
    }
  }

  // ── Mixed-mode DCOP option (only when digital bridges are in the deck) ─────
  // Digital feedback loops (astables, latches, cross-coupled gates) have no
  // consistent DC event fixpoint, so ngspice's DCOP analog/event alternation
  // never terminates and the WHOLE board op fails (verified against real
  // ngspice-46 on a real board's CD40106 RC astable). noopalter takes one
  // event pass instead: the op becomes a defined bias snapshot, and transients
  // still run the full event simulation.
  if (anyXspiceExpanded) {
    lines.push('.options noopalter')
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
 * Find the logic74hc-style family file that contains a given templateId. Each
 * family file carries its own vHigh constant (logic74hc.json = 5 V, logic4000.json
 * = 12 V), so the lookup is by template membership, never by a preferred filename.
 * Uses the per-index parse cache (parseLogic74) so each text parses once.
 */
function findDigitalTemplateFile(idx: ModelTextIndex, templateId: string): string | undefined {
  for (const file of Object.keys(idx.texts)) {
    if (!file.endsWith('.json')) continue
    const parsed = parseLogic74(idx, file)
    if (parsed?.templates && templateId in parsed.templates) return file
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
 *     - netId change on any instrument   → reload (rewiring changes deck
 *                                          topology, not just a value; a live
 *                                          alter cannot move a source's node)
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
    // net change → reload (rewiring the source changes deck topology, not just its value).
    if (prev.netId !== next.netId) return { kind: 'reload' }
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
    // net change → reload (rewiring the source changes deck topology, not just its value).
    if (prev.netId !== next.netId) return { kind: 'reload' }
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

    // net change → reload (rewiring the source changes deck topology, not just its value).
    if (prev.netId !== next.netId) return { kind: 'reload' }

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
    const prev = prevInstrument as Extract<Instrument, { kind: 'voltage-probe' }>
    const next = nextInstrument as Extract<Instrument, { kind: 'voltage-probe' }>
    // net change → reload (rewiring the probe changes what node it observes, not just its color).
    if (prev.netId !== next.netId) return { kind: 'reload' }
    return { kind: 'alter', commands: [] }
  }

  // Default: reload for anything unknown
  return { kind: 'reload' }
}
